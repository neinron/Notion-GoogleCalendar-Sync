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
        return [parse_notion_task(page) for page in results]

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
