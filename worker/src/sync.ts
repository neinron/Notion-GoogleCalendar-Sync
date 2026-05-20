import { GoogleCalendarClient, GoogleCalendarError, NotionClient } from "./clients";
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

export class SyncEngine {
  constructor(
    private readonly state: D1State,
    private readonly notion: NotionClient,
    private readonly google: GoogleCalendarClient,
  ) {}

  async sync(): Promise<SyncStats> {
    const tasks = new Map((await this.notion.listTasks()).map((task) => [task.pageId, task]));
    const events = new Map((await this.google.listEvents()).map((event) => [event.notionPageId, event]));
    const stats: SyncStats = {
      ok: true,
      created: 0,
      updated_google: 0,
      updated_notion: 0,
      deleted_google: 0,
      cleared_notion_dates: 0,
      conflicts: 0,
      skipped: 0,
    };

    for (const [pageId, task] of tasks) {
      try {
        await this.syncTask(task, events.get(pageId) ?? null, stats);
      } catch (error) {
        await this.state.markConflict(pageId, events.get(pageId)?.eventId ?? null, error instanceof Error ? error.message : String(error));
        stats.conflicts += 1;
      }
    }

    for (const [pageId, event] of events) {
      if (!tasks.has(pageId) && event.status !== "cancelled") {
        await this.google.deleteEvent(event.eventId);
        stats.deleted_google += 1;
      }
    }

    return stats;
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
