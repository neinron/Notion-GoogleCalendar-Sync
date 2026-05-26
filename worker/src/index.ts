import { D1State } from "./state";
import type { Env } from "./types";
import {
  constantTimeEqual,
  enqueueSync,
  json,
  missingRequired,
  notionSignatureValid,
  renewGoogleWatch,
  requireToken,
  runSync,
  runSyncJob,
} from "./http";
import { classifySyncError, errorMessage } from "./sync";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return json({ ok: true, service: "notion-calendar-sync-worker" });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      const missing = missingRequired(env);
      return json(
        {
          ok: missing.length === 0,
          missing,
          calendar_id_set: Boolean(env.GOOGLE_CALENDAR_ID),
          public_base_url_set: Boolean(env.PUBLIC_BASE_URL),
          google_webhook_token_set: Boolean(env.GOOGLE_WEBHOOK_TOKEN),
          queue_binding_set: Boolean(env.SYNC_QUEUE),
        },
        missing.length ? 503 : 200,
      );
    }

    if (url.pathname === "/sync" && ["GET", "POST"].includes(request.method)) {
      const tokenError = requireToken(request, env);
      if (tokenError) return tokenError;
      return await runSync(env, request);
    }

    if (url.pathname === "/conflicts" && request.method === "GET") {
      const tokenError = requireToken(request, env);
      if (tokenError) return tokenError;
      return json({ ok: true, conflicts: await new D1State(env.DB).listConflicts() });
    }

    if (url.pathname === "/webhook-channels" && request.method === "GET") {
      const tokenError = requireToken(request, env);
      if (tokenError) return tokenError;
      return json({ ok: true, channels: await new D1State(env.DB).listWebhookChannels() });
    }

    if (url.pathname === "/runs" && request.method === "GET") {
      const tokenError = requireToken(request, env);
      if (tokenError) return tokenError;
      return json({ ok: true, runs: await new D1State(env.DB).listRuns() });
    }

    if (url.pathname === "/google/watch/renew" && ["GET", "POST"].includes(request.method)) {
      const tokenError = requireToken(request, env);
      if (tokenError) return tokenError;
      return await renewGoogleWatch(env);
    }

    if (url.pathname === "/webhooks/google" && request.method === "POST") {
      if (!env.GOOGLE_WEBHOOK_TOKEN) return json({ ok: false, error: "GOOGLE_WEBHOOK_TOKEN is not configured" }, 503);
      const supplied = request.headers.get("X-Goog-Channel-Token") || "";
      if (!constantTimeEqual(supplied, env.GOOGLE_WEBHOOK_TOKEN)) return json({ ok: false, error: "invalid google channel token" }, 403);
      const state = request.headers.get("X-Goog-Resource-State") || "";
      if (state === "sync") return json({ ok: true, ignored: true, reason: "channel sync notification" }, 202);
      ctx.waitUntil(kickSync(env, "google-webhook"));
      return json({ ok: true, accepted: true }, 202);
    }

    if (url.pathname === "/webhooks/notion" && request.method === "POST") {
      const body = await request.text();
      const payload = body ? JSON.parse(body) : {};
      const state = new D1State(env.DB);
      if (payload.verification_token) {
        await state.setSetting("notion_webhook_verification_token", payload.verification_token);
        return json({ ok: true, verification_token_received: true, stored: true });
      }
      const secret = env.NOTION_WEBHOOK_VERIFICATION_TOKEN || (await state.getSetting("notion_webhook_verification_token"));
      if (!secret) return json({ ok: false, error: "NOTION_WEBHOOK_VERIFICATION_TOKEN is not configured" }, 503);
      if (!(await notionSignatureValid(secret, body, request.headers.get("X-Notion-Signature") || ""))) {
        return json({ ok: false, error: "invalid notion signature" }, 403);
      }
      ctx.waitUntil(kickSync(env, "notion-webhook"));
      return json({ ok: true, accepted: true }, 202);
    }

    return json({ ok: false, error: "not found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === "7 3 * * *") {
      ctx.waitUntil(renewGoogleWatch(env).then((res) => res.text()).then((body) => console.log("renew", body)));
    }
    ctx.waitUntil(kickSync(env, `cron:${controller.cron}`));
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body as { type?: string; reason?: string };
      if (body.type !== "sync") continue;
      try {
        const stats = await runSyncJob(env, `queue:${body.reason || "sync"}`);
        console.log(JSON.stringify({ message: "queue sync completed", reason: body.reason, stats }));
        if (stats.has_more) await enqueueSync(env, "continue");
      } catch (error) {
        const kind = classifySyncError(error);
        console.error(JSON.stringify({ message: "queue sync failed", kind, error: errorMessage(error) }));
        if (kind === "retryable") throw error;
      }
    }
  },
};

async function kickSync(env: Env, reason: string): Promise<void> {
  if (await enqueueSync(env, reason)) {
    console.log(JSON.stringify({ message: "sync enqueued", reason }));
    return;
  }
  const response = await runSync(env);
  console.log(JSON.stringify({ message: "sync ran without queue binding", reason, status: response.status, body: await response.text() }));
}
