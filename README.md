# Notion Google Calendar Two-Way Sync

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
GITHUB_WEBHOOK_SECRET=long-random-secret
```

Optional:

```env
VAR_DIR=/home/<user>/Notion-iCloud-Synch/var
STATE_DB_PATH=/home/<user>/Notion-iCloud-Synch/var/sync_state.sqlite3
WSGI_FILE=/var/www/<user>_pythonanywhere_com_wsgi.py
REPO_PATH=/home/<user>/Notion-iCloud-Synch
DEPLOY_BRANCH=main
PYTHON_BIN=/home/<user>/.virtualenvs/notion-sync/bin/python
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
   git clone https://github.com/neinron/Notion-iCloud-Synch.git
   cd Notion-iCloud-Synch
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
- `POST /update`: GitHub deploy webhook.
