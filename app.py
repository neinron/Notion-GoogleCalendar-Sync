from __future__ import annotations

import logging
import os
import sys
import threading

from flask import Flask, jsonify, request
from flask_cors import CORS

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

from notion_sync.config import Config
from notion_sync.deploy import run_deploy_from_request
from notion_sync.google_client import GoogleCalendarClient
from notion_sync.notion_client import NotionClient
from notion_sync.state import SyncState
from notion_sync.sync_engine import SyncEngine
from notion_sync.utils import FileLock, constant_time_equal, hmac_sha256_signature, require_token


def create_app(config: Config | None = None) -> Flask:
    app = Flask(__name__)
    CORS(app, resources={r"/*": {"origins": "*"}})

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )
    logger = logging.getLogger(__name__)
    cfg = config or Config.from_env()

    def build_engine() -> SyncEngine:
        state = SyncState(cfg.state_db_path)
        notion = NotionClient(cfg)
        google = GoogleCalendarClient(cfg)
        return SyncEngine(cfg, state, notion, google, logger=logger)

    def run_locked_sync(trigger: str):
        with FileLock(cfg.sync_lock_path):
            result = build_engine().sync()
        logger.info("sync trigger=%s result=%s", trigger, result)
        return result

    def start_background_sync(trigger: str) -> None:
        def target() -> None:
            try:
                run_locked_sync(trigger)
            except RuntimeError as exc:
                logger.info("sync trigger=%s skipped: %s", trigger, exc)
            except Exception:
                logger.exception("sync trigger=%s failed", trigger)

        threading.Thread(target=target, daemon=True, name=f"sync-{trigger}").start()

    @app.route("/")
    def index():
        return jsonify({"ok": True, "service": "notion-calendar-sync"})

    @app.route("/health")
    def health():
        missing = cfg.missing_required()
        return jsonify(
            {
                "ok": not missing,
                "missing": missing,
                "calendar_id_set": bool(cfg.google_calendar_id),
                "state_db": str(cfg.state_db_path),
                "repo_path": str(cfg.repo_path),
                "webhook_missing": cfg.missing_webhook_config(),
            }
        ), 200 if not missing else 503

    @app.route("/sync", methods=["POST", "GET"])
    @app.route("/sync", methods=["POST", "GET"])
    def sync():
        token_error = require_token(request, cfg.sync_secret)
        if token_error:
            return token_error

        limit = int(request.args.get("limit", "25"))

        with FileLock(cfg.sync_lock_path):
            result = build_engine().sync(limit=limit)

        logger.info("sync trigger=%s limit=%s result=%s", "manual", limit, result)
        return jsonify(result)
    @app.route("/conflicts")
    def conflicts():
        token_error = require_token(request, cfg.sync_secret)
        if token_error:
            return token_error
        state = SyncState(cfg.state_db_path)
        return jsonify({"ok": True, "conflicts": state.list_conflicts()})

    @app.route("/webhooks/google", methods=["POST"])
    def google_webhook():
        if not cfg.google_webhook_token:
            return jsonify({"ok": False, "error": "GOOGLE_WEBHOOK_TOKEN is not configured"}), 503
        supplied = request.headers.get("X-Goog-Channel-Token", "")
        if not constant_time_equal(supplied, cfg.google_webhook_token):
            return jsonify({"ok": False, "error": "invalid google channel token"}), 403

        resource_state = request.headers.get("X-Goog-Resource-State", "")
        channel_id = request.headers.get("X-Goog-Channel-ID", "")
        resource_id = request.headers.get("X-Goog-Resource-ID", "")
        logger.info("google webhook state=%s channel=%s resource=%s", resource_state, channel_id, resource_id)
        if resource_state == "sync":
            return jsonify({"ok": True, "ignored": True, "reason": "channel sync notification"}), 202
        start_background_sync("google-webhook")
        return jsonify({"ok": True, "accepted": True}), 200

    @app.route("/webhooks/notion", methods=["POST"])
    def notion_webhook():
        body = request.get_data()
        payload = request.get_json(silent=True) or {}
        state = SyncState(cfg.state_db_path)

        verification_token = payload.get("verification_token")
        if verification_token:
            state.set_setting("notion_webhook_verification_token", verification_token)
            logger.info("notion webhook verification token received")
            return jsonify({"ok": True, "verification_token_received": True, "stored": True}), 200

        notion_secret = cfg.notion_webhook_verification_token or state.get_setting("notion_webhook_verification_token")
        if not notion_secret:
            return jsonify({"ok": False, "error": "NOTION_WEBHOOK_VERIFICATION_TOKEN is not configured"}), 503
        expected = hmac_sha256_signature(notion_secret, body)
        supplied = request.headers.get("X-Notion-Signature", "")
        if not constant_time_equal(supplied, expected):
            return jsonify({"ok": False, "error": "invalid notion signature"}), 403

        event_count = len(payload.get("events", [])) if isinstance(payload.get("events"), list) else 0
        logger.info("notion webhook events=%s", event_count)
        start_background_sync("notion-webhook")
        return jsonify({"ok": True, "accepted": True}), 200

    @app.route("/google/watch/renew", methods=["POST", "GET"])
    def renew_google_watch():
        token_error = require_token(request, cfg.sync_secret)
        if token_error:
            return token_error
        missing = cfg.missing_webhook_config()
        if missing:
            return jsonify({"ok": False, "missing": missing}), 503

        state = SyncState(cfg.state_db_path)
        google = GoogleCalendarClient(cfg)
        previous = state.list_webhook_channels()
        for channel in previous:
            try:
                google.stop_channel(channel.get("channel_id", ""), channel.get("resource_id", ""))
            except Exception as exc:
                logger.warning("failed to stop google watch channel %s: %s", channel.get("channel_id"), exc)

        channel = google.watch_events()
        state.upsert_webhook_channel(
            channel_id=channel.get("id", ""),
            resource_id=channel.get("resourceId", ""),
            resource_uri=channel.get("resourceUri", ""),
            calendar_id=cfg.google_calendar_id,
            expiration=str(channel.get("expiration", "")),
            token_hint="configured",
        )
        return jsonify({"ok": True, "channel": channel, "stopped_previous": len(previous)})

    @app.route("/webhook-channels")
    def webhook_channels():
        token_error = require_token(request, cfg.sync_secret)
        if token_error:
            return token_error
        return jsonify({"ok": True, "channels": SyncState(cfg.state_db_path).list_webhook_channels()})

    @app.route("/update", methods=["POST"])
    def update():
        with FileLock(cfg.deploy_lock_path):
            result, status = run_deploy_from_request(request, cfg, logger)
        return jsonify(result), status

    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5004"))
    app.run(host="0.0.0.0", port=port)
