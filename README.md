# Notion Calendar Sync

Cloudflare Worker service that syncs a Notion task database with one dedicated Google Calendar at:

```text
https://notionsync.jaronschurer.com
```

The legacy Flask/PythonAnywhere service remains in this repository as a temporary fallback during cutover.

The old ICS feed has been removed. Google Calendar now stores real events, and the service writes safe changes back to Notion.

## Behavior

- Notion tasks with `Do Date` become Google Calendar events.
- Google events store `extendedProperties.private.notion_page_id`.
- Moving or editing a synced Google event updates the Notion task.
- Deleting a Google event does not delete or complete the Notion task; it clears the task's `Do Date`.
- Completed Notion tasks remove their Google events.
- Only tasks related to a Notion course page where `Registration` is checked are synced; `Registered` is accepted as a fallback property name. Events for tasks from unregistered courses are removed from Google.
- If Notion and Google both changed since the last successful sync, Notion wins and the Google event is rebuilt from the Notion task.

## Cloudflare Worker Runtime

- HTTP/webhook runtime: Cloudflare Workers.
- State: fresh D1 database bound as `DB`.
- Async work: Cloudflare Queue bound as `SYNC_QUEUE`; webhooks enqueue sync jobs and return quickly.
- Secrets: Cloudflare Worker Secrets.
- Public hostname: `notionsync.jaronschurer.com`.
- Cron Triggers: every 15 minutes enqueue a safety sync, and daily at 03:07 UTC renews the Google watch plus enqueues a safety sync.

## Required Worker Secrets

```env
NOTION_API_KEY=secret_...
DATABASE_ID=...

GOOGLE_CALENDAR_ID=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

SYNC_SECRET=long-random-secret
GOOGLE_WEBHOOK_TOKEN=long-random-secret
```

Optional:

```env
NOTION_WEBHOOK_VERIFICATION_TOKEN=secret_from_notion_after_subscription_probe
```

`PUBLIC_BASE_URL=https://notionsync.jaronschurer.com`, `NOTION_VERSION`, and `GOOGLE_TIME_ZONE` are non-secret Worker vars in `wrangler.toml`.

## Worker Development

```bash
npm install
npm run typecheck
npm run test:worker
```

Create the D1 database, copy the returned `database_id` into `wrangler.toml`, and apply migrations:

```bash
npx wrangler d1 create notion_calendar_sync
npx wrangler queues create notion-calendar-sync
npm run d1:migrate:remote
```

Set production secrets:

```bash
npx wrangler secret put NOTION_API_KEY
npx wrangler secret put DATABASE_ID
npx wrangler secret put GOOGLE_CALENDAR_ID
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put SYNC_SECRET
npx wrangler secret put GOOGLE_WEBHOOK_TOKEN
```

Generate a fresh `GOOGLE_WEBHOOK_TOKEN`; do not reuse tokens from chats, logs, or old environments.

Deploy:

```bash
npm run deploy:worker
```

`wrangler.toml` binds the Worker route for `notionsync.jaronschurer.com/*`. SSL is Cloudflare-managed.

## Cutover Checklist

1. Deploy the Worker and confirm `GET https://notionsync.jaronschurer.com/health` returns `ok: true`.
2. Run `GET /sync?token=<SYNC_SECRET>` manually; repeat while `has_more: true`, or let the Queue continuation jobs drain it.
3. Run `GET /google/watch/renew?token=<SYNC_SECRET>`.
4. Confirm `GET /webhook-channels?token=<SYNC_SECRET>` shows an active Google channel.
5. Change the Notion webhook subscription to `https://notionsync.jaronschurer.com/webhooks/notion` and complete verification.
6. Watch Worker logs for the first 24 hours.
7. Disable PythonAnywhere scheduled tasks and webhooks only after Cloudflare sync and webhooks are stable.

## HTTP Endpoints

- `GET /health`: configuration and state health.
- `GET|POST /sync?token=...`: run one budgeted sync batch.
- `GET /conflicts?token=...`: list unresolved manual conflicts only.
- `GET /runs?token=...`: list recent sync run summaries.
- `POST /webhooks/google`: Google Calendar push notification receiver; enqueues a sync job.
- `POST /webhooks/notion`: Notion webhook receiver; enqueues a sync job.
- `GET|POST /google/watch/renew?token=...`: replace the Google Calendar events watch channel.
- `GET /webhook-channels?token=...`: list registered Google watch channels.

## Webhooks

### Google Calendar

Register or renew the channel:

```bash
curl -fsS "https://notionsync.jaronschurer.com/google/watch/renew?token=<SYNC_SECRET>"
```

Google sends `sync` notifications first; the Worker acknowledges those without running a sync. Later `exists` notifications enqueue the normal sync engine.

Google watch channels expire. The daily Cron Trigger renews them; `/webhook-channels` shows the active channel metadata.

### Notion

Create a Notion webhook subscription pointing to:

```text
https://notionsync.jaronschurer.com/webhooks/notion
```

Notion will POST a one-time `verification_token`. The Worker stores it in D1 automatically. You can also set `NOTION_WEBHOOK_VERIFICATION_TOKEN` as a Worker secret if you prefer env-only configuration.

Future Notion webhook payloads must include a matching `X-Notion-Signature`; otherwise the Worker rejects them.

## Sync Reliability Model

The Worker processes small batches so it stays under Cloudflare subrequest limits. It stores Notion pagination progress in D1, then runs a separate cleanup phase for Google events that were not seen in the last completed Notion scan.

Runtime/API failures such as subrequest limits, rate limits, network errors, and 5xx responses are marked `retry_pending` and retried by the Queue. `/conflicts` is reserved for real manual data conflicts. Course registration is read from the related Course page's `Registration` checkbox and cached in D1 for six hours.

If old rows were marked as `conflict` by a previous subrequest failure, migration `0002_robust_sync.sql` resets those rows to `retry_pending` and clears stale cursors.

## PythonAnywhere Fallback

The Flask service is legacy fallback only. It still supports the same sync model, plus the old GitHub `/update` auto-deploy route for PythonAnywhere.

Local fallback development:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

Python fallback tests:

```bash
python -m unittest discover -s tests
```
