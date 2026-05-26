import { ApiError, GoogleCalendarClient, GoogleCalendarError, NotionClient } from "./clients";
import {
  desiredGoogleEvent,
  googleEventToNotionProperties,
  googleHash,
  isCompleted,
  notionHash,
  notionTaskToGoogleBody,
} from "./serialize";
import { D1State } from "./state";
import type { GoogleEvent, NotionTask, SyncStats } from "./types";

const COURSE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TASK_LIMIT = 6;
const DEFAULT_CLEANUP_LIMIT = 10;

type ErrorKind = "retryable" | "config" | "manual";

export class SyncEngine {
  constructor(
    private readonly state: D1State,
    private readonly notion: NotionClient,
    private readonly google: GoogleCalendarClient,
  ) {}

  async sync(options: { limit?: number; cleanupLimit?: number } = {}): Promise<SyncStats> {
    const limit = options.limit ?? DEFAULT_TASK_LIMIT;
    const cleanupLimit = options.cleanupLimit ?? DEFAULT_CLEANUP_LIMIT;
    const phase = ((await this.state.getSetting("sync_phase")) || "tasks") as "tasks" | "cleanup";
    const stats = newStats(phase);

    if (phase === "cleanup") {
      await this.cleanupEvents(stats, cleanupLimit);
      return stats;
    }

    const scanId = await this.currentScanId();
    const events = new Map((await this.google.listEvents()).map((event) => [event.notionPageId, event]));
    let cursor = await this.state.getSetting("notion_cursor");
    let hasMore = true;

    while (stats.processed < limit && hasMore) {
      const pageSize = Math.max(1, Math.min(10, limit - stats.processed));
      const page = await this.notion.listTasksPage({ startCursor: cursor || undefined, pageSize });
      const tasks = prioritizeCalendarTasks(page.tasks);

      for (const task of tasks) {
        await this.state.markSeen(scanId, task.pageId);
        stats.processed += 1;

        try {
          const registered = await this.taskHasRegisteredCourse(task);
          if (!registered) {
            await this.syncUnregisteredTask(task, events.get(task.pageId) ?? null, stats);
          } else {
            await this.syncTask(task, events.get(task.pageId) ?? null, stats);
          }
        } catch (error) {
          const kind = classifySyncError(error);
          const message = errorMessage(error);
          if (kind === "config") throw error;
          if (kind === "manual") {
            await this.state.markManualConflict(task.pageId, events.get(task.pageId)?.eventId ?? null, message);
            stats.manual_conflicts += 1;
          } else {
            await this.state.markRetryable(task.pageId, events.get(task.pageId)?.eventId ?? null, message);
            stats.retryable_errors += 1;
          }
        }
      }

      cursor = page.nextCursor;
      hasMore = page.hasMore;
      if (hasMore) {
        await this.state.setSetting("notion_cursor", cursor);
      }
    }

    if (hasMore) {
      stats.has_more = true;
      return stats;
    }

    await this.state.deleteSetting("notion_cursor");
    await this.state.setSetting("last_complete_scan_id", scanId);
    await this.state.deleteSetting("current_scan_id");
    await this.state.setSetting("sync_phase", "cleanup");
    stats.has_more = true;
    return stats;
  }

  private async currentScanId(): Promise<string> {
    const existing = await this.state.getSetting("current_scan_id");
    if (existing) return existing;
    const scanId = crypto.randomUUID();
    await this.state.setSetting("current_scan_id", scanId);
    return scanId;
  }

