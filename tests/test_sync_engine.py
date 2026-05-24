from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from notion_sync.config import Config
from notion_sync.google_client import GoogleCalendarError
from notion_sync.models import GoogleEvent, NotionTask
from notion_sync.serialize import event_description, google_hash, notion_hash, notion_task_to_google_body
from notion_sync.state import SyncState
from notion_sync.sync_engine import SyncEngine


def cfg(tmp: Path) -> Config:
    return Config(
        notion_api_key="notion",
        database_id="db",
        google_calendar_id="cal",
        google_client_id="cid",
        google_client_secret="secret",
        google_refresh_token="refresh",
        google_time_zone="Europe/Berlin",
        public_base_url="https://example.com",
        google_webhook_token="google-token",
        notion_webhook_verification_token="notion-token",
        github_webhook_secret="hook",
        sync_secret="sync",
        repo_path=tmp,
        wsgi_file=tmp / "wsgi.py",
        state_db_path=tmp / "state.sqlite3",
        sync_lock_path=tmp / "sync.lock",
        deploy_lock_path=tmp / "deploy.lock",
    )


def task(page_id: str = "page1", *, do_start: str = "2026-05-21T10:00:00+02:00", do_end: str | None = "2026-05-21T11:00:00+02:00", status: str = "not started", edited: str = "n1", title: str = "Task") -> NotionTask:
    return NotionTask(
        page_id=page_id,
        url=f"https://notion.so/{page_id}",
        title=title,
        status=status,
        task_type="To-Do",
        priority="High",
        course="course1",
        due_start="2026-05-22",
        do_start=do_start,
        do_end=do_end if do_end is not None else "",
        do_is_datetime=bool(do_start),
        last_edited_time=edited,
        raw={},
    )


def event(page_id: str = "page1", *, event_id: str = "event1", start: str = "2026-05-21T10:00:00+02:00", updated: str = "g1", title: str = "Task", status: str = "confirmed", description: str | None = None) -> GoogleEvent:
    return GoogleEvent(
        event_id=event_id,
        notion_page_id=page_id,
        title=title,
        description=description if description is not None else event_description(task(page_id, title=title)),
        start=start,
        end="2026-05-21T11:00:00+02:00" if start else "",
        is_all_day=False,
        updated=updated,
        status=status,
        raw={},
    )


class FakeNotion:
    def __init__(self, tasks):
        self.tasks = tasks
        self.updated = []
        self.cleared = []

    def list_tasks(self):
        return self.tasks

    def update_page_properties(self, page_id, properties):
        self.updated.append((page_id, properties))
        return {"last_edited_time": "n2"}

    def clear_do_date(self, page_id):
        self.cleared.append(page_id)
        return {"last_edited_time": "n2"}


class FakeGoogle:
    def __init__(self, events, *, fail_update_400: bool = False):
        self.events = events
        self.fail_update_400 = fail_update_400
        self.created = []
        self.updated = []
        self.deleted = []

    def list_events(self):
        return self.events

    def create_event(self, body):
        self.created.append(body)
        return event(event_id="created", updated="g2", title=body["summary"])

    def update_event(self, event_id, body):
        self.updated.append((event_id, body))
        if self.fail_update_400:
            raise GoogleCalendarError("bad request", status_code=400, response_body='{"error":"invalid end"}')
        return event(event_id=event_id, updated="g2", title=body["summary"])

    def delete_event(self, event_id):
        self.deleted.append(event_id)


