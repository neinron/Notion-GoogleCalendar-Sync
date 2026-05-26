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
      "Synced with Google": { select: null },
      "Do Date": { date: { start: "2026-05-24" } },
      "Due Date": { date: null },
    },
  };
}

test("Notion client returns one task page and can read course registration", async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/databases/db/query")) {
      return Response.json({
        has_more: true,
        next_cursor: "next-page",
        results: [notionTaskPage("registered-task", "registered-course")],
      });
    }
    if (String(url).endsWith("/pages/registered-course")) {
      return Response.json({ properties: { Registration: { checkbox: true } } });
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
    const page = await client.listTasksPage({ pageSize: 1 });
    const registered = await client.courseRegistered("registered-course");

    assert.deepEqual(
      page.tasks.map((task) => task.pageId),
      ["registered-task"],
    );
    assert.equal(page.hasMore, true);
    assert.equal(page.nextCursor, "next-page");
    assert.equal(registered, true);
    assert(calls.some((url) => url.endsWith("/pages/registered-course")));
  } finally {
    globalThis.fetch = oldFetch;
  }
});
