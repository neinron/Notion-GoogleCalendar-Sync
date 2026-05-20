from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any


COMPLETED_STATUSES = {
    "done",
    "complete",
    "completed",
    "erledigt",
    "fertig",
    "abgeschlossen",
    "archived",
    "archiviert",
}


@dataclass(frozen=True)
class NotionTask:
    page_id: str
    url: str
    title: str
    status: str
    task_type: str
    priority: str
    course: str
    due_start: str
    do_start: str
    do_end: str
    do_is_datetime: bool
    last_edited_time: str
    raw: dict[str, Any]

    @property
    def is_completed(self) -> bool:
        return self.status.strip().lower() in COMPLETED_STATUSES

    @property
    def has_do_date(self) -> bool:
        return bool(self.do_start)


@dataclass(frozen=True)
class GoogleEvent:
    event_id: str
    notion_page_id: str
    title: str
    description: str
    start: str
    end: str
    is_all_day: bool
    updated: str
    status: str
    raw: dict[str, Any]

    @property
    def is_cancelled(self) -> bool:
        return self.status == "cancelled"


@dataclass(frozen=True)
class SyncRecord:
    notion_page_id: str
    google_event_id: str | None
    last_notion_hash: str
    last_google_hash: str
    last_notion_edited_time: str
    last_google_updated: str
    sync_status: str
    last_error: str
    updated_at: str


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