class SyncEngineTests(unittest.TestCase):
    def build(self, tmp: Path, tasks, events, *, fail_update_400: bool = False):
        conf = cfg(tmp)
        state = SyncState(conf.state_db_path)
        notion = FakeNotion(tasks)
        google = FakeGoogle(events, fail_update_400=fail_update_400)
        engine = SyncEngine(conf, state, notion, google)
        return engine, state, notion, google

    def test_first_sync_creates_google_event(self):
        with tempfile.TemporaryDirectory() as d:
            engine, state, _, google = self.build(Path(d), [task()], [])
            result = engine.sync()
            self.assertEqual(result["created"], 1)
            self.assertEqual(len(google.created), 1)
            self.assertEqual(state.get("page1").google_event_id, "created")

    def test_idempotent_sync_skips_when_hashes_match(self):
        with tempfile.TemporaryDirectory() as d:
            t = task()
            e = event()
            engine, state, _, google = self.build(Path(d), [t], [e])
            state.upsert("page1", google_event_id="event1", last_notion_hash=notion_hash(t), last_google_hash=google_hash(e), last_notion_edited_time=t.last_edited_time, last_google_updated=e.updated)
            result = engine.sync()
            self.assertEqual(result["skipped"], 1)
            self.assertEqual(google.updated, [])

    def test_google_change_updates_notion(self):
        with tempfile.TemporaryDirectory() as d:
            t = task()
            old = event()
            changed = event(start="2026-05-21T12:00:00+02:00", updated="g2", title="Task moved")
            engine, state, notion, _ = self.build(Path(d), [t], [changed])
            state.upsert("page1", google_event_id="event1", last_notion_hash=notion_hash(t), last_google_hash=google_hash(old), last_notion_edited_time=t.last_edited_time, last_google_updated=old.updated)
            result = engine.sync()
            self.assertEqual(result["updated_notion"], 1)
            self.assertEqual(notion.updated[0][0], "page1")

    def test_simultaneous_change_uses_notion_as_source_of_truth(self):
        with tempfile.TemporaryDirectory() as d:
            old_task = task()
            old_event = event()
            new_task = task(title="Changed in Notion", edited="n2")
            new_event = event(title="Changed in Google", updated="g2")
            engine, state, _, google = self.build(Path(d), [new_task], [new_event])
            state.upsert("page1", google_event_id="event1", last_notion_hash=notion_hash(old_task), last_google_hash=google_hash(old_event), last_notion_edited_time=old_task.last_edited_time, last_google_updated=old_event.updated)
            result = engine.sync()
            self.assertEqual(result["conflicts"], 0)
            self.assertEqual(result["updated_google"], 1)
            self.assertEqual(state.get("page1").sync_status, "synced")
            self.assertEqual(google.updated[0][1]["summary"], "Changed in Notion")

    def test_google_delete_clears_notion_do_date(self):
        with tempfile.TemporaryDirectory() as d:
            engine, _, notion, _ = self.build(Path(d), [task()], [event(status="cancelled")])
            result = engine.sync()
            self.assertEqual(result["cleared_notion_dates"], 1)
            self.assertEqual(notion.cleared, ["page1"])

    def test_done_notion_task_deletes_google_event(self):
        with tempfile.TemporaryDirectory() as d:
            engine, _, _, google = self.build(Path(d), [task(status="done")], [event()])
            result = engine.sync()
            self.assertEqual(result["deleted_google"], 1)
            self.assertEqual(google.deleted, ["event1"])

    def test_date_only_without_end_gets_one_day_google_end(self):
        body = notion_task_to_google_body(task(do_start="2026-05-21", do_end=None))
        self.assertEqual(body["start"], {"date": "2026-05-21"})
        self.assertEqual(body["end"], {"date": "2026-05-22"})

    def test_datetime_without_end_gets_one_hour_google_end(self):
        body = notion_task_to_google_body(task(do_start="2026-05-21T10:00:00+02:00", do_end=None))
        self.assertEqual(body["start"], {"dateTime": "2026-05-21T10:00:00+02:00"})
        self.assertEqual(body["end"], {"dateTime": "2026-05-21T11:00:00+02:00"})

    def test_datetime_without_timezone_adds_configured_timezone(self):
        body = notion_task_to_google_body(task(do_start="2026-05-21T10:00:00", do_end=None), time_zone="Europe/Berlin")
        self.assertEqual(body["start"], {"dateTime": "2026-05-21T10:00:00", "timeZone": "Europe/Berlin"})
        self.assertEqual(body["end"], {"dateTime": "2026-05-21T11:00:00", "timeZone": "Europe/Berlin"})

    def test_google_update_400_recreates_event_from_notion(self):
        with tempfile.TemporaryDirectory() as d:
            t = task(title="Changed in Notion", edited="n2")
            old = event()
            existing = event(title="Old Google", updated="g1")
            engine, state, _, google = self.build(Path(d), [t], [existing], fail_update_400=True)
            state.upsert("page1", google_event_id="event1", last_notion_hash=notion_hash(task()), last_google_hash=google_hash(old), last_notion_edited_time="n1", last_google_updated="g1")
            result = engine.sync()
            self.assertEqual(result["updated_google"], 1)
            self.assertEqual(google.deleted, ["event1"])
            self.assertEqual(len(google.created), 1)
            self.assertEqual(state.get("page1").google_event_id, "created")

    def test_existing_google_event_is_deleted_when_notion_task_is_filtered_out(self):
        with tempfile.TemporaryDirectory() as d:
            engine, _, _, google = self.build(Path(d), [], [event(page_id="old-course-task")])
            result = engine.sync()
            self.assertEqual(result["deleted_google"], 1)
            self.assertEqual(google.deleted, ["event1"])


if __name__ == "__main__":
    unittest.main()
