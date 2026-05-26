import { parseGoogleEvent, parseNotionTask } from "./serialize";
import type { Env, GoogleEvent, NotionTask } from "./types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

export class NotionClient {
  constructor(private readonly env: Env) {}

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.env.NOTION_API_KEY}`,
      "Notion-Version": this.env.NOTION_VERSION || "2022-06-28",
      "Content-Type": "application/json",
    };
  }

  async listTasksPage(options: { startCursor?: string; pageSize?: number } = {}): Promise<{
    tasks: NotionTask[];
    nextCursor: string;
    hasMore: boolean;
  }> {
    const body: Record<string, unknown> = { page_size: options.pageSize ?? 10 };
    if (options.startCursor) body.start_cursor = options.startCursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${this.env.DATABASE_ID}/query`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    await assertOk(res, "Notion database query failed");
    const data: any = await res.json();
    if (!Array.isArray(data.results)) throw new Error("Notion query returned invalid results");
    if (data.has_more && !data.next_cursor) throw new Error("Notion query has_more without next_cursor");
    return {
      tasks: data.results.map(parseNotionTask),
      nextCursor: data.next_cursor ?? "",
      hasMore: Boolean(data.has_more),
    };
  }

  async courseRegistered(courseId: string): Promise<boolean> {
    return courseIsRegistered(await this.retrievePage(courseId));
  }

  private async retrievePage(pageId: string): Promise<any> {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: this.headers(),
    });
    await assertOk(res, "Notion page retrieval failed");
    return await res.json();
  }

  async updatePageProperties(pageId: string, properties: Record<string, unknown>): Promise<any> {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ properties }),
    });
    await assertOk(res, "Notion page update failed");
    return await res.json();
  }

  async setGoogleSyncStatus(pageId: string, status: "synced" | "deleted"): Promise<any> {
    return await this.updatePageProperties(pageId, {
      "Synced with Google": { select: { name: status } },
    });
  }
}

function courseIsRegistered(page: any): boolean {
  return page?.properties?.Registration?.checkbox === true || page?.properties?.Registered?.checkbox === true;
}

export class GoogleCalendarClient {
  private accessToken = "";

  constructor(private readonly env: Env) {}

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_CLIENT_ID,
        client_secret: this.env.GOOGLE_CLIENT_SECRET,
        refresh_token: this.env.GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    await assertOk(res, "Google OAuth token refresh failed");
    const data: any = await res.json();
    this.accessToken = data.access_token;
    return this.accessToken;
  }

  private async headers(): Promise<HeadersInit> {
    return { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" };
  }

  async listEvents(): Promise<GoogleEvent[]> {
    const events: GoogleEvent[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "2500" });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await fetch(`${CALENDAR_BASE}/calendars/${encodeURIComponent(this.env.GOOGLE_CALENDAR_ID)}/events?${params}`, {
        headers: await this.headers(),
      });
      await assertOk(res, "Google Calendar event listing failed");
      const data: any = await res.json();
      events.push(...(data.items ?? []).map(parseGoogleEvent));
      pageToken = data.nextPageToken ?? "";
    } while (pageToken);
    return events.filter((event) => event.notionPageId);
  }

  async createEvent(body: Record<string, unknown>): Promise<GoogleEvent> {
    const res = await fetch(`${CALENDAR_BASE}/calendars/${encodeURIComponent(this.env.GOOGLE_CALENDAR_ID)}/events`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(body),
    });
    await assertOk(res, "Google Calendar event creation failed");
    return parseGoogleEvent(await res.json());
  }

  async updateEvent(eventId: string, body: Record<string, unknown>): Promise<GoogleEvent> {
    const res = await fetch(`${CALENDAR_BASE}/calendars/${encodeURIComponent(this.env.GOOGLE_CALENDAR_ID)}/events/${eventId}`, {
      method: "PATCH",
      headers: await this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await GoogleCalendarError.fromResponse("Google Calendar event update failed", res);
    return parseGoogleEvent(await res.json());
  }

  async deleteEvent(eventId: string): Promise<void> {
    const res = await fetch(`${CALENDAR_BASE}/calendars/${encodeURIComponent(this.env.GOOGLE_CALENDAR_ID)}/events/${eventId}`, {
      method: "DELETE",
      headers: await this.headers(),
    });
    if (![200, 204, 404, 410].includes(res.status)) await assertOk(res, "Google Calendar event deletion failed");
  }

  async watchEvents(): Promise<any> {
    const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000;
    const res = await fetch(`${CALENDAR_BASE}/calendars/${encodeURIComponent(this.env.GOOGLE_CALENDAR_ID)}/events/watch`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({
        id: crypto.randomUUID(),
        type: "web_hook",
        address: `${this.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/google`,
        token: this.env.GOOGLE_WEBHOOK_TOKEN,
        expiration,
      }),
    });
    await assertOk(res, "Google Calendar watch registration failed");
    return await res.json();
  }

  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    if (!channelId || !resourceId) return;
    const res = await fetch(`${CALENDAR_BASE}/channels/stop`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ id: channelId, resourceId }),
    });
    if (![200, 204, 404, 410].includes(res.status)) await assertOk(res, "Google Calendar channel stop failed");
  }
}

async function assertOk(res: Response, message: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text();
  throw new ApiError(message, res.status, body);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly responseBody: string,
  ) {
    super(`${message}: ${statusCode} ${responseBody.slice(0, 500)}`);
  }
}

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly responseBody: string,
  ) {
    super(`${message}: ${statusCode} ${responseBody.slice(0, 500)}`);
  }

  static async fromResponse(message: string, res: Response): Promise<GoogleCalendarError> {
    return new GoogleCalendarError(message, res.status, await res.text());
  }
}
