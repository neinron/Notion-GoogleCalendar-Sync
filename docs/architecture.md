# Architecture and Sync Model

This document explains how the Cloudflare Worker syncs Notion tasks with Google Calendar and why the sync rules are intentionally conservative.

## System Boundary

The service has one job: reflect planned Notion tasks into one dedicated Google Calendar and write safe calendar scheduling edits back to Notion.

Notion remains the product and planning source of truth. Google Calendar is a scheduling surface. That means the Worker may update a task title or `Do Date` from a moved Google event, but it does not infer task completion, deletion, or course enrollment from Google.

## Runtime Components

- `worker/src/index.ts`: HTTP routing, webhook handling, scheduled jobs, and Queue consumer.
- `worker/src/sync.ts`: core sync engine and conflict/retry classification.
- `worker/src/serialize.ts`: conversion between Notion pages and Google events.
- `worker/src/clients.ts`: Notion and Google API clients.
- `worker/src/state.ts`: D1 persistence for mappings, cursors, run logs, and webhook channel metadata.
- `migrations/`: D1 schema migrations.

Production runtime:

- Cloudflare Worker serves `https://notionsync.jaronschurer.com`.
- D1 binding `DB` stores technical state.
- Queue binding `SYNC_QUEUE` handles background sync jobs and retries.
- Cron Triggers provide a 15-minute safety sync and daily Google watch renewal.

## Data Ownership

Notion owns:

- Task existence.
- Task completion status.
- Course relation and registration eligibility.
- Whether a Google-deleted task should stay deleted via `Synced with Google = deleted`.
- The canonical value when Notion and Google both changed since the last successful sync.

Google Calendar owns:

- User-driven scheduling edits when Notion has not also changed.
- Event start/end values for moved synced events.
- Event title edits for renamed synced events.

D1 owns only technical sync state:

- Notion page ID to Google event ID mappings.
- Last synced Notion and Google hashes.
- Last edited timestamps.
- Batch cursors and scan markers.
- Run summaries, retry state, manual conflict state, and Google webhook channel metadata.

D1 is not an application database for tasks.

## Sync Model

Each sync run processes a small batch to stay within Cloudflare Worker subrequest limits.

The sync has two phases:

1. `tasks`: scan Notion tasks, compare each task with its matching Google event, and create/update/delete as needed.
2. `cleanup`: remove Google events whose Notion task was not seen in the latest complete scan.

If a batch has more work, the Worker records cursors in D1 and enqueues a continuation job.

## Task Eligibility

A task is eligible for Google Calendar when all of these are true:

- The task exists in the configured Notion database.
- The task has a `Do Date`.
- The task is not completed.
- The task is related to at least one registered Course page.
- `Synced with Google` is not `deleted`.

The Course page must have `Registration` checked. `Registered` is accepted as a fallback property name.

## Event Identity

Google events created by this service include:

```text
extendedProperties.private.notion_page_id=<notion page id>
```

That private property is the durable link from Google back to Notion. Event titles, descriptions, or times are not used as identity.

## Change Detection

The Worker computes stable hashes for the Notion task fields and Google event fields it cares about.

Tracked Notion fields include:

- `Name`
- `Status`
- `Type`
- `Priority`
- `Course`
- Course names used in event descriptions
- `Synced with Google`
- `Due Date`
- `Do Date`

Tracked Google fields include:

- Summary
- Description
- Start/end
- All-day versus timed event
- Status

The hashes let the Worker detect whether Notion changed, Google changed, both changed, or neither changed since the last successful sync.

## Conflict Policy

When Notion and Google both changed since the last successful sync, Notion wins. The Worker updates or recreates the Google event from the Notion task.

Manual conflicts are reserved for non-retryable data/API problems that need human attention. Transient failures such as rate limits, network errors, 5xx responses, and Cloudflare subrequest limits become `retry_pending` and are retried by Queue.

## Delete Semantics

Deleting a Google event does not delete or complete the Notion task.

Instead:

- The Worker marks the Notion task as `Synced with Google = deleted`.
- The deleted state prevents automatic recreation of the Google event.
- Changing the Notion sync status away from `deleted` allows recreation if the task is otherwise eligible.

Completing a Notion task or removing `Do Date` removes the Google event, because those actions originate from Notion.

## Time Handling

All-day Notion dates become all-day Google events.

Timed Notion dates become timed Google events. If the Notion timestamp does not include an explicit timezone, the Worker uses `GOOGLE_TIME_ZONE` from `wrangler.toml`, currently `Europe/Berlin`.

If a Notion `Do Date` has no end value, the Worker uses:

- next day for all-day events,
- one hour later for timed events.

## Reliability Notes

Webhooks are triggers, not the full source of truth. The periodic safety sync is what makes the system resilient to missed webhooks, temporary API failures, or expired channels.

Google watch channels expire. The daily Cron Trigger calls the watch-renewal flow and records active channel metadata in D1.

Notion webhook verification tokens are stored in D1 automatically when Notion sends the setup probe. The token can also be supplied as `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
