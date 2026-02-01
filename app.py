from flask import Flask, Response, request, jsonify
import requests
from ics import Calendar, Event
from datetime import datetime
import os
import logging
import sys
from flask_cors import CORS

import hmac
import hashlib
import subprocess
try:
    from dotenv import load_dotenv
    # Load environment variables from .env file
    load_dotenv()
except ImportError:
    pass

def create_app():
    app = Flask(__name__)
    CORS(app, resources={r"/*": {"origins": "*"}})

    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[logging.StreamHandler(sys.stdout)]
    )
    logger = logging.getLogger(__name__)

    NOTION_API_KEY = os.getenv("NOTION_API_KEY")
    DATABASE_ID = os.getenv("DATABASE_ID")
    GITHUB_WEBHOOK_SECRET = os.getenv("GITHUB_WEBHOOK_SECRET")
    WSGI_FILE = os.getenv("WSGI_FILE", "wsgi.py")

    if not NOTION_API_KEY or not DATABASE_ID:
        logger.warning("Please set NOTION_API_KEY and DATABASE_ID environment variables")

    NOTION_API_URL = f"https://api.notion.com/v1/databases/{DATABASE_ID}/query"
    NOTION_HEADERS = {
        "Authorization": f"Bearer {NOTION_API_KEY}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
    }

    # Persistent session for connection pooling
    session = requests.Session()
    session.headers.update(NOTION_HEADERS)

    # In-memory cache
    cache = {
        "calendar_data": None,
        "timestamp": None,
        "courses": {}  # Cache for course IDs -> Course Info
    }

    @app.route("/")
    def index():
        return "Notion Calendar Sync Server is running!", 200

    @app.route("/reset_cache")
    def reset_cache():
        cache["calendar_data"] = None
        cache["timestamp"] = None
        cache["courses"] = {}
        logger.info("Cache manually reset via /reset_cache")
        return "Cache cleared!", 200

    @app.route("/update", methods=["POST"])
    def update():
        # Verify signature if secret is set
        if GITHUB_WEBHOOK_SECRET:
            signature = request.headers.get("X-Hub-Signature-256")
            if not signature:
                return "Missing signature", 400
            
            hash_object = hmac.new(
                GITHUB_WEBHOOK_SECRET.encode("utf-8"),
                msg=request.data,
                digestmod=hashlib.sha256
            )
            expected_signature = "sha256=" + hash_object.hexdigest()
            
            if not hmac.compare_digest(expected_signature, signature):
                return "Invalid signature", 403

        # Pull the latest code
        try:
            subprocess.run(["git", "pull"], check=True)
            if os.path.exists(WSGI_FILE):
                os.utime(WSGI_FILE, None)
            return "Update successful and app reloaded", 200
        except Exception as e:
            return f"Update failed: {str(e)}", 500

    def fetch_notion_events():
        if not NOTION_API_KEY or not DATABASE_ID:
            logger.error("API Key or Database ID missing during fetch")
            return []

        logger.info(f"Fetching events from Notion database {DATABASE_ID}")
        all_results = []
        next_cursor = None

        while True:
            payload = {
                "page_size": 100,
                "filter": {
                    "property": "Name",
                    "title": { "is_not_empty": True }
                }
            }
            if next_cursor:
                payload["start_cursor"] = next_cursor

            try:
                res = session.post(NOTION_API_URL, json=payload, timeout=10)
                if res.status_code != 200:
                    logger.error(f"Notion API error: {res.status_code} - {res.text}")
                    break

                data = res.json()
                all_results.extend(data.get("results", []))
                logger.info(f"Retrieved {len(all_results)} pages so far...")
                
                if not data.get("has_more") or len(all_results) > 500: # Safety cap
                    break
                next_cursor = data.get("next_cursor")
            except Exception as e:
                logger.error(f"Request failed: {e}")
                break

        events = []
        total = len(all_results)
        logger.info(f"Starting to process {total} events...")

        for i, page in enumerate(all_results):
            if i % 20 == 0 and i > 0:
                logger.info(f"Processed {i}/{total} events...")

            properties = page.get('properties', {})
            
            # Extract Title
            title_list = properties.get('Name', {}).get('title', [{}])
            name = title_list[0].get('plain_text', 'Untitled Event') if title_list else 'Untitled Event'

            # Extract Date
            do_date = properties.get('Do Date', {}).get('date', {})
            start_date = do_date.get('start')
            end_date = do_date.get('end')

            if not start_date:
                continue

            # Extract Course Info with Cache
            course_info = ""
            relation = properties.get('Course', {}).get('relation', [])
            if relation:
                course_id = relation[0].get('id')
                if course_id in cache["courses"]:
                    course_info = cache["courses"][course_id]
                else:
                    try:
                        course_res = session.get(f"https://api.notion.com/v1/pages/{course_id}", timeout=5)
                        if course_res.status_code == 200:
                            course_data = course_res.json()
                            c_name = course_data.get('properties', {}).get('Name', {}).get('title', [{}])[0].get('plain_text', '')
                            c_emoji = course_data.get('icon', {}).get('emoji', '')
                            course_info = f"{c_emoji} {c_name}".strip()
                            cache["courses"][course_id] = course_info
                            logger.info(f"Cached new course: {course_info}")
                    except Exception as e:
                        logger.warning(f"Failed to fetch course {course_id}: {e}")
                        pass

            status = properties.get('Status', {}).get('status', {}).get('name', '')

            event = Event()
            event.name = f"{name} - {course_info}" if course_info else name
            
            try:
                # Parse ISO date/time
                event.begin = datetime.fromisoformat(start_date.replace('Z', '+00:00')) if 'T' in start_date else datetime.fromisoformat(start_date)
                if end_date:
                    event.end = datetime.fromisoformat(end_date.replace('Z', '+00:00')) if 'T' in end_date else datetime.fromisoformat(end_date)
                else:
                    # Default 1 hour event if no end date
                    event.end = event.begin.replace(hour=event.begin.hour + 1) if 'T' in start_date else event.begin
                
                if 'T' not in start_date:
                    event.make_all_day()
            except Exception as e:
                logger.warning(f"Date parse error for '{name}': {e}")
                continue

            # Description
            desc = []
            if status: desc.append(f"Status: {status}")
            if page.get('url'): desc.append(f"Notion URL: {page['url']}")
            event.description = "\n".join(desc)

            events.append(event)
        
        return events

    @app.route("/calendar.ics")
    def calendar_feed():
        try:
            # Automatic cache invalidation after 15 minutes
            if cache["timestamp"]:
                time_diff = (datetime.now() - cache["timestamp"]).total_seconds()
                if time_diff > 900: # 15 minutes
                    cache["calendar_data"] = None
                    logger.info("Cache expired, will refresh data.")

            # Simple caching (reset by /reset_cache or manual restart)
            if cache["calendar_data"] is None:
                cal = Calendar()
                events = fetch_notion_events()
                for e in events: cal.events.add(e)
                cache["calendar_data"] = cal.serialize()
                cache["timestamp"] = datetime.now()

            return Response(
                cache["calendar_data"],
                mimetype="text/calendar",
                headers={
                    'Content-Disposition': 'attachment; filename="calendar.ics"',
                    'Cache-Control': 'no-cache'
                }
            )
        except Exception as e:
            logger.error(f"Error: {e}", exc_info=True)
            return "Internal Server Error", 500

    return app

app = create_app()

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5004))
    app.run(host="0.0.0.0", port=port)
