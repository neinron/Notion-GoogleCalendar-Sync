import type { GoogleEvent, NotionTask } from "./types";

const COMPLETED_STATUSES = new Set([
  "done",
  "complete",
  "completed",
  "erledigt",
  "fertig",
  "abgeschlossen",
  "archived",
  "archiviert",
]);

export function isCompleted(task: NotionTask): boolean {
  return COMPLETED_STATUSES.has(task.status.trim().toLowerCase());
}

export function stableHash(data: unknown): string {
  return sha256Hex(canonicalJson(data));
}

export async function stableHashAsync(data: unknown): Promise<string> {
  return sha256HexAsync(canonicalJson(data));
}

function canonicalJson(data: unknown): string {
  if (Array.isArray(data)) {
    return `[${data.map(canonicalJson).join(",")}]`;
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(data);
}

function sha256Hex(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i += 1) {
    hash = (Math.imul(31, hash) + data.charCodeAt(i)) | 0;
  }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

async function sha256HexAsync(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function titlePlain(prop: any): string {
  return ((prop?.title ?? []) as any[]).map((part) => part?.plain_text ?? "").join("").trim();
}

function selectName(prop: any, key = "select"): string {
  const value = prop?.[key];
  return typeof value?.name === "string" ? value.name : "";
}

function relationIds(prop: any): string[] {
  return ((prop?.relation ?? []) as any[]).map((item) => item?.id).filter(Boolean);
}

export function parseNotionTask(page: any): NotionTask {
  const props = page?.properties ?? {};
  const doDate = props["Do Date"]?.date ?? {};
  const dueDate = props["Due Date"]?.date ?? {};
  const doStart = typeof doDate?.start === "string" ? doDate.start : "";
  return {
    pageId: page?.id ?? "",
    url: page?.url ?? "",
    title: titlePlain(props.Name) || "Untitled",
    status: selectName(props.Status, "status"),
    taskType: selectName(props.Type),
    priority: selectName(props.Priority),
    course: relationIds(props.Course).join(","),
    googleSyncStatus: selectName(props["Synced with Google"]).toLowerCase(),
    dueStart: typeof dueDate?.start === "string" ? dueDate.start : "",
    doStart,
    doEnd: typeof doDate?.end === "string" ? doDate.end : "",
    doIsDatetime: Boolean(doStart && doStart.includes("T")),
    lastEditedTime: page?.last_edited_time ?? "",
    raw: page,
  };
}

export async function notionHash(task: NotionTask): Promise<string> {
  return stableHashAsync({
    title: task.title,
    status: task.status,
    task_type: task.taskType,
    priority: task.priority,
    course: task.course,
    google_sync_status: task.googleSyncStatus,
    due_start: task.dueStart,
    do_start: task.doStart,
    do_end: task.doEnd,
    do_is_datetime: task.doIsDatetime,
  });
}

export function eventDescription(task: NotionTask): string {
  const parts = [`Notion: ${task.url}`, `Status: ${task.status}`];
  if (task.taskType) parts.push(`Type: ${task.taskType}`);
  if (task.priority) parts.push(`Priority: ${task.priority}`);
  if (task.course) parts.push(`Course: ${task.course}`);
  if (task.dueStart) parts.push(`Due Date: ${task.dueStart}`);
  return parts.join("\n");
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateTime(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function localIsoWithoutMs(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function hasExplicitTimezone(value: string): boolean {
  if (value.endsWith("Z")) return true;
  const timePart = value.split("T", 2)[1] ?? "";
  return timePart.includes("+") || timePart.includes("-");
}

function defaultEnd(start: string): string {
  if (!start) return "";
  if (!start.includes("T")) {
    const parsed = parseDate(start);
    if (!parsed) return start;
    parsed.setUTCDate(parsed.getUTCDate() + 1);
    return isoDate(parsed);
  }
  const parsed = parseDateTime(start);
  if (!parsed) return start;
  return addOneHourPreservingIsoShape(start);
}

function normalizedEnd(start: string, end: string): string {
  const fallback = defaultEnd(start);
  if (!start || !end) return fallback;
  if (!start.includes("T")) {
    const startDate = parseDate(start);
    const endDate = parseDate(end);
    return startDate && endDate && endDate > startDate ? end : fallback;
  }
  const startDateTime = parseDateTime(start);
  const endDateTime = parseDateTime(end);
  return startDateTime && endDateTime && endDateTime > startDateTime ? end : fallback;
}

function addOneHourPreservingIsoShape(value: string): string {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
  );
  if (!match) return localIsoWithoutMs(new Date(new Date(value).getTime() + 60 * 60 * 1000));
  const [, year, month, day, hour, minute, second, zone = ""] = match;
  if (zone === "Z") {
    return localIsoWithoutMs(new Date(Date.parse(value) + 60 * 60 * 1000));
  }
  const offsetMinutes = zone
    ? Number(zone.slice(0, 3)) * 60 + Number(`${zone[0]}${zone.slice(4, 6)}`)
    : 0;
  const localAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const shifted = new Date(localAsUtc + 60 * 60 * 1000);
  if (!zone) return shifted.toISOString().slice(0, 19);
  const wallClock = new Date(Date.parse(value) + offsetMinutes * 60 * 1000 + 60 * 60 * 1000);
  return `${wallClock.toISOString().slice(0, 19)}${zone}`;
}

export function notionTaskToGoogleBody(task: NotionTask, timeZone = "Europe/Berlin"): Record<string, unknown> {
  const isAllDay = Boolean(task.doStart && !task.doStart.includes("T"));
  const key = isAllDay ? "date" : "dateTime";
  const body: Record<string, unknown> = {
    summary: task.title,
    description: eventDescription(task),
    extendedProperties: { private: { notion_page_id: task.pageId } },
  };
  if (task.doStart) {
    body.start = { [key]: task.doStart };
    body.end = { [key]: normalizedEnd(task.doStart, task.doEnd) };
    if (!isAllDay && !hasExplicitTimezone(task.doStart)) {
      body.start = { ...(body.start as Record<string, string>), timeZone };
      body.end = { ...(body.end as Record<string, string>), timeZone };
    }
  }
  return body;
}

export function parseGoogleEvent(event: any): GoogleEvent {
  const privateProps = event?.extendedProperties?.private ?? {};
  const start = event?.start ?? {};
  const end = event?.end ?? {};
  return {
    eventId: event?.id ?? "",
    notionPageId: privateProps.notion_page_id ?? "",
    title: event?.summary ?? "",
    description: event?.description ?? "",
    start: start.dateTime ?? start.date ?? "",
    end: end.dateTime ?? end.date ?? "",
    isAllDay: "date" in start,
    updated: event?.updated ?? "",
    status: event?.status ?? "",
    raw: event,
  };
}

export async function googleHash(event: GoogleEvent): Promise<string> {
  return stableHashAsync({
    title: event.title,
    description: event.description,
    start: event.start,
    end: event.end,
    is_all_day: event.isAllDay,
    status: event.status,
  });
}

export function googleEventToNotionProperties(event: GoogleEvent): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Name: { title: [{ text: { content: event.title || "Untitled" } }] },
  };
  props["Do Date"] = event.start ? { date: { start: event.start, end: event.end || null } } : { date: null };
  return props;
}

export function desiredGoogleEvent(eventId: string, task: NotionTask, existing: GoogleEvent): GoogleEvent {
  const body = notionTaskToGoogleBody(task);
  const start = body.start as Record<string, string> | undefined;
  const end = body.end as Record<string, string> | undefined;
  return {
    eventId,
    notionPageId: task.pageId,
    title: String(body.summary ?? ""),
    description: String(body.description ?? ""),
    start: start?.dateTime ?? start?.date ?? "",
    end: end?.dateTime ?? end?.date ?? "",
    isAllDay: Boolean(start && "date" in start),
    updated: existing.updated,
    status: existing.status,
    raw: {},
  };
}
