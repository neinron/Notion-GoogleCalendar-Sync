# Notion Calendar Sync

Flask service for PythonAnywhere that syncs a Notion task database with one dedicated Google Calendar.

The old ICS feed has been removed. Google Calendar now stores real events, and the service writes safe changes back to Notion.

## Behavior

- Notion tasks with `Do Date` become Google Calendar events.
- Google events store `extendedProperties.private.notion_page_id`.
- Moving or editing a synced Google event updates the Notion task.
- Deleting a Google event does not delete or complete the Notion task; it clears the task's `Do Date`.
- Completed Notion tasks remove their Google events.
- If Notion and Google both changed since the last successful sync, the task is marked as a conflict and neither side is overwritten.

## Required Environment Variables

```env
NOTION_API_KEY=secret_...
DATABASE_ID=...

GOOGLE_CALENDAR_ID=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

SYNC_SECRET=long-random-secret
PUBLIC_BASE_URL=https://<user>.pythonanywhere.com
GOOGLE_WEBHOOK_TOKEN=long-random-secret
GITHUB_WEBHOOK_SECRET=long-random-secret
```

Optional:

```env
VAR_DIR=/home/<user>/Notion-Calendar-Sync/var
STATE_DB_PATH=/home/<user>/Notion-Calendar-Sync/var/sync_state.sqlite3
WSGI_FILE=/var/www/<user>_pythonanywhere_com_wsgi.py
REPO_PATH=/home/<user>/Notion-Calendar-Sync
DEPLOY_BRANCH=main
PYTHON_BIN=/home/<user>/.virtualenvs/notion-sync/bin/python
NOTION_WEBHOOK_VERIFICATION_TOKEN=secret_from_notion_after_subscription_probe
```

## Local Development

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

Run tests:

```bash
python -m unittest discover -s tests
```

## PythonAnywhere Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/neinron/Notion-Calendar-Sync.git
   cd Notion-Calendar-Sync
   ```

2. Create the virtualenv and install dependencies:

   ```bash
   mkvirtualenv --python=/usr/bin/python3.10 notion-sync
   pip install -r requirements.txt
   ```

3. Configure the Web app:

   - Manual WSGI app.
   - Virtualenv: `/home/<user>/.virtualenvs/notion-sync`.
   - WSGI file imports:

     ```python
     from app import app as application
     ```

4. Put environment variables in PythonAnywhere's WSGI file or another PythonAnywhere-supported secret mechanism. Do not commit `.env`.

5. Add a scheduled task:

   ```bash
   curl -fsS "https://<user>.pythonanywhere.com/sync?token=$SYNC_SECRET"
   ```

On PythonAnywhere Free, a daily scheduled task is still useful even with webhooks. Use it to renew the Google watch channel and run a safety sync:

```bash
curl -fsS "https://<user>.pythonanywhere.com/google/watch/renew?token=<SYNC_SECRET>"
curl -fsS "https://<user>.pythonanywhere.com/sync?token=<SYNC_SECRET>"
```

## GitHub Auto-Deploy

Add a GitHub webhook:

- Payload URL: `https://<user>.pythonanywhere.com/update`
- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET`
- Events: push only

The deploy route:

- Requires `X-Hub-Signature-256`.
- Ignores non-`main` pushes.
- Runs `git fetch`, `git reset --hard origin/main`, `pip install -r requirements.txt`.
- Touches the WSGI file to reload PythonAnywhere.
- Uses a lock file to prevent parallel deploys.

## HTTP Endpoints

- `GET /health`: configuration and state health.
- `GET|POST /sync?token=...`: run one sync.
- `GET /conflicts?token=...`: list unresolved conflicts.
- `POST /webhooks/google`: Google Calendar push notification receiver.
- `POST /webhooks/notion`: Notion webhook receiver.
- `GET|POST /google/watch/renew?token=...`: replace the Google Calendar events watch channel.
- `GET /webhook-channels?token=...`: list registered Google watch channels.
- `POST /update`: GitHub deploy webhook.

## Notion And Google Webhooks

### Google Calendar

1. Set `PUBLIC_BASE_URL` and `GOOGLE_WEBHOOK_TOKEN`.
2. Reload the PythonAnywhere web app.
3. Register or renew the channel:

   ```bash
   curl -fsS "https://<user>.pythonanywhere.com/google/watch/renew?token=<SYNC_SECRET>"
   ```

4. Google sends `sync` notifications first; the app acknowledges those without running a sync.
5. Later `exists` notifications run the normal sync engine.

Google watch channels expire. Renew them daily or whenever `/webhook-channels` shows an old expiration.

### Notion

1. In the Notion integration settings, create a webhook subscription pointing to:

   ```text
   https://<user>.pythonanywhere.com/webhooks/notion
   ```

2. Notion will POST a one-time `verification_token`. The app stores it in SQLite automatically. You can also paste that token into `NOTION_WEBHOOK_VERIFICATION_TOKEN` and reload the web app if you prefer env-only configuration.
3. Verify the subscription in Notion.
4. Future Notion webhook payloads must include a matching `X-Notion-Signature`; otherwise the app rejects them.
