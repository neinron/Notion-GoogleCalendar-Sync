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
    courseNames: "",
    googleSyncStatus: "",
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
  constructor(record = null, { registeredCourses = new Map([["course1", true]]) } = {}) {
    this.record = record;
    this.conflicts = [];
    this.retryable = [];
    this.settings = new Map();
    this.seen = new Map();
    this.registeredCourses = registeredCourses;
  }

  async get() {
    return this.record;
  }

  async getSetting(key) {
    return this.settings.get(key) ?? "";
  }

  async setSetting(key, value) {
    this.settings.set(key, value);
  }

  async deleteSetting(key) {
    this.settings.delete(key);
  }

  async getCourseRegistration(courseId) {
    if (!this.registeredCourses.has(courseId)) return null;
    return { registered: this.registeredCourses.get(courseId), updatedAt: new Date().toISOString() };
  }

  async upsertCourseRegistration(courseId, registered) {
    this.registeredCourses.set(courseId, registered);
  }

  async markSeen(scanId, notionPageId) {
    this.seen.set(notionPageId, scanId);
  }

  async wasSeenInScan(scanId, notionPageId) {
    return this.seen.get(notionPageId) === scanId;
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

  async markRetryable(notionPageId, googleEventId, error) {
    this.retryable.push({ notionPageId, googleEventId, error });
    this.record = {
      notion_page_id: notionPageId,
      google_event_id: googleEventId ?? null,
      last_notion_hash: "",
      last_google_hash: "",
      last_notion_edited_time: "",
      last_google_updated: "",
      sync_status: "retry_pending",
      last_error: error,
      updated_at: "now",
    };
  }

  async markManualConflict(notionPageId, googleEventId, error) {
    this.conflicts.push({ notionPageId, googleEventId, error });
  }
}

class FakeNotion {
  constructor(tasks, { registeredCourses = new Map() } = {}) {
    this.tasks = tasks;
    this.updated = [];
    this.courseReads = 0;
    this.registeredCourses = registeredCourses;
  }

  async listTasksPage({ startCursor, pageSize = 10 } = {}) {
    const start = startCursor ? Number(startCursor) : 0;
    const page = this.tasks.slice(start, start + pageSize);
    const next = start + page.length;
    return { tasks: page, nextCursor: String(next), hasMore: next < this.tasks.length };
  }

  async courseMetadata(courseId) {
    this.courseReads += 1;
    return {
      registered: this.registeredCourses.get(courseId) ?? true,
      name: `Course ${courseId}`,
    };
  }

  async updatePageProperties(pageId, properties) {
    this.updated.push({ pageId, properties });
    return { last_edited_time: "n2" };
  }

  async setGoogleSyncStatus(pageId, status) {
    return await this.updatePageProperties(pageId, {
      "Synced with Google": { select: { name: status } },
    });
  }
}

class FakeGoogle {
  constructor(events, { failUpdate400 = false, failCreate = null } = {}) {
    this.events = events;
    this.failUpdate400 = failUpdate400;
    this.failCreate = failCreate;
    this.created = [];
    this.updated = [];
    this.deleted = [];
  }

  async listEvents() {
    return this.events;
  }

