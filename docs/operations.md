# Operations

This document covers day-to-day operation of the Cloudflare Worker deployment.

## Quick Health Check

Open:

```text
https://<your-sync-host>/health
```

Healthy response:

```json
{
  "ok": true,
  "missing": [],
  "calendar_id_set": true,
  "public_base_url_set": true,
  "google_webhook_token_set": true,
  "queue_binding_set": true
}
```

If `ok` is false, configure the missing secret or binding before running sync.

## Manual Sync

Run one sync batch:

```bash
curl -fsS "https://<your-sync-host>/sync?token=<SYNC_SECRET>"
```

If the response contains `"has_more": true`, more batches are needed. Either repeat the request or let Queue continuation jobs finish the scan.

Important response counters:

- `created`: Google events created from Notion tasks.
- `updated_google`: Google events updated from Notion.
- `updated_notion`: Notion tasks updated from Google event edits.
- `deleted_google`: Google events removed because Notion says they should not exist.
- `retryable_errors`: transient failures that should retry.
- `manual_conflicts`: items that need human investigation.
- `skipped`: items already in sync.

## Inspect Recent Runs

```bash
curl -fsS "https://<your-sync-host>/runs?token=<SYNC_SECRET>"
```

Use this after deploys, webhook changes, or large Notion edits to confirm batches are completing.

## Inspect Conflicts

```bash
curl -fsS "https://<your-sync-host>/conflicts?token=<SYNC_SECRET>"
```

`/conflicts` is intended for real manual data conflicts. Retryable infrastructure/API failures should not remain there.

## Renew Google Watch

```bash
curl -fsS "https://<your-sync-host>/google/watch/renew?token=<SYNC_SECRET>"
```

Then confirm the active channel:

```bash
curl -fsS "https://<your-sync-host>/webhook-channels?token=<SYNC_SECRET>"
```

The daily Cron Trigger renews the watch automatically, but manual renewal is useful after deploys, credential changes, or calendar permission changes.

## Cloudflare Logs

Use Wrangler to tail production logs:

```bash
npx wrangler tail
```

Watch for:

- `sync enqueued`
- `queue sync completed`
- `queue sync failed`
- `renew`

Transient `retryable` failures can be normal during API rate limits. Repeated `config` failures usually mean credentials, permissions, or secrets are wrong.

## Deploy Checklist

Before deploy:

```bash
npm run typecheck
npm run test:worker
```

Deploy:

```bash
npm run deploy:worker
```

After deploy:

1. Check `/health`.
2. Run `/sync?token=<SYNC_SECRET>`.
3. Confirm `/runs?token=<SYNC_SECRET>` shows the new run.
4. Renew the Google watch if webhook behavior changed.
5. Tail logs for several batches if the deploy touched sync behavior.

## D1 Migrations

Apply remote migrations:

```bash
npm run d1:migrate:remote
```

Do not import old legacy SQLite state into D1 unless that is explicitly requested. Cloudflare D1 is the fresh production state for the Worker.

## Common Issues

### `/health` reports missing config

Set the missing Worker secret with:

```bash
npx wrangler secret put <NAME>
```

For non-secret values, update `wrangler.toml` and redeploy.

### Google events are not being created

Check:

- the Notion task has `Do Date`,
- the task is not completed,
- `Synced with Google` is not `deleted`,
- the related Course page has `Registration` checked,
- the Worker can access the Notion task and related Course page,
- `/runs` does not show repeated config failures.

### Google-deleted events keep staying deleted

That is expected while the Notion task has `Synced with Google = deleted`. Change that Notion property if the event should be recreated.

### Google webhook stopped firing

Run `/google/watch/renew`, inspect `/webhook-channels`, and tail logs. Google watch channels expire and must be renewed.

### Notion webhook verification fails

Confirm the subscription URL is:

```text
https://<your-sync-host>/webhooks/notion
```

If needed, delete the stored D1 verification token or set `NOTION_WEBHOOK_VERIFICATION_TOKEN` explicitly as a Worker secret.
