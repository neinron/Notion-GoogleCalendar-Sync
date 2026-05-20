from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta
from typing import Any

from .models import GoogleEvent, NotionTask


def page_id_from_url(url: str) -> str:
    match = re.search(r"([0-9a-fA-F]{32})(?:[?#/]|$)", url.replace("-", ""))
    if not match:
        return ""
    raw = match.group(1).lower()
    return f"{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}"


def stable_hash(data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def title_plain(prop: dict[str, Any]) -> str:
    parts = prop.get("title") or []
    return "".join(part.get("plain_text", "") for part in parts if isinstance(part, dict)).strip()


def text_plain(prop: dict[str, Any]) -> str:
    parts = prop.get("rich_text") or []
    return "".join(part.get("plain_text", "") for part in parts if isinstance(part, dict)).strip()


def select_name(prop: dict[str, Any], key: str = "select") -> str:
    value = prop.get(key) or {}
    return value.get("name", "") if isinstance(value, dict) else ""


def relation_ids(prop: dict[str, Any]) -> list[str]:
    return [item.get("id", "") for item in prop.get("relation", []) if isinstance(item, dict) and item.get("id")]


def parse_notion_task(page: dict[str, Any]) -> NotionTask:
    props = page.get("properties") or {}
    do_date = (props.get("Do Date") or {}).get("date") or {}
    due_date = (props.get("Due Date") or {}).get("date") or {}
    page_id = page.get("id") or page_id_from_url(page.get("url", ""))
    return NotionTask(
        page_id=page_id,
        url=page.get("url", ""),
        title=title_plain(props.get("Name") or {}) or "Untitled",
        status=select_name(props.get("Status") or {}, "status"),
        task_type=select_name(props.get("Type") or {}),
        priority=select_name(props.get("Priority") or {}),
        course=",".join(relation_ids(props.get("Course") or {})),
        due_start=due_date.get("start", "") if isinstance(due_date, dict) else "",
        do_start=do_date.get("start", "") if isinstance(do_date, dict) else "",
        do_end=do_date.get("end", "") if isinstance(do_date, dict) else "",
        do_is_datetime=bool(isinstance(do_date, dict) and do_date.get("start") and "T" in do_date.get("start", "")),
        last_edited_time=page.get("last_edited_time", ""),
        raw=page,
    )


def notion_hash(task: NotionTask) -> str:
    return stable_hash(
        {
            "title": task.title,
            "status": task.status,
            "task_type": task.task_type,
            "priority": task.priority,
            "course": task.course,
            "due_start": task.due_start,
            "do_start": task.do_start,
            "do_end": task.do_end,
            "do_is_datetime": task.do_is_datetime,
        }
    )


def event_description(task: NotionTask) -> str:
    parts = [
        f"Notion: {task.url}",
        f"Status: {task.status}",
    ]
    if task.task_type:
        parts.append(f"Type: {task.task_type}")
    if task.priority:
        parts.append(f"Priority: {task.priority}")
    if task.course:
        parts.append(f"Course: {task.course}")
    if task.due_start:
        parts.append(f"Due Date: {task.due_start}")
    return "\n".join(parts)


def _parse_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _parse_datetime(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def has_explicit_timezone(value: str) -> bool:
    if value.endswith("Z"):
        return True
    time_part = value.split("T", 1)[1] if "T" in value else ""
    return "+" in time_part or "-" in time_part


def default_end(start: str) -> str:
    if not start:
        return ""
    if "T" not in start:
        parsed = _parse_date(start)
        return (parsed + timedelta(days=1)).isoformat() if parsed else start
    dt = _parse_datetime(start)
    if not dt:
        return start
    return (dt + timedelta(hours=1)).isoformat()


def normalized_end(start: str, end: str) -> str:
    fallback = default_end(start)
    if not start or not end:
        return fallback
    if "T" not in start:
        start_date = _parse_date(start)
        end_date = _parse_date(end)
        if not start_date or not end_date or end_date <= start_date:
            return fallback
        return end
    start_dt = _parse_datetime(start)
    end_dt = _parse_datetime(end)
    if not start_dt or not end_dt or end_dt <= start_dt:
        return fallback
    return end


def notion_task_to_google_body(task: NotionTask, *, time_zone: str = "Europe/Berlin") -> dict[str, Any]:
    is_all_day = bool(task.do_start and "T" not in task.do_start)
    start_key = "date" if is_all_day else "dateTime"
    body = {
        "summary": task.title,
        "description": event_description(task),
        "extendedProperties": {"private": {"notion_page_id": task.page_id}},
    }
    if task.do_start:
        body["start"] = {start_key: task.do_start}
        body["end"] = {start_key: normalized_end(task.do_start, task.do_end)}
        if not is_all_day and not has_explicit_timezone(task.do_start):
            body["start"]["timeZone"] = time_zone
            body["end"]["timeZone"] = time_zone
    return body


def parse_google_event(event: dict[str, Any]) -> GoogleEvent:
    private = ((event.get("extendedProperties") or {}).get("private") or {})
    start_obj = event.get("start") or {}
    end_obj = event.get("end") or {}
    is_all_day = "date" in start_obj
    return GoogleEvent(
        event_id=event.get("id", ""),
        notion_page_id=private.get("notion_page_id", ""),
        title=event.get("summary", ""),
        description=event.get("description", ""),
        start=start_obj.get("dateTime") or start_obj.get("date") or "",
        end=end_obj.get("dateTime") or end_obj.get("date") or "",
        is_all_day=is_all_day,
        updated=event.get("updated", ""),
        status=event.get("status", ""),
        raw=event,
    )


def google_hash(event: GoogleEvent) -> str:
    return stable_hash(
        {
            "title": event.title,
            "description": event.description,
            "start": event.start,
            "end": event.end,
            "is_all_day": event.is_all_day,
            "status": event.status,
        }
    )


def google_event_to_notion_properties(event: GoogleEvent) -> dict[str, Any]:
    props: dict[str, Any] = {
        "Name": {"title": [{"text": {"content": event.title or "Untitled"}}]},
    }
    if event.start:
        props["Do Date"] = {"date": {"start": event.start, "end": event.end or None}}
    else:
        props["Do Date"] = {"date": None}
    return props
