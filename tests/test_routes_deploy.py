from __future__ import annotations

import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import flask  # noqa: F401
except ImportError:
    flask = None

if flask is None:
    raise unittest.SkipTest("Flask is not installed in this Python environment")

from app import create_app
from notion_sync.config import Config


def cfg(tmp: Path) -> Config:
    return Config(
        notion_api_key="notion",
        database_id="db",
        google_calendar_id="cal",
        google_client_id="cid",
        google_client_secret="secret",
        google_refresh_token="refresh",
        public_base_url="https://example.com",
        google_webhook_token="google-token",
        notion_webhook_verification_token="notion-token",
        github_webhook_secret="hook-secret",
        sync_secret="sync-secret",
        repo_path=tmp,
        wsgi_file=tmp / "wsgi.py",
        state_db_path=tmp / "state.sqlite3",
        sync_lock_path=tmp / "sync.lock",
        deploy_lock_path=tmp / "deploy.lock",
    )


def signature(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


class RouteDeployTests(unittest.TestCase):
    def test_health_reports_missing_config(self):
        with tempfile.TemporaryDirectory() as d:
            conf = cfg(Path(d))
            conf = Config(**{**conf.__dict__, "notion_api_key": ""})
            client = create_app(conf).test_client()
            res = client.get("/health")
            self.assertEqual(res.status_code, 503)
            self.assertIn("NOTION_API_KEY", res.get_json()["missing"])

    def test_invalid_github_signature_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            client = create_app(cfg(Path(d))).test_client()
            res = client.post("/update", json={"ref": "refs/heads/main"}, headers={"X-Hub-Signature-256": "sha256=bad"})
            self.assertEqual(res.status_code, 403)

    def test_non_main_push_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            client = create_app(cfg(Path(d))).test_client()
            body = json.dumps({"ref": "refs/heads/feature"}).encode("utf-8")
            res = client.post("/update", data=body, content_type="application/json", headers={"X-Hub-Signature-256": signature("hook-secret", body)})
            self.assertEqual(res.status_code, 202)
            self.assertTrue(res.get_json()["ignored"])

    def test_valid_main_push_runs_deploy_steps(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            client = create_app(cfg(tmp)).test_client()
            body = json.dumps({"ref": "refs/heads/main"}).encode("utf-8")
            with patch("notion_sync.deploy.subprocess.run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = ""
                run.return_value.stderr = ""
                res = client.post("/update", data=body, content_type="application/json", headers={"X-Hub-Signature-256": signature("hook-secret", body)})
            self.assertEqual(res.status_code, 200)
            self.assertEqual(run.call_count, 3)
            self.assertTrue((tmp / "wsgi.py").exists())

    def test_google_webhook_rejects_bad_token(self):
        with tempfile.TemporaryDirectory() as d:
            client = create_app(cfg(Path(d))).test_client()
            res = client.post("/webhooks/google", headers={"X-Goog-Channel-Token": "bad"})
            self.assertEqual(res.status_code, 403)

    def test_google_sync_notification_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            client = create_app(cfg(Path(d))).test_client()
            res = client.post(
                "/webhooks/google",
                headers={"X-Goog-Channel-Token": "google-token", "X-Goog-Resource-State": "sync"},
            )
            self.assertEqual(res.status_code, 202)
            self.assertTrue(res.get_json()["ignored"])

    def test_notion_verification_token_acknowledged(self):
        with tempfile.TemporaryDirectory() as d:
            client = create_app(cfg(Path(d))).test_client()
            res = client.post("/webhooks/notion", json={"verification_token": "secret_test"})
            self.assertEqual(res.status_code, 200)
            self.assertTrue(res.get_json()["verification_token_received"])

    def test_notion_webhook_rejects_bad_signature(self):
        with tempfile.TemporaryDirectory() as d:
            client = create_app(cfg(Path(d))).test_client()
            res = client.post("/webhooks/notion", json={"events": []}, headers={"X-Notion-Signature": "sha256=bad"})
            self.assertEqual(res.status_code, 403)


if __name__ == "__main__":
    unittest.main()
