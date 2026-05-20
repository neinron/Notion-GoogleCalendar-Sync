from __future__ import annotations

import hashlib
import hmac
import os
import time
from pathlib import Path
from typing import Any

from flask import jsonify


class FileLock:
    def __init__(self, path: Path, timeout_seconds: int = 1):
        self.path = path
        self.timeout_seconds = timeout_seconds
        self.fd: int | None = None

    def __enter__(self) -> "FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + self.timeout_seconds
        while True:
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, str(os.getpid()).encode("utf-8"))
                return self
            except FileExistsError:
                if time.time() >= deadline:
                    raise RuntimeError(f"lock already held: {self.path}")
                time.sleep(0.1)

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self.fd is not None:
            os.close(self.fd)
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def require_token(request, expected: str):
    if not expected:
        return jsonify({"ok": False, "error": "SYNC_SECRET is not configured"}), 503
    supplied = request.args.get("token") or request.headers.get("X-Sync-Token", "")
    if supplied != expected:
        return jsonify({"ok": False, "error": "invalid sync token"}), 403
    return None


def constant_time_equal(left: str, right: str) -> bool:
    return hmac.compare_digest((left or "").encode("utf-8"), (right or "").encode("utf-8"))


def hmac_sha256_signature(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
