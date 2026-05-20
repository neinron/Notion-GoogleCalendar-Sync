from __future__ import annotations

import logging
import os
import sys

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
from notion_sync.utils import FileLock, require_token


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

    @app.route("/")
    def index():
        return jsonify({"ok": True, "service": "notion-google-two-way-sync"})

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
            }
        ), 200 if not missing else 503

    @app.route("/sync", methods=["POST", "GET"])
    def sync():
        token_error = require_token(request, cfg.sync_secret)
        if token_error:
            return token_error
        with FileLock(cfg.sync_lock_path):
            result = build_engine().sync()
        return jsonify(result)

    @app.route("/conflicts")
    def conflicts():
        token_error = require_token(request, cfg.sync_secret)
        if token_error:
            return token_error
        state = SyncState(cfg.state_db_path)
        return jsonify({"ok": True, "conflicts": state.list_conflicts()})

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
