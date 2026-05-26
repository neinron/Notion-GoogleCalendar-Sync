import { GoogleCalendarClient, NotionClient } from "./clients";
import { D1State } from "./state";
import { classifySyncError, errorMessage, SyncEngine } from "./sync";
import type { Env, SyncStats } from "./types";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function missingRequired(env: Env): string[] {
  const required: Record<string, string | undefined> = {
    NOTION_API_KEY: env.NOTION_API_KEY,
    DATABASE_ID: env.DATABASE_ID,
    GOOGLE_CALENDAR_ID: env.GOOGLE_CALENDAR_ID,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: env.GOOGLE_REFRESH_TOKEN,
    SYNC_SECRET: env.SYNC_SECRET,
  };
  return Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
}

export function requireToken(request: Request, env: Env): Response | null {
  if (!env.SYNC_SECRET) return json({ ok: false, error: "SYNC_SECRET is not configured" }, 503);
  const url = new URL(request.url);
  const supplied = url.searchParams.get("token") || request.headers.get("X-Sync-Token") || "";
  return constantTimeEqual(supplied, env.SYNC_SECRET) ? null : json({ ok: false, error: "invalid sync token" }, 403);
}

export async function runSync(env: Env, request?: Request): Promise<Response> {
  const missing = missingRequired(env);
  if (missing.length) return json({ ok: false, missing }, 503);

  const url = request ? new URL(request.url) : null;
  const rawLimit = url?.searchParams.get("limit");
  const rawCleanupLimit = url?.searchParams.get("cleanup_limit");
  const limit = rawLimit ? Number(rawLimit) : 6;
  const cleanupLimit = rawCleanupLimit ? Number(rawCleanupLimit) : 10;

  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return json({ ok: false, error: "invalid limit", allowed: "1-20" }, 400);
  }
  if (!Number.isInteger(cleanupLimit) || cleanupLimit < 0 || cleanupLimit > 20) {
    return json({ ok: false, error: "invalid cleanup_limit", allowed: "0-20" }, 400);
  }

  try {
    return json(await runSyncJob(env, "manual", { limit, cleanupLimit }));
  } catch (error) {
    const kind = classifySyncError(error);
    const message = errorMessage(error);
    const status = message === "sync already running" ? 423 : kind === "config" ? 503 : 500;
    return json({ ok: false, error: message, kind }, status);
  }
}

export async function runSyncJob(
  env: Env,
  source: string,
  options: { limit?: number; cleanupLimit?: number } = {},
): Promise<SyncStats> {
  const missing = missingRequired(env);
  if (missing.length) throw new Error(`missing required configuration: ${missing.join(", ")}`);
  const state = new D1State(env.DB);
  const owner = crypto.randomUUID();

  if (!(await state.acquireLock("sync_lock", owner))) {
    throw new Error("sync already running");
  }

  const runId = crypto.randomUUID();
  let runCreated = false;
  try {
    await state.createRun(runId, source);
    runCreated = true;
    const engine = new SyncEngine(state, new NotionClient(env), new GoogleCalendarClient(env));
    const stats = await engine.sync(options);
    const status = stats.retryable_errors || stats.manual_conflicts ? "partial" : stats.has_more ? "more" : "success";
    await state.finishRun(runId, status, stats, stats.error ?? "");
    return stats;
  } catch (error) {
    if (runCreated) await state.finishRun(runId, classifySyncError(error), null, errorMessage(error));
    throw error;
  } finally {
    await state.releaseLock("sync_lock", owner);
  }
}

export async function enqueueSync(env: Env, reason: string): Promise<boolean> {
  if (!env.SYNC_QUEUE) return false;
  await env.SYNC_QUEUE.send({ type: "sync", reason });
  return true;
}

export async function renewGoogleWatch(env: Env): Promise<Response> {
  const missing = missingRequired(env).concat(!env.PUBLIC_BASE_URL ? ["PUBLIC_BASE_URL"] : [], !env.GOOGLE_WEBHOOK_TOKEN ? ["GOOGLE_WEBHOOK_TOKEN"] : []);
  if (missing.length) return json({ ok: false, missing }, 503);
  const state = new D1State(env.DB);
  const google = new GoogleCalendarClient(env);
  const previous = await state.listWebhookChannels();
  let stoppedPrevious = 0;
  for (const channel of previous) {
    try {
      await google.stopChannel(channel.channel_id, channel.resource_id);
      stoppedPrevious += 1;
    } catch (error) {
      console.warn("failed to stop google watch channel", channel.channel_id, error);
    }
  }
  const channel = await google.watchEvents();
  await state.upsertWebhookChannel({
    channelId: channel.id ?? "",
    resourceId: channel.resourceId ?? "",
    resourceUri: channel.resourceUri ?? "",
    calendarId: env.GOOGLE_CALENDAR_ID,
    expiration: String(channel.expiration ?? ""),
    tokenHint: "configured",
  });
  return json({ ok: true, channel, stopped_previous: stoppedPrevious });
}

export async function notionSignatureValid(secret: string, body: string, supplied: string): Promise<boolean> {
  return constantTimeEqual(await hmacSha256(secret, body), supplied);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(left || "");
  const b = enc.encode(right || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacSha256(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(sig)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
