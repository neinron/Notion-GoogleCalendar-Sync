import assert from "node:assert/strict";
import test from "node:test";

import { GoogleCalendarError } from "../src/clients.ts";
import { eventDescription, googleHash, notionHash } from "../src/serialize.ts";
import { SyncEngine } from "../src/sync.ts";

function task(overrides = {}) {
  return {
    pageId: "page1",
    url: "https://notion.so/page1",
    title: "Task",
    status: "not started",
    taskType: "To-Do",
    priority: "High",
    course: "course1",
    dueStart: "2026-05-22",
    doStart: "2026-05-21T10:00:00+02:00",
    doEnd: "2026-05-21T11:00:00+02:00",
    doIsDatetime: true,
    lastEditedTime: "n1",
    raw: {},
    ...overrides,
  };
}

function event(overrides = {}) {
  const pageId = overrides.notionPageId ?? "page1";
  const title = overrides.title ?? "Task";
  return {
    eventId: "event1",
    notionPageId: pageId,
    title,
    description: eventDescription(task({ pageId, title })),
    start: "2026-05-21T10:00:00+02:00",
    end: "2026-05-21T11:00:00+02:00",
    isAllDay: false,
    updated: "g1",
    status: "confirmed",
    raw: {},
    ...overrides,
  };
}

class FakeState {
  constructor(record = null) {
    this.record = record;
    this.conflicts = [];
  }

  async get() {
    return this.record;
  }

  async upsert(notionPageId, data) {
    this.record = {
      notion_page_id: notionPageId,
      google_event_id: data.googleEventId ?? null,
      last_notion_hash: data.lastNotionHash,
      last_google_hash: data.lastGoogleHash,
      last_notion_edited_time: data.lastNotionEditedTime,
      last_google_updated: data.lastGoogleUpdated,
      sync_status: data.syncStatus ?? "synced",
      last_error: data.lastError ?? "",
      updated_at: "now",
    };
  }

  async markConflict(notionPageId, googleEventId, error) {
    this.conflicts.push({ notionPageId, googleEventId, error });
  }
}

class FakeNotion {
  constructor(tasks) {
    this.tasks = tasks;
    this.updated = [];
  }

  async listTasks() {
    return this.tasks;
  }

  async updatePageProperties(pageId, properties) {
    this.updated.push({ pageId, properties });
    return { last_edited_time: "n2" };
  }
}

class FakeGoogle {
  constructor(events, { failUpdate400 = false } = {}) {
    this.events = events;
    this.failUpdate400 = failUpdate400;
    this.created = [];
    this.updated = [];
    this.deleted = [];
  }

  async listEvents() {
    return this.events;
  }

  async createEvent(body) {
    this.created.push(body);
    return event({ eventId: "created", title: body.summary, updated: "g2" });
  }

  async updateEvent(eventId, body) {
    this.updated.push({ eventId, body });
    if (this.failUpdate400) throw new GoogleCalendarError("bad request", 400, '{"error":"invalid end"}');
    return event({ eventId, title: body.summary, updated: "g2" });
  }

  async deleteEvent(eventId) {
    this.deleted.push(eventId);
  }
}

test("simultaneous Notion and Google changes use Notion as source of truth", async () => {
  const oldTask = task();
  const oldEvent = event();
  const newTask = task({ title: "Changed in Notion", lastEditedTime: "n2" });
  const newEvent = event({ title: "Changed in Google", updated: "g2" });
  const state = new FakeState({
    notion_page_id: "page1",
    google_event_id: "event1",
    last_notion_hash: await notionHash(oldTask),
    last_google_hash: await googleHash(oldEvent),
    last_notion_edited_time: "n1",
    last_google_updated: "g1",
    sync_status: "synced",
    last_error: "",
    updated_at: "then",
  });
  const google = new FakeGoogle([newEvent]);
  const result = await new SyncEngine(state, new FakeNotion([newTask]), google).sync();

  assert.equal(result.conflicts, 0);
  assert.equal(result.updated_google, 1);
  assert.equal(google.updated[0].body.summary, "Changed in Notion");
  assert.equal(state.record.sync_status, "synced");
});

test("Google update 400 deletes and recreates the event from Notion", async () => {
  const oldTask = task();
  const oldEvent = event();
  const newTask = task({ title: "Changed in Notion", lastEditedTime: "n2" });
  const state = new FakeState({
    notion_page_id: "page1",
    google_event_id: "event1",
    last_notion_hash: await notionHash(oldTask),
    last_google_hash: await googleHash(oldEvent),
    last_notion_edited_time: "n1",
    last_google_updated: "g1",
    sync_status: "synced",
    last_error: "",
    updated_at: "then",
  });
  const google = new FakeGoogle([event()], { failUpdate400: true });
  const result = await new SyncEngine(state, new FakeNotion([newTask]), google).sync();

  assert.equal(result.updated_google, 1);
  assert.deepEqual(google.deleted, ["event1"]);
  assert.equal(google.created[0].summary, "Changed in Notion");
  assert.equal(state.record.google_event_id, "created");
});
