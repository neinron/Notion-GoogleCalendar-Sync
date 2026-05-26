CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  phase TEXT NOT NULL DEFAULT '',
  processed INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated_google INTEGER NOT NULL DEFAULT 0,
  updated_notion INTEGER NOT NULL DEFAULT 0,
  deleted_google INTEGER NOT NULL DEFAULT 0,
  cleared_notion_dates INTEGER NOT NULL DEFAULT 0,
  retryable_errors INTEGER NOT NULL DEFAULT 0,
  manual_conflicts INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  has_more INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS course_registration_cache (
  course_id TEXT PRIMARY KEY,
  registered INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_seen (
  notion_page_id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  seen_at TEXT NOT NULL
);

UPDATE sync_records
SET sync_status = 'retry_pending', last_error = ''
WHERE sync_status = 'conflict'
  AND last_error LIKE '%Too many subrequests%';

DELETE FROM app_settings
WHERE key IN ('sync_cursor', 'notion_cursor', 'cleanup_cursor', 'sync_phase', 'current_scan_id');
