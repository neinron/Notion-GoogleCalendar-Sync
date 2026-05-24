from __future__ import annotations

from typing import Any

import requests

from .config import Config
from .models import NotionTask
from .serialize import parse_notion_task


class NotionClient:
    def __init__(self, config: Config, session: requests.Session | None = None):
        self.config = config
        self.session = session or requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {config.notion_api_key}",
                "Notion-Version": config.notion_version,
                "Content-Type": "application/json",
            }
        )

    def list_tasks(self) -> list[NotionTask]:
        url = f"https://api.notion.com/v1/databases/{self.config.database_id}/query"
        results: list[dict[str, Any]] = []
        cursor = None
        while True:
            payload: dict[str, Any] = {"page_size": 100}
            if cursor:
                payload["start_cursor"] = cursor
            res = self.session.post(url, json=payload, timeout=30)
            res.raise_for_status()
            data = res.json()
            batch = data.get("results", [])
            if not isinstance(batch, list):
                raise RuntimeError("Notion query returned invalid results")
            results.extend(batch)
            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")
            if not cursor:
                raise RuntimeError("Notion query has_more without next_cursor")
        tasks = [parse_notion_task(page) for page in results]
        return self._only_registered_course_tasks(tasks)

    def _only_registered_course_tasks(self, tasks: list[NotionTask]) -> list[NotionTask]:
        course_ids = sorted({course_id for task in tasks for course_id in task.course.split(",") if course_id})
        if not course_ids:
            return []
        registered_course_ids = self._registered_course_ids(course_ids)
        return [task for task in tasks if any(course_id in registered_course_ids for course_id in task.course.split(","))]

    def _registered_course_ids(self, course_ids: list[str]) -> set[str]:
        registered: set[str] = set()
        for course_id in course_ids:
            page = self.retrieve_page(course_id)
            if page.get("properties", {}).get("Registered", {}).get("checkbox") is True:
                registered.add(course_id)
        return registered

    def retrieve_page(self, page_id: str) -> dict[str, Any]:
        res = self.session.get(
            f"https://api.notion.com/v1/pages/{page_id}",
            timeout=30,
        )
        res.raise_for_status()
        return res.json()

    def update_page_properties(self, page_id: str, properties: dict[str, Any]) -> dict[str, Any]:
        res = self.session.patch(
            f"https://api.notion.com/v1/pages/{page_id}",
            json={"properties": properties},
            timeout=30,
        )
        res.raise_for_status()
        return res.json()

    def clear_do_date(self, page_id: str) -> dict[str, Any]:
        return self.update_page_properties(page_id, {"Do Date": {"date": None}})
