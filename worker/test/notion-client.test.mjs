import assert from "node:assert/strict";
import test from "node:test";

import { NotionClient } from "../src/clients.ts";

function notionTaskPage(id, courseId) {
  return {
    id,
    url: `https://notion.so/${id}`,
    last_edited_time: "2026-05-24T10:00:00Z",
    properties: {
      Name: { title: [{ plain_text: `Task ${id}` }] },
      Status: { status: { name: "Not started" } },
      Type: { select: { name: "To-Do" } },
      Priority: { select: { name: "Medium" } },
      Course: { relation: [{ id: courseId }] },
      "Do Date": { date: { start: "2026-05-24" } },
      "Due Date": { date: null },
    },
  };
}

test("Notion client only returns tasks from registered courses", async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/databases/db/query")) {
      return Response.json({
        has_more: false,
        results: [notionTaskPage("registered-task", "registered-course"), notionTaskPage("old-task", "old-course")],
      });
    }
    if (String(url).endsWith("/pages/registered-course")) {
      return Response.json({ properties: { Registered: { checkbox: true } } });
    }
    if (String(url).endsWith("/pages/old-course")) {
      return Response.json({ properties: { Registered: { checkbox: false } } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const client = new NotionClient({
      NOTION_API_KEY: "notion",
      NOTION_VERSION: "2022-06-28",
      DATABASE_ID: "db",
    });
    const tasks = await client.listTasks();

    assert.deepEqual(
      tasks.map((task) => task.pageId),
      ["registered-task"],
    );
    assert(calls.some((url) => url.endsWith("/pages/registered-course")));
    assert(calls.some((url) => url.endsWith("/pages/old-course")));
  } finally {
    globalThis.fetch = oldFetch;
  }
});
