import assert from "node:assert/strict";
import test from "node:test";

import { notionTaskToGoogleBody } from "../src/serialize.ts";

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

test("date-only Notion task without end gets next-day Google end", () => {
  const body = notionTaskToGoogleBody(task({ doStart: "2026-05-21", doEnd: "", doIsDatetime: false }));
  assert.deepEqual(body.start, { date: "2026-05-21" });
  assert.deepEqual(body.end, { date: "2026-05-22" });
});

test("datetime Notion task without end gets one-hour Google end preserving offset", () => {
  const body = notionTaskToGoogleBody(task({ doStart: "2026-05-21T10:00:00+02:00", doEnd: "" }));
  assert.deepEqual(body.start, { dateTime: "2026-05-21T10:00:00+02:00" });
  assert.deepEqual(body.end, { dateTime: "2026-05-21T11:00:00+02:00" });
});

test("datetime without explicit timezone gets configured Google timezone", () => {
  const body = notionTaskToGoogleBody(task({ doStart: "2026-05-21T10:00:00", doEnd: "" }), "Europe/Berlin");
  assert.deepEqual(body.start, { dateTime: "2026-05-21T10:00:00", timeZone: "Europe/Berlin" });
  assert.deepEqual(body.end, { dateTime: "2026-05-21T11:00:00", timeZone: "Europe/Berlin" });
});
