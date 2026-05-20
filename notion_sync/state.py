from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .models import SyncRecord, utc_now_iso


class SyncState:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        conn = self.connect()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sync_records (
                    notion_page_id TEXT PRIMARY KEY,
                    google_event_id TEXT,
                    last_notion_hash TEXT NOT NULL DEFAULT '',
                    last_google_hash TEXT NOT NULL DEFAULT '',
                    last_notion_edited_time TEXT NOT NULL DEFAULT '',
                    last_google_updated TEXT NOT NULL DEFAULT '',
                    sync_status TEXT NOT NULL DEFAULT 'new',
                    last_error TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.commit()
        finally:
            conn.close()

    def get(self, notion_page_id: str) -> SyncRecord | None:
        conn = self.connect()
        try:
            row = conn.execute("SELECT * FROM sync_records WHERE notion_page_id = ?", (notion_page_id,)).fetchone()
        finally:
            conn.close()
        return self._record(row) if row else None

    def get_by_google_event_id(self, google_event_id: str) -> SyncRecord | None:
        conn = self.connect()
        try:
            row = conn.execute("SELECT * FROM sync_records WHERE google_event_id = ?", (google_event_id,)).fetchone()
        finally:
            conn.close()
        return self._record(row) if row else None

    def upsert(
        self,
        notion_page_id: str,
        *,
        google_event_id: str | None,
        last_notion_hash: str,
        last_google_hash: str,
        last_notion_edited_time: str,
        last_google_updated: str,
        sync_status: str = "synced",
        last_error: str = "",
    ) -> None:
        conn = self.connect()
        try:
            conn.execute(
                """
                INSERT INTO sync_records (
                    notion_page_id, google_event_id, last_notion_hash, last_google_hash,
                    last_notion_edited_time, last_google_updated, sync_status, last_error, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(notion_page_id) DO UPDATE SET
                    google_event_id = excluded.google_event_id,
                    last_notion_hash = excluded.last_notion_hash,
                    last_google_hash = excluded.last_google_hash,
                    last_notion_edited_time = excluded.last_notion_edited_time,
                    last_google_updated = excluded.last_google_updated,
                    sync_status = excluded.sync_status,
                    last_error = excluded.last_error,
                    updated_at = excluded.updated_at
                """,
                (
                    notion_page_id,
                    google_event_id,
                    last_notion_hash,
                    last_google_hash,
                    last_notion_edited_time,
                    last_google_updated,
                    sync_status,
                    last_error,
                    utc_now_iso(),
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def mark_conflict(self, notion_page_id: str, google_event_id: str | None, error: str) -> None:
        record = self.get(notion_page_id)
        self.upsert(
            notion_page_id,
            google_event_id=google_event_id or (record.google_event_id if record else None),
            last_notion_hash=record.last_notion_hash if record else "",
            last_google_hash=record.last_google_hash if record else "",
            last_notion_edited_time=record.last_notion_edited_time if record else "",
            last_google_updated=record.last_google_updated if record else "",
            sync_status="conflict",
            last_error=error,
        )

    def list_conflicts(self) -> list[dict[str, Any]]:
        conn = self.connect()
        try:
            rows = conn.execute("SELECT * FROM sync_records WHERE sync_status = 'conflict' ORDER BY updated_at DESC").fetchall()
        finally:
            conn.close()
        return [dict(row) for row in rows]

    def all_records(self) -> list[SyncRecord]:
        conn = self.connect()
        try:
            rows = conn.execute("SELECT * FROM sync_records").fetchall()
        finally:
            conn.close()
        return [self._record(row) for row in rows]

    @staticmethod
    def _record(row: sqlite3.Row) -> SyncRecord:
        return SyncRecord(
            notion_page_id=row["notion_page_id"],
            google_event_id=row["google_event_id"],
            last_notion_hash=row["last_notion_hash"],
            last_google_hash=row["last_google_hash"],
            last_notion_edited_time=row["last_notion_edited_time"],
            last_google_updated=row["last_google_updated"],
            sync_status=row["sync_status"],
            last_error=row["last_error"],
            updated_at=row["updated_at"],
        )
