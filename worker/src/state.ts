import type { SyncRecord, SyncStats } from "./types";

export class D1State {
  constructor(private readonly db: D1Database) {}

  async get(notionPageId: string): Promise<SyncRecord | null> {
    return await this.db
      .prepare("SELECT * FROM sync_records WHERE notion_page_id = ?")
      .bind(notionPageId)
      .first<SyncRecord>();
  }
  async upsert(
    notionPageId: string,
    data: {
      googleEventId?: string | null;
      lastNotionHash: string;
      lastGoogleHash: string;
      lastNotionEditedTime: string;
      lastGoogleUpdated: string;
      syncStatus?: string;
      lastError?: string;
    },
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sync_records (
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
          updated_at = excluded.updated_at`,
      )
      .bind(
        notionPageId,
        data.googleEventId ?? null,
        data.lastNotionHash,
        data.lastGoogleHash,
        data.lastNotionEditedTime,
        data.lastGoogleUpdated,
        data.syncStatus ?? "synced",
        data.lastError ?? "",
        utcNow(),
      )
      .run();
  }

  async markConflict(notionPageId: string, googleEventId: string | null, error: string): Promise<void> {
    const record = await this.get(notionPageId);
    await this.upsert(notionPageId, {
      googleEventId: googleEventId || record?.google_event_id || null,
      lastNotionHash: record?.last_notion_hash ?? "",
      lastGoogleHash: record?.last_google_hash ?? "",
      lastNotionEditedTime: record?.last_notion_edited_time ?? "",
      lastGoogleUpdated: record?.last_google_updated ?? "",
      syncStatus: "conflict",
      lastError: error,
    });
  }

  async markRetryable(notionPageId: string, googleEventId: string | null, error: string): Promise<void> {
    const record = await this.get(notionPageId);
    await this.upsert(notionPageId, {
      googleEventId: googleEventId || record?.google_event_id || null,
      lastNotionHash: record?.last_notion_hash ?? "",
      lastGoogleHash: record?.last_google_hash ?? "",
      lastNotionEditedTime: record?.last_notion_edited_time ?? "",
      lastGoogleUpdated: record?.last_google_updated ?? "",
      syncStatus: "retry_pending",
      lastError: error,
    });
  }

  async markManualConflict(notionPageId: string, googleEventId: string | null, error: string): Promise<void> {
    const record = await this.get(notionPageId);
    await this.upsert(notionPageId, {
      googleEventId: googleEventId || record?.google_event_id || null,
      lastNotionHash: record?.last_notion_hash ?? "",
      lastGoogleHash: record?.last_google_hash ?? "",
      lastNotionEditedTime: record?.last_notion_edited_time ?? "",
      lastGoogleUpdated: record?.last_google_updated ?? "",
      syncStatus: "manual_conflict",
      lastError: error,
    });
  }

  async listConflicts(): Promise<unknown[]> {
    const result = await this.db
      .prepare("SELECT * FROM sync_records WHERE sync_status = 'manual_conflict' ORDER BY updated_at DESC")
      .all();
    return result.results ?? [];
  }

  async markSeen(scanId: string, notionPageId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sync_seen (notion_page_id, scan_id, seen_at)
        VALUES (?, ?, ?)
        ON CONFLICT(notion_page_id) DO UPDATE SET
          scan_id = excluded.scan_id,
          seen_at = excluded.seen_at`,
      )
      .bind(notionPageId, scanId, utcNow())
      .run();
  }

  async wasSeenInScan(scanId: string, notionPageId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS found FROM sync_seen WHERE notion_page_id = ? AND scan_id = ?")
      .bind(notionPageId, scanId)
      .first<{ found: number }>();
    return Boolean(row);
  }

  async createRun(id: string, source: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO sync_runs (id, source, started_at) VALUES (?, ?, ?)")
      .bind(id, source, utcNow())
      .run();
  }

  async finishRun(id: string, status: string, stats: SyncStats | null, errorSummary = ""): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sync_runs SET
          status = ?,
          phase = ?,
          processed = ?,
          created = ?,
          updated_google = ?,
          updated_notion = ?,
          deleted_google = ?,
          cleared_notion_dates = ?,
          retryable_errors = ?,
          manual_conflicts = ?,
          skipped = ?,
          has_more = ?,
          error_summary = ?,
          finished_at = ?
        WHERE id = ?`,
      )
      .bind(
        status,
        stats?.phase ?? "",
        stats?.processed ?? 0,
        stats?.created ?? 0,
        stats?.updated_google ?? 0,
        stats?.updated_notion ?? 0,
        stats?.deleted_google ?? 0,
        stats?.cleared_notion_dates ?? 0,
        stats?.retryable_errors ?? 0,
        stats?.manual_conflicts ?? 0,
        stats?.skipped ?? 0,
        stats?.has_more ? 1 : 0,
        errorSummary.slice(0, 1000),
        utcNow(),
        id,
      )
      .run();
  }

  async listRuns(limit = 20): Promise<unknown[]> {
    const result = await this.db
      .prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?")
      .bind(limit)
      .all();
    return result.results ?? [];
  }

  async listWebhookChannels(): Promise<any[]> {
    const result = await this.db.prepare("SELECT * FROM webhook_channels ORDER BY updated_at DESC").all();
    return (result.results ?? []) as any[];
  }

  async upsertWebhookChannel(channel: {
    channelId: string;
    resourceId: string;
    resourceUri: string;
    calendarId: string;
    expiration: string;
    tokenHint?: string;
  }): Promise<void> {
    const now = utcNow();
    await this.db
      .prepare(
        `INSERT INTO webhook_channels (
          channel_id, resource_id, resource_uri, calendar_id, expiration,
          token_hint, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          resource_id = excluded.resource_id,
          resource_uri = excluded.resource_uri,
          calendar_id = excluded.calendar_id,
          expiration = excluded.expiration,
          token_hint = excluded.token_hint,
          updated_at = excluded.updated_at`,
      )
      .bind(
        channel.channelId,
        channel.resourceId,
        channel.resourceUri,
        channel.calendarId,
        channel.expiration,
        channel.tokenHint ?? "",
        now,
        now,
      )
      .run();
  }

  async getSetting(key: string): Promise<string> {
    const row = await this.db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? "";
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, utcNow())
      .run();
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM app_settings WHERE key = ?").bind(key).run();
  }

  async acquireLock(key: string, owner: string, ttlSeconds = 300): Promise<boolean> {
    const cutoff = new Date(Date.now() - ttlSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await this.db.prepare("DELETE FROM app_settings WHERE key = ? AND updated_at < ?").bind(key, cutoff).run();
    try {
      await this.db
        .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)")
        .bind(key, owner, utcNow())
        .run();
      return true;
    } catch {
      return false;
    }
  }

  async releaseLock(key: string, owner: string): Promise<void> {
    await this.db.prepare("DELETE FROM app_settings WHERE key = ? AND value = ?").bind(key, owner).run();
  }
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
