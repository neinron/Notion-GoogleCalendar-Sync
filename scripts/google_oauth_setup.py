#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
import urllib.parse

import requests

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"
SCOPE = "https://www.googleapis.com/auth/calendar"


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip().strip('"')
    if not value:
        print(f"Missing {name}", file=sys.stderr)
        raise SystemExit(2)
    return value


def print_auth_url() -> None:
    client_id = require_env("GOOGLE_CLIENT_ID")
    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
    }
    print(urllib.parse.urljoin(AUTH_URL, "?" + urllib.parse.urlencode(params)))


def exchange_code(code: str) -> None:
    client_id = require_env("GOOGLE_CLIENT_ID")
    client_secret = require_env("GOOGLE_CLIENT_SECRET")
    res = requests.post(
        TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": REDIRECT_URI,
        },
        timeout=30,
    )
    if res.status_code != 200:
        print(res.text, file=sys.stderr)
        raise SystemExit(1)
    data = res.json()
    refresh_token = data.get("refresh_token")
    if not refresh_token:
        print("Google did not return a refresh_token. Re-run auth URL with prompt=consent and approve access.", file=sys.stderr)
        raise SystemExit(1)
    print(f'GOOGLE_REFRESH_TOKEN="{refresh_token}"')


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a Google Calendar OAuth refresh token.")
    parser.add_argument("--code", help="Authorization code copied from Google after opening the auth URL.")
    args = parser.parse_args()
    if args.code:
        exchange_code(args.code)
    else:
        print_auth_url()


if __name__ == "__main__":
    main()