  private async cleanupEvents(stats: SyncStats, cleanupLimit: number): Promise<void> {
    if (cleanupLimit <= 0) {
      await this.state.deleteSetting("cleanup_cursor");
      await this.state.deleteSetting("sync_phase");
      return;
    }

    const scanId = await this.state.getSetting("last_complete_scan_id");
    if (!scanId) {
      await this.state.deleteSetting("sync_phase");
      return;
    }

    const cursor = await this.state.getSetting("cleanup_cursor");
    let cursorSeen = !cursor;
    let lastProcessedEventId = "";
    const events = (await this.google.listEvents()).sort((left, right) => left.eventId.localeCompare(right.eventId));

    for (const event of events) {
      if (!cursorSeen) {
        if (event.eventId === cursor) cursorSeen = true;
        continue;
      }

      if (stats.deleted_google >= cleanupLimit) {
        stats.has_more = true;
        if (lastProcessedEventId) await this.state.setSetting("cleanup_cursor", lastProcessedEventId);
        return;
      }

      lastProcessedEventId = event.eventId;
      if (event.status === "cancelled") continue;

      if (!(await this.state.wasSeenInScan(scanId, event.notionPageId))) {
        await this.google.deleteEvent(event.eventId);
        stats.deleted_google += 1;
      }
    }

    await this.state.deleteSetting("cleanup_cursor");
    await this.state.deleteSetting("sync_phase");
  }

  private async taskHasRegisteredCourse(task: NotionTask): Promise<boolean> {
    const courseIds = task.course.split(",").filter(Boolean);
    for (const courseId of courseIds) {
      const cached = await this.state.getCourseRegistration(courseId);
      if (cached && Date.now() - Date.parse(cached.updatedAt) < COURSE_CACHE_TTL_MS) {
        if (cached.registered) return true;
        continue;
      }
      const registered = await this.notion.courseRegistered(courseId);
      await this.state.upsertCourseRegistration(courseId, registered);
      if (registered) return true;
    }
    return false;
  }

  private async syncUnregisteredTask(task: NotionTask, event: GoogleEvent | null, stats: SyncStats): Promise<void> {
    const record = await this.state.get(task.pageId);
    const currentNotionHash = await notionHash(task);
    if (event && event.status !== "cancelled") {
      await this.google.deleteEvent(event.eventId);
      stats.deleted_google += 1;
    }
    await this.state.upsert(task.pageId, {
      googleEventId: event?.eventId ?? record?.google_event_id ?? null,
      lastNotionHash: currentNotionHash,
      lastGoogleHash: event ? await googleHash(event) : "",
      lastNotionEditedTime: task.lastEditedTime,
      lastGoogleUpdated: event?.updated ?? "",
      syncStatus: "unregistered",
      lastError: "",
    });
  }

  private async syncTask(task: NotionTask, event: GoogleEvent | null, stats: SyncStats): Promise<void> {
    const record = await this.state.get(task.pageId);
    const currentNotionHash = await notionHash(task);

    if (isCompleted(task)) {
      if (event && event.status !== "cancelled") {
        await this.google.deleteEvent(event.eventId);
        stats.deleted_google += 1;
      }
      await this.state.upsert(task.pageId, {
        googleEventId: event?.eventId ?? record?.google_event_id ?? null,
        lastNotionHash: currentNotionHash,
        lastGoogleHash: event ? await googleHash(event) : "",
        lastNotionEditedTime: task.lastEditedTime,
        lastGoogleUpdated: event?.updated ?? "",
        syncStatus: "done",
        lastError: "",
      });
      return;
    }

    if (event?.status === "cancelled") {
      await this.notion.clearDoDate(task.pageId);
      await this.state.upsert(task.pageId, {
        googleEventId: event.eventId,
        lastNotionHash: currentNotionHash,
        lastGoogleHash: await googleHash(event),
        lastNotionEditedTime: task.lastEditedTime,
        lastGoogleUpdated: event.updated,
        syncStatus: "unscheduled",
        lastError: "",
      });
      stats.cleared_notion_dates += 1;
      return;
    }

    if (!task.doStart) {
      if (event && event.status !== "cancelled") {
        await this.google.deleteEvent(event.eventId);
        stats.deleted_google += 1;
      }
      await this.state.upsert(task.pageId, {
        googleEventId: event?.eventId ?? record?.google_event_id ?? null,
        lastNotionHash: currentNotionHash,
        lastGoogleHash: event ? await googleHash(event) : "",
        lastNotionEditedTime: task.lastEditedTime,
        lastGoogleUpdated: event?.updated ?? "",
        syncStatus: "unscheduled",
        lastError: "",
      });
      return;
    }

    if (!event) {
      const created = await this.google.createEvent(notionTaskToGoogleBody(task));
      await this.state.upsert(task.pageId, {
        googleEventId: created.eventId,
        lastNotionHash: currentNotionHash,
        lastGoogleHash: await googleHash(created),
        lastNotionEditedTime: task.lastEditedTime,
        lastGoogleUpdated: created.updated,
        syncStatus: "synced",
        lastError: "",
      });
      stats.created += 1;
      return;
    }

    const currentGoogleHash = await googleHash(event);
    const notionChanged = Boolean(record?.last_notion_hash && record.last_notion_hash !== currentNotionHash);
    const googleChanged = Boolean(record?.last_google_hash && record.last_google_hash !== currentGoogleHash);

    if (notionChanged && googleChanged) {
      await this.updateGoogleFromNotion(task, event, currentNotionHash, stats);
      return;
    }

    if (googleChanged && !notionChanged) {
      const updatedPage = await this.notion.updatePageProperties(task.pageId, googleEventToNotionProperties(event));
      const updatedTask = { ...task, lastEditedTime: updatedPage.last_edited_time ?? task.lastEditedTime };
      await this.state.upsert(task.pageId, {
        googleEventId: event.eventId,
        lastNotionHash: await notionHash(updatedTask),
        lastGoogleHash: currentGoogleHash,
        lastNotionEditedTime: updatedTask.lastEditedTime,
        lastGoogleUpdated: event.updated,
        syncStatus: "synced",
        lastError: "",
      });
      stats.updated_notion += 1;
      return;
    }

    const desired = desiredGoogleEvent(event.eventId, task, event);
    if (notionChanged || (await googleHash(desired)) !== currentGoogleHash) {
      await this.updateGoogleFromNotion(task, event, currentNotionHash, stats);
      return;
    }

    await this.state.upsert(task.pageId, {
      googleEventId: event.eventId,
      lastNotionHash: currentNotionHash,
      lastGoogleHash: currentGoogleHash,
      lastNotionEditedTime: task.lastEditedTime,
      lastGoogleUpdated: event.updated,
      syncStatus: "synced",
      lastError: "",
    });
    stats.skipped += 1;
  }

