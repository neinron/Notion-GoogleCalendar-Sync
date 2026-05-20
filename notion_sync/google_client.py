from __future__ import annotations

from typing import Any

import requests

from .config import Config
from .models import GoogleEvent
from .serialize import parse_google_event


TOKEN_URL = "https://oauth2.googleapis.com/token"
CALENDAR_BASE = "https://www.googleapis.com/calendar/v3"


class GoogleCalendarClient:
    def __init__(self, config: Config, session: requests.Session | None = None):
        self.config = config
        self.session = session or requests.Session()
        self._access_token: str | None = None

    def _token(self) -> str:
        if self._access_token:
            return self._access_token
        res = self.session.post(
            TOKEN_URL,
            data={
                "client_id": self.config.google_client_id,
                "client_secret": self.config.google_client_secret,
                "refresh_token": self.config.google_refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=30,
        )
        res.raise_for_status()
        self._access_token = res.json()["access_token"]
        return self._access_token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token()}", "Content-Type": "application/json"}

    def list_events(self) -> list[GoogleEvent]:
        events: list[GoogleEvent] = []
        page_token = None
        while True:
            params: dict[str, Any] = {
                "singleEvents": "true",
                "showDeleted": "true",
                "maxResults": 2500,
                "privateExtendedProperty": "notion_page_id",
            }
            if page_token:
                params["pageToken"] = page_token
            res = self.session.get(
                f"{CALENDAR_BASE}/calendars/{self.config.google_calendar_id}/events",
                headers=self._headers(),
                params=params,
                timeout=30,
            )
            res.raise_for_status()
            data = res.json()
            events.extend(parse_google_event(item) for item in data.get("items", []) if isinstance(item, dict))
            page_token = data.get("nextPageToken")
            if not page_token:
                break
        return [event for event in events if event.notion_page_id]

    def create_event(self, body: dict[str, Any]) -> GoogleEvent:
        res = self.session.post(
            f"{CALENDAR_BASE}/calendars/{self.config.google_calendar_id}/events",
            headers=self._headers(),
            json=body,
            timeout=30,
        )
        res.raise_for_status()
        return parse_google_event(res.json())

    def update_event(self, event_id: str, body: dict[str, Any]) -> GoogleEvent:
        res = self.session.patch(
            f"{CALENDAR_BASE}/calendars/{self.config.google_calendar_id}/events/{event_id}",
            headers=self._headers(),
            json=body,
            timeout=30,
        )
        res.raise_for_status()
        return parse_google_event(res.json())

    def delete_event(self, event_id: str) -> None:
        res = self.session.delete(
            f"{CALENDAR_BASE}/calendars/{self.config.google_calendar_id}/events/{event_id}",
            headers=self._headers(),
            timeout=30,
        )
        if res.status_code not in {200, 204, 404, 410}:
            res.raise_for_status()