  async createEvent(body) {
    if (this.failCreate) throw this.failCreate;
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

  assert.equal(result.manual_conflicts, 0);
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

test("existing Google event is deleted when its Notion task belongs to an unregistered course", async () => {
  const state = new FakeState();
  const google = new FakeGoogle([event({ notionPageId: "old-course-task", eventId: "old-event" })]);
  const result = await new SyncEngine(
    state,
    new FakeNotion([task({ pageId: "old-course-task", course: "old-course" })], {
      registeredCourses: new Map([["old-course", false]]),
    }),
    google,
  ).sync();

  assert.equal(result.deleted_google, 1);
  assert.deepEqual(google.deleted, ["old-event"]);
  assert.equal(state.record.sync_status, "unregistered");
});

test("cancelled Google event marks Notion as deleted without clearing Do Date", async () => {
  const state = new FakeState();
  const notion = new FakeNotion([task()]);
  const google = new FakeGoogle([event({ status: "cancelled", updated: "g2" })]);
  const result = await new SyncEngine(state, notion, google).sync();

  assert.equal(result.cleared_notion_dates, 0);
  assert.equal(state.record.sync_status, "google_deleted");
  assert.deepEqual(notion.updated[0], {
    pageId: "page1",
    properties: { "Synced with Google": { select: { name: "deleted" } } },
  });
  assert.equal("Do Date" in notion.updated[0].properties, false);
});

test("retryable runtime errors are not stored as manual conflicts", async () => {
  const state = new FakeState();
  const google = new FakeGoogle([], { failCreate: new Error("Too many subrequests by single Worker invocation") });
  const result = await new SyncEngine(state, new FakeNotion([task()]), google).sync();

  assert.equal(result.retryable_errors, 1);
  assert.equal(result.manual_conflicts, 0);
  assert.equal(state.conflicts.length, 0);
  assert.equal(state.record.sync_status, "retry_pending");
});

test("per-run course registration memory cache prevents repeated Notion course reads", async () => {
  const state = new FakeState(null, { registeredCourses: new Map() });
  const notion = new FakeNotion([task({ pageId: "page1" }), task({ pageId: "page2" })]);
  const result = await new SyncEngine(state, notion, new FakeGoogle([])).sync();

  assert.equal(result.created, 2);
  assert.equal(notion.courseReads, 1);
});

test("Google event description uses course name instead of course id", async () => {
  const state = new FakeState();
  const google = new FakeGoogle([]);
  const result = await new SyncEngine(state, new FakeNotion([task()]), google).sync();

  assert.equal(result.created, 1);
  assert.match(String(google.created[0].description), /Course: Course course1/);
  assert.doesNotMatch(String(google.created[0].description), /Course: course1$/m);
});

test("Notion deleted sync status prevents Google event creation", async () => {
  const state = new FakeState();
  const google = new FakeGoogle([]);
  const result = await new SyncEngine(state, new FakeNotion([task({ googleSyncStatus: "deleted" })]), google).sync();

  assert.equal(result.created, 0);
  assert.equal(google.created.length, 0);
  assert.equal(state.record.sync_status, "google_deleted");
});

test("Notion deleted sync status removes active Google event", async () => {
  const state = new FakeState();
  const google = new FakeGoogle([event()]);
  const result = await new SyncEngine(state, new FakeNotion([task({ googleSyncStatus: "deleted" })]), google).sync();

  assert.equal(result.deleted_google, 1);
  assert.deepEqual(google.deleted, ["event1"]);
  assert.equal(state.record.sync_status, "google_deleted");
});

test("task and cleanup phases continue across small batches", async () => {
  const state = new FakeState();
  const notion = new FakeNotion([task({ pageId: "page1" }), task({ pageId: "page2" })]);
  const google = new FakeGoogle([event({ notionPageId: "missing-page", eventId: "missing-event" })]);

  const first = await new SyncEngine(state, notion, google).sync({ limit: 1, cleanupLimit: 1 });
  assert.equal(first.phase, "tasks");
  assert.equal(first.has_more, true);
  assert.equal(state.settings.get("notion_cursor"), "1");

  const second = await new SyncEngine(state, notion, google).sync({ limit: 1, cleanupLimit: 1 });
  assert.equal(second.phase, "tasks");
  assert.equal(second.has_more, true);
  assert.equal(state.settings.get("sync_phase"), "cleanup");

  const third = await new SyncEngine(state, notion, google).sync({ limit: 1, cleanupLimit: 1 });
  assert.equal(third.phase, "cleanup");
  assert.equal(third.deleted_google, 1);
  assert.deepEqual(google.deleted, ["missing-event"]);
});
