export interface Env {
  DB: D1Database;
  NOTION_API_KEY: string;
  DATABASE_ID: string;
  GOOGLE_CALENDAR_ID: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  SYNC_SECRET: string;
  PUBLIC_BASE_URL: string;
  GOOGLE_WEBHOOK_TOKEN: string;
  NOTION_WEBHOOK_VERIFICATION_TOKEN?: string;
  NOTION_VERSION?: string;
  GOOGLE_TIME_ZONE?: string;
}

export interface NotionTask {
  pageId: string;
  url: string;
  title: string;
  status: string;
  taskType: string;
  priority: string;
  course: string;
  dueStart: string;
  doStart: string;
  doEnd: string;
  doIsDatetime: boolean;
  lastEditedTime: string;
  raw: unknown;
}

export interface GoogleEvent {
  eventId: string;
  notionPageId: string;
  title: string;
  description: string;
  start: string;
  end: string;
  isAllDay: boolean;
  updated: string;
  status: string;
  raw: unknown;
}

export interface SyncRecord {
  notion_page_id: string;
  google_event_id: string | null;
  last_notion_hash: string;
  last_google_hash: string;
  last_notion_edited_time: string;
  last_google_updated: string;
  sync_status: string;
  last_error: string;
  updated_at: string;
}

export interface SyncStats {
  ok: true;
  created: number;
  updated_google: number;
  updated_notion: number;
  deleted_google: number;
  cleared_notion_dates: number;
  conflicts: number;
  skipped: number;
  has_more?: boolean;
}
