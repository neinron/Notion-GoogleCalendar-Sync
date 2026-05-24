from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from notion_sync.notion_client import NotionClient
from tests.test_sync_engine import cfg


def notion_task_page(page_id: str, course_id: str) -> dict:
    return {
        "id": page_id,
        "url": f"https://notion.so/{page_id}",
        "last_edited_time": "2026-05-24T10:00:00Z",
        "properties": {
            "Name": {"title": [{"plain_text": f"Task {page_id}"}]},
            "Status": {"status": {"name": "Not started"}},
            "Type": {"select": {"name": "To-Do"}},
            "Priority": {"select": {"name": "Medium"}},
            "Course": {"relation": [{"id": course_id}]},
            "Do Date": {"date": {"start": "2026-05-24"}},
            "Due Date": {"date": None},
        },
    }


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self):
        self.headers = {}
        self.get_urls = []

    def post(self, url, json, timeout):
        return FakeResponse(
            {
                "has_more": False,
                "results": [
                    notion_task_page("registered-task", "registered-course"),
                    notion_task_page("old-task", "old-course"),
                ],
            }
        )

    def get(self, url, timeout):
        self.get_urls.append(url)
        if url.endswith("/pages/registered-course"):
            return FakeResponse({"properties": {"Registered": {"checkbox": True}}})
        if url.endswith("/pages/old-course"):
            return FakeResponse({"properties": {"Registered": {"checkbox": False}}})
        raise AssertionError(f"unexpected url {url}")


class NotionClientTests(unittest.TestCase):
    def test_only_registered_course_tasks_are_returned(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = FakeSession()
            client = NotionClient(cfg(Path(tmp)), session=session)

            tasks = client.list_tasks()

            self.assertEqual([task.page_id for task in tasks], ["registered-task"])
            self.assertTrue(any(url.endswith("/pages/registered-course") for url in session.get_urls))
            self.assertTrue(any(url.endswith("/pages/old-course") for url in session.get_urls))


if __name__ == "__main__":
    unittest.main()
