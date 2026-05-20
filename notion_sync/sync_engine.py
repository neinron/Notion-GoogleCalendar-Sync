from __future__ import annotations

import logging
from typing import Any

from .config import Config
from .google_client import GoogleCalendarClient
from .models import GoogleEvent, NotionTask
from .notion_client import NotionClient
from .serialize import google_event_to_notion_properties, google_hash, notion_hash, notion_task_to_google_body
from .state import SyncState


class SyncEngine:
    def __init__(
        self,
        config: Config,
        state: SyncState,
        notion: NotionClient,
        google: GoogleCalendarClient,
        *,
        logger: logging.Logger | None = None,
    ):
        self.config = config
        self.state = state
        self.notion = notion
        self.google = google
        self.logger = logger or logging.getLogger(__name__)

    def sync(self) -> dict[str, Any]:
        tasks = {task.page_id: task for task in self.notion.list_tasks()}
        events = {event.notion_page_id: event for event in self.google.list_events()}
        stats = {
            "ok": True,
            "created": 0,
            "updated_google": 0,
            "updated_notion": 0,
            "deleted_google": 0,
            "cleared_notion_dates": 0,
            "conflicts": 0,
            "skipped": 0,
        }

        for page_id, task in tasks.items():
            try:
                event = events.get(page_id)
                self._sync_task(task, event, stats)
            except Exception as exc:
                self.logger.exception("sync failed for Notion page %s", page_id)
                self.state.mark_conflict(page_id, events.get(page_id).event_id if events.get(page_id) else None, str(exc))
                stats["conflicts"] += 1

        for page_id, event in events.items():
            if page_id not in tasks and not event.is_cancelled:
                self.google.delete_event(event.event_id)
                stats["deleted_google"] += 1

        return stats

    def _sync_task(self, task: NotionTask, event: GoogleEvent | None, stats: dict[str, int]) -> None:
        record = self.state.get(task.page_id)
        current_notion_hash = notion_hash(task)

        if task.is_completed:
            if event and not event.is_cancelled:
                self.google.delete_event(event.event_id)
                stats["deleted_google"] += 1
            self.state.upsert(
                task.page_id,
                google_event_id=event.event_id if event else (record.google_event_id if record else None),
                last_notion_hash=current_notion_hash,
                last_google_hash=google_hash(event) if event else "",
                last_notion_edited_time=task.last_edited_time,
                last_google_updated=event.updated if event else "",
                sync_status="done",
            )
            return

        if event and event.is_cancelled:
            self.notion.clear_do_date(task.page_id)
            self.state.upsert(
                task.page_id,
                google_event_id=event.event_id,
                last_notion_hash=current_notion_hash,
                last_google_hash=google_hash(event),
                last_notion_edited_time=task.last_edited_time,
                last_google_updated=event.updated,
                sync_status="unscheduled",
            )
            stats["cleared_notion_dates"] += 1
            return

        if not task.has_do_date:
            if event and not event.is_cancelled:
                self.google.delete_event(event.event_id)
                stats["deleted_google"] += 1
            self.state.upsert(
                task.page_id,
                google_event_id=event.event_id if event else (record.google_event_id if record else None),
                last_notion_hash=current_notion_hash,
                last_google_hash=google_hash(event) if event else "",
                last_notion_edited_time=task.last_edited_time,
                last_google_updated=event.updated if event else "",
                sync_status="unscheduled",
            )
            return

        if not event:
            created = self.google.create_event(notion_task_to_google_body(task))
            self.state.upsert(
                task.page_id,
                google_event_id=created.event_id,
                last_notion_hash=current_notion_hash,
                last_google_hash=google_hash(created),
                last_notion_edited_time=task.last_edited_time,
                last_google_updated=created.updated,
            )
            stats["created"] += 1
            return

        current_google_hash = google_hash(event)
        notion_changed = bool(record and record.last_notion_hash and record.last_notion_hash != current_notion_hash)
        google_changed = bool(record and record.last_google_hash and record.last_google_hash != current_google_hash)

        if notion_changed and google_changed:
            self.state.mark_conflict(task.page_id, event.event_id, "Notion and Google both changed since last sync")
            stats["conflicts"] += 1
            return

        if google_changed and not notion_changed:
            updated_page = self.notion.update_page_properties(task.page_id, google_event_to_notion_properties(event))
            updated_task = task.__class__(**{**task.__dict__, "last_edited_time": updated_page.get("last_edited_time", task.last_edited_time)})
            self.state.upsert(
                task.page_id,
                google_event_id=event.event_id,
                last_notion_hash=notion_hash(updated_task),
                last_google_hash=current_google_hash,
                last_notion_edited_time=updated_task.last_edited_time,
                last_google_updated=event.updated,
            )
            stats["updated_notion"] += 1
            return

        desired_google_body = notion_task_to_google_body(task)
        desired_event = GoogleEvent(
            event_id=event.event_id,
            notion_page_id=task.page_id,
            title=desired_google_body.get("summary", ""),
            description=desired_google_body.get("description", ""),
            start=(desired_google_body.get("start") or {}).get("dateTime") or (desired_google_body.get("start") or {}).get("date") or "",
            end=(desired_google_body.get("end") or {}).get("dateTime") or (desired_google_body.get("end") or {}).get("date") or "",
            is_all_day="date" in (desired_google_body.get("start") or {}),
            updated=event.updated,
            status=event.status,
            raw={},
        )
        if notion_changed or google_hash(desired_event) != current_google_hash:
            updated = self.google.update_event(event.event_id, desired_google_body)
            self.state.upsert(
                task.page_id,
                google_event_id=updated.event_id,
                last_notion_hash=current_notion_hash,
                last_google_hash=google_hash(updated),
                last_notion_edited_time=task.last_edited_time,
                last_google_updated=updated.updated,
            )
            stats["updated_google"] += 1
            return

        self.state.upsert(
            task.page_id,
            google_event_id=event.event_id,
            last_notion_hash=current_notion_hash,
            last_google_hash=current_google_hash,
            last_notion_edited_time=task.last_edited_time,
            last_google_updated=event.updated,
        )
        stats["skipped"] += 1
