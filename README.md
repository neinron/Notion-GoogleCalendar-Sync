# Notion Calendar Sync

This service keeps a Notion task database and one dedicated Google Calendar in sync.

The primary deployment is a Cloudflare Worker. Set the public URL through `PUBLIC_BASE_URL` and the route in `wrangler.toml`.

```text
https://<your-sync-host>
```

The older Flask/PythonAnywhere implementation has been moved to [neinron/python-notion-googlecalendar-sync](https://github.com/neinron/python-notion-googlecalendar-sync). New development in this repository should target the Cloudflare Worker.

## Why This Exists

Notion is the planning system: tasks, course relations, completion status, and the intended work date live there. Google Calendar is the execution surface: tasks that have a Notion `Do Date` should appear as real calendar events so they can be moved, edited, and seen alongside other commitments.

The sync is intentionally narrow:

- It syncs Notion tasks into one dedicated Google Calendar.
- It writes safe scheduling changes from Google Calendar back to Notion.
- It does not treat Google Calendar as the source for task completion, course registration, or task deletion.
- It avoids importing historic legacy SQLite state into Cloudflare D1 unless explicitly requested.

This replaced an older ICS feed. Google Calendar now contains real events with private metadata linking each event back to the Notion page.

## Current Architecture

```text
Notion task database
        |
        | Notion webhook + periodic scan
        v
Cloudflare Worker  <--- Google Calendar webhook
        |
        | D1 state: mappings, hashes, cursors, runs, channels
        | Queue: retryable/background sync work
        v
Dedicated Google Calendar
```

Runtime pieces:

- Cloudflare Worker handles HTTP endpoints, webhooks, Cron Triggers, and Queue consumers.
- Cloudflare D1 stores technical sync state only.
- Cloudflare Queue lets webhooks return quickly and retries transient failures.
- Worker secrets hold Notion and Google credentials.
- Cron Triggers enqueue a safety sync every 15 minutes and renew the Google watch daily at 03:07 UTC.

More detail: [docs/architecture.md](docs/architecture.md).

## Sync Rules

High-level behavior:

- A Notion task with a `Do Date` becomes a Google Calendar event.
- The Google event stores `extendedProperties.private.notion_page_id`.
- Moving or renaming a synced Google event updates the Notion task's `Do Date` and `Name`.
- Completing a Notion task removes its Google event.
- Removing `Do Date` from a Notion task removes its Google event.
- Deleting a Google event does not delete, complete, or unschedule the Notion task. Instead, Notion property `Synced with Google` is set to `deleted`.
- `Synced with Google = deleted` prevents the Worker from recreating the Google event until that Notion value is changed.
- If Notion and Google both changed since the last successful sync, Notion wins and the Google event is rebuilt from Notion.

Course filtering:

- Tasks sync only when they are related to at least one Course page where `Registration` is checked.
- `Registered` is accepted as a fallback property name.
- Events for tasks from unregistered courses are removed from Google.

Completion detection accepts status names such as `done`, `complete`, `completed`, `erledigt`, `fertig`, `abgeschlossen`, `archived`, and `archiviert`.

More detail: [docs/architecture.md](docs/architecture.md#sync-model).

## Repository Layout

```text
worker/src/        Cloudflare Worker source
worker/test/       Worker unit tests
migrations/        D1 schema migrations
docs/              Architecture and operations notes
wrangler.toml      Cloudflare Worker, D1, Queue, route, cron config
```

## Requirements

- Node.js and npm
- Wrangler CLI through project dependencies
- Cloudflare account with Workers, D1, and Queues enabled
- Notion integration with access to the task database and related Course pages
- Google OAuth client and refresh token for the dedicated calendar

Install dependencies:

```bash
npm install
```

## Configuration

Worker production secrets:

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

Optional secret:

```env
NOTION_WEBHOOK_VERIFICATION_TOKEN=secret_from_notion_after_subscription_probe
```

Non-secret Worker vars live in `wrangler.toml`:

- `PUBLIC_BASE_URL=https://<your-sync-host>`
- `NOTION_VERSION=2022-06-28`
- `GOOGLE_TIME_ZONE=Europe/Berlin`
- `DEPLOY_BRANCH=main`

Set production secrets with `wrangler secret put`. Do not commit secrets.

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

## Development

Run Worker checks:

```bash
npm run typecheck
npm run test:worker
```

Useful setup commands:

```bash
npx wrangler d1 create notion_calendar_sync
npm run queue:create
npm run d1:migrate:remote
```

Deploy:

```bash
npm run deploy:worker
```

`wrangler.toml` binds the Worker route for your configured host. SSL is Cloudflare-managed.

## Operational Endpoints

Token-protected endpoints require `?token=<SYNC_SECRET>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Basic service identity response. |
| `GET /health` | Configuration and binding health check. |
| `GET\|POST /sync?token=...` | Run one budgeted sync batch. |
| `GET /runs?token=...` | Recent sync run summaries. |
| `GET /conflicts?token=...` | Manual conflicts requiring attention. |
| `GET\|POST /google/watch/renew?token=...` | Replace the Google Calendar watch channel. |
| `GET /webhook-channels?token=...` | Registered Google watch channel metadata. |
| `POST /webhooks/google` | Google Calendar push receiver. |
| `POST /webhooks/notion` | Notion webhook receiver. |

More detail: [docs/operations.md](docs/operations.md).

## Webhook Setup

Google Calendar watch channel:

```bash
curl -fsS "https://<your-sync-host>/google/watch/renew?token=<SYNC_SECRET>"
```

Google sends an initial `sync` notification. The Worker acknowledges it without running a sync. Later `exists` notifications enqueue the normal sync engine.

Notion webhook target:

```text
https://<your-sync-host>/webhooks/notion
```

Notion sends a one-time `verification_token`. The Worker stores it in D1 automatically. Future Notion webhook payloads must include a matching `X-Notion-Signature`, or the Worker rejects them.

## Production Cutover Checklist

1. Deploy the Worker.
2. Confirm `GET https://<your-sync-host>/health` returns `ok: true`.
3. Run `GET /sync?token=<SYNC_SECRET>` manually. Repeat while `has_more: true`, or let Queue continuation jobs drain it.
4. Run `GET /google/watch/renew?token=<SYNC_SECRET>`.
5. Confirm `GET /webhook-channels?token=<SYNC_SECRET>` shows an active Google channel.
6. Change the Notion webhook subscription to `https://<your-sync-host>/webhooks/notion` and complete verification.
7. Watch Worker logs for the first 24 hours.
8. Disable old legacy scheduled tasks and webhooks only after Cloudflare sync and webhooks are stable.

## Legacy Python Implementation

The PythonAnywhere fallback/reference implementation lives in [neinron/python-notion-googlecalendar-sync](https://github.com/neinron/python-notion-googlecalendar-sync).