  private async updateGoogleFromNotion(
    task: NotionTask,
    event: GoogleEvent,
    currentNotionHash: string,
    stats: SyncStats,
  ): Promise<void> {
    const body = notionTaskToGoogleBody(task);
    let updated: GoogleEvent;
    try {
      updated = await this.google.updateEvent(event.eventId, body);
    } catch (error) {
      if (!(error instanceof GoogleCalendarError) || error.statusCode !== 400) throw error;
      await this.google.deleteEvent(event.eventId);
      updated = await this.google.createEvent(body);
    }
    await this.state.upsert(task.pageId, {
      googleEventId: updated.eventId,
      lastNotionHash: currentNotionHash,
      lastGoogleHash: await googleHash(updated),
      lastNotionEditedTime: task.lastEditedTime,
      lastGoogleUpdated: updated.updated,
      syncStatus: "synced",
      lastError: "",
    });
    stats.updated_google += 1;
  }
}

export function classifySyncError(error: unknown): ErrorKind {
  const status = error instanceof ApiError || error instanceof GoogleCalendarError ? error.statusCode : 0;
  const message = errorMessage(error);
  if (message.includes("Too many subrequests")) return "retryable";
  if (status === 401 || status === 403) return "config";
  if (status === 408 || status === 409 || status === 429 || status >= 500) return "retryable";
  if (status >= 400) return "manual";
  if (error instanceof TypeError) return "retryable";
  return "retryable";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newStats(phase: "tasks" | "cleanup"): SyncStats {
  return {
    ok: true,
    phase,
    processed: 0,
    created: 0,
    updated_google: 0,
    updated_notion: 0,
    deleted_google: 0,
    cleared_notion_dates: 0,
    retryable_errors: 0,
    manual_conflicts: 0,
    skipped: 0,
  };
}

function prioritizeCalendarTasks(tasks: NotionTask[]): NotionTask[] {
  return [...tasks].sort((left, right) => taskPriority(left) - taskPriority(right));
}

function taskPriority(task: NotionTask): number {
  if (task.doStart && !isCompleted(task)) return 0;
  if (!task.doStart && !isCompleted(task)) return 1;
  return 2;
}
