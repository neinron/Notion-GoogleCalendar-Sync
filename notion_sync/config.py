from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    notion_api_key: str
    database_id: str
    google_calendar_id: str
    google_client_id: str
    google_client_secret: str
    google_refresh_token: str
    google_time_zone: str
    public_base_url: str
    google_webhook_token: str
    notion_webhook_verification_token: str
    github_webhook_secret: str
    sync_secret: str
    repo_path: Path
    wsgi_file: Path
    state_db_path: Path
    sync_lock_path: Path
    deploy_lock_path: Path
    branch: str = "main"
    notion_version: str = "2022-06-28"
    enable_legacy_deploy_webhook: bool = False

    @classmethod
    def from_env(cls) -> "Config":
        base_dir = Path(__file__).resolve().parent.parent
        user = os.getenv("USER", "")
        pa_wsgi = Path(f"/var/www/{user}_pythonanywhere_com_wsgi.py")
        wsgi_default = pa_wsgi if pa_wsgi.exists() else base_dir / "wsgi.py"
        var_dir = Path(os.getenv("VAR_DIR", base_dir / "var"))
        return cls(
            notion_api_key=os.getenv("NOTION_API_KEY", ""),
            database_id=os.getenv("DATABASE_ID", ""),
            google_calendar_id=os.getenv("GOOGLE_CALENDAR_ID", ""),
            google_client_id=os.getenv("GOOGLE_CLIENT_ID", ""),
            google_client_secret=os.getenv("GOOGLE_CLIENT_SECRET", ""),
            google_refresh_token=os.getenv("GOOGLE_REFRESH_TOKEN", ""),
            google_time_zone=os.getenv("GOOGLE_TIME_ZONE", "Europe/Berlin"),
            public_base_url=os.getenv("PUBLIC_BASE_URL", "").rstrip("/"),
            google_webhook_token=os.getenv("GOOGLE_WEBHOOK_TOKEN", ""),
            notion_webhook_verification_token=os.getenv("NOTION_WEBHOOK_VERIFICATION_TOKEN", ""),
            github_webhook_secret=os.getenv("GITHUB_WEBHOOK_SECRET", ""),
            sync_secret=os.getenv("SYNC_SECRET", ""),
            repo_path=Path(os.getenv("REPO_PATH", base_dir)),
            wsgi_file=Path(os.getenv("WSGI_FILE", wsgi_default)),
            state_db_path=Path(os.getenv("STATE_DB_PATH", var_dir / "sync_state.sqlite3")),
            sync_lock_path=Path(os.getenv("SYNC_LOCK_PATH", var_dir / "sync.lock")),
            deploy_lock_path=Path(os.getenv("DEPLOY_LOCK_PATH", var_dir / "deploy.lock")),
            branch=os.getenv("DEPLOY_BRANCH", "main"),
            notion_version=os.getenv("NOTION_VERSION", "2022-06-28"),
            enable_legacy_deploy_webhook=os.getenv("ENABLE_LEGACY_DEPLOY_WEBHOOK", "").lower() in {"1", "true", "yes"},
        )

    def missing_required(self) -> list[str]:
        required = {
            "NOTION_API_KEY": self.notion_api_key,
            "DATABASE_ID": self.database_id,
            "GOOGLE_CALENDAR_ID": self.google_calendar_id,
            "GOOGLE_CLIENT_ID": self.google_client_id,
            "GOOGLE_CLIENT_SECRET": self.google_client_secret,
            "GOOGLE_REFRESH_TOKEN": self.google_refresh_token,
            "SYNC_SECRET": self.sync_secret,
        }
        return [name for name, value in required.items() if not value]

    def missing_webhook_config(self) -> list[str]:
        required = {
            "PUBLIC_BASE_URL": self.public_base_url,
            "GOOGLE_WEBHOOK_TOKEN": self.google_webhook_token,
        }
        return [name for name, value in required.items() if not value]
