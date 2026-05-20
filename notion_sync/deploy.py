from __future__ import annotations

import hmac
import hashlib
import logging
import os
import subprocess
from pathlib import Path
from typing import Any

from flask import Request

from .config import Config


def verify_github_signature(request: Request, secret: str) -> bool:
    signature = request.headers.get("X-Hub-Signature-256", "")
    if not secret or not signature.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode("utf-8"), request.data, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def run_command(args: list[str], cwd: Path) -> dict[str, Any]:
    proc = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=120)
    return {
        "args": args[:2],
        "returncode": proc.returncode,
        "stdout": proc.stdout[-2000:],
        "stderr": proc.stderr[-2000:],
    }


def run_deploy_from_request(request: Request, config: Config, logger: logging.Logger) -> tuple[dict[str, Any], int]:
    if not verify_github_signature(request, config.github_webhook_secret):
        return {"ok": False, "error": "invalid GitHub webhook signature"}, 403

    payload = request.get_json(silent=True) or {}
    if payload.get("ref") != f"refs/heads/{config.branch}":
        return {"ok": True, "ignored": True, "reason": "non-deploy branch", "ref": payload.get("ref")}, 202

    steps = [
        ["git", "fetch", "origin", config.branch],
        ["git", "reset", "--hard", f"origin/{config.branch}"],
        [os.environ.get("PYTHON_BIN", "python3"), "-m", "pip", "install", "-r", "requirements.txt"],
    ]
    results = []
    for step in steps:
        result = run_command(step, config.repo_path)
        results.append(result)
        if result["returncode"] != 0:
            logger.error("deploy step failed: %s", result)
            return {"ok": False, "step": result["args"], "results": results}, 500

    try:
        config.wsgi_file.parent.mkdir(parents=True, exist_ok=True)
        config.wsgi_file.touch()
    except Exception as exc:
        return {"ok": False, "error": f"failed to touch WSGI file: {exc}", "results": results}, 500

    logger.info("deploy completed for %s", config.branch)
    return {"ok": True, "deployed": config.branch, "results": results}, 200
