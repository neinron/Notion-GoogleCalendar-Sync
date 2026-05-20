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
);

CREATE TABLE IF NOT EXISTS webhook_channels (
  channel_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL DEFAULT '',
  resource_uri TEXT NOT NULL DEFAULT '',
  calendar_id TEXT NOT NULL DEFAULT '',
  expiration TEXT NOT NULL DEFAULT '',
  token_hint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
