# Notion to iCloud Sync Tool

A lightweight Flask service that transforms a Notion database into an iCalendar (`.ics`) feed.

## Setup

1. **Notion Integration**:
   - Create an integration at [notion.so/my-integrations](https://www.notion.com/my-integrations).
   - Add the connection to your Notion database.

2. **Local Development**:
   - Create a `.env` file from the provided credentials.
   - Run `pip install -r requirements.txt`.
   - Run `python app.py`.

## Hosting on PythonAnywhere with GitHub Auto-Deploy

### 1. Initial Setup on GitHub
- Create a new (private) repository on GitHub.
- Push this code to it:
  ```bash
  git init
  git remote add origin <your-repo-url>
  git add .
  git commit -m "initial commit"
  git push -u origin main
  ```

### 2. Initial Setup on PythonAnywhere
- Open a Bash console on PythonAnywhere.
- Clone your repo: `git clone https://github.com/yourusername/Notion-iCloud-Synch.git`
- Create a virtualenv:
  ```bash
  mkvirtualenv --python=/usr/bin/python3.10 notion-sync
  pip install -r requirements.txt
  ```
- Go to the **Web** tab:
  - Create a new web app (Manual configuration).
  - Set the path to your code.
  - Set the virtualenv path.
  - Edit the WSGI configuration file to look like `wsgi.py`.
  - Add your `NOTION_API_KEY` and `DATABASE_ID` to the setup environment variables (via the .env file or the PA dash).

### 3. Configure Automated Updates
To make it update whenever you push to GitHub:
- **Set a Webhook Secret**: In your PythonAnywhere environment, set `GITHUB_WEBHOOK_SECRET`.
- **In your GitHub Repo**:
  - Go to `Settings` -> `Webhooks` -> `Add webhook`.
  - **Payload URL**: `https://<your-username>.pythonanywhere.com/update` (You'll need to route `/update` to `update_webhook.py` or merge it into `app.py`).
  - **Content type**: `application/json`.
  - **Secret**: The matching secret you chose.
- **Merge Webhook Logic**: 
  - On PythonAnywhere, you can run `update_webhook.py` as a separate task or import its route into `app.py` for simplicity.

> [!TIP]
> For the simplest setup, you can just add the `/update` route from `update_webhook.py` directly into `app.py`.
