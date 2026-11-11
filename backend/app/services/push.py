"""Web Push delivery for the installed PWA.

Every notification row is pushed at most once: the sender first claims it by
setting `notifications.pushed_at`, so several API workers listening to the
same NOTIFY never send duplicates. Subscriptions the push service reports as
gone (404/410) are deleted.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Callable
from uuid import UUID

import anyio
from py_vapid import Vapid01
from pywebpush import WebPushException, webpush

from ..config import Settings
from ..db import db

log = logging.getLogger("kodi.push")

# Where tapping a notification takes the user inside the PWA (hash routes).
DEEP_LINKS = {
    "unit_vacant": "#/units",
    "lease_activated": "#/leases",
    "invoice_issued": "#/invoices",
    "invoice_overdue": "#/invoices",
    "payment_received": "#/payments",
    "payment_unmatched": "#/payments",
    "issue_created": "#/issues",
    "issue_updated": "#/issues",
    "new_message": "#/chat",
    "missed_call": "#/chat",
    "report_ready": "#/reports",
}
URGENT = {"missed_call", "new_message", "payment_received", "invoice_overdue"}

# (subscription_info, payload, headers) -> HTTP status code
Transport = Callable[[dict[str, Any], str, dict[str, str]], int]


class PushSender:
    def __init__(self, settings: Settings, transport: Transport | None = None) -> None:
        self.settings = settings
        self._vapid: Vapid01 | None = None
        if settings.vapid_private_key and settings.vapid_public_key:
            self._vapid = Vapid01.from_string(settings.vapid_private_key)
        self._transport = transport or self._webpush

    @property
    def enabled(self) -> bool:
        return self._vapid is not None

    def _webpush(self, subscription: dict[str, Any], payload: str, headers: dict[str, str]) -> int:
        try:
            response = webpush(
                subscription_info=subscription,
                data=payload,
                vapid_private_key=self._vapid,
                vapid_claims={"sub": self.settings.vapid_subject},
                ttl=self.settings.push_ttl_seconds,
                headers=headers,
                timeout=10,
            )
            return response.status_code
        except WebPushException as exc:
            if exc.response is not None:
                return exc.response.status_code
            raise

    @staticmethod
    def build_payload(row: dict[str, Any]) -> dict[str, Any]:
        data = row.get("data") or {}
        return {
            "id": row["id"],
            "type": row["type"],
            "title": row["title"],
            "body": row.get("body") or "",
            "url": "/" + DEEP_LINKS.get(row["type"], "#/notifications"),
            "tag": f"{row['type']}:{data.get('conversation_id') or data.get('invoice_id') or row['id']}",
            "account_id": str(row["account_id"]) if row.get("account_id") else None,
            "data": data,
        }

    async def deliver(self, notification_id: int) -> int:
        """Push one notification to all of its user's devices. Returns the
        number of devices that accepted it."""
        if not self.enabled:
            return 0
        row = await db.fetchrow(
            """UPDATE notifications SET pushed_at = now()
               WHERE id = $1 AND pushed_at IS NULL AND read_at IS NULL
               RETURNING id, user_id, account_id, type, title, body, data""", notification_id)
        if row is None:
            return 0
        return await self.send_to_user(row["user_id"], self.build_payload(dict(row)),
                                       urgent=row["type"] in URGENT)

    async def send_to_user(self, user_id: UUID, payload: dict[str, Any], *, urgent: bool = False) -> int:
        if not self.enabled:
            return 0
        subs = await db.fetch(
            "SELECT id, endpoint, p256dh_key, auth_secret FROM push_subscriptions WHERE user_id = $1", user_id)
        body = json.dumps(payload, default=str)
        headers = {"Urgency": "high" if urgent else "normal"}
        accepted = 0
        for sub in subs:
            info = {"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh_key"], "auth": sub["auth_secret"]}}
            try:
                status = await anyio.to_thread.run_sync(self._transport, info, body, headers)
            except Exception:  # noqa: BLE001 - network error to one push service must not stop the rest
                log.warning("Push to %s failed", sub["endpoint"][:60], exc_info=True)
                continue
            if status in (404, 410):
                await db.execute("DELETE FROM push_subscriptions WHERE id = $1", sub["id"])
            elif 200 <= status < 300:
                accepted += 1
                await db.execute("UPDATE push_subscriptions SET last_used_at = now() WHERE id = $1", sub["id"])
            else:
                log.warning("Push service answered %s for %s", status, sub["endpoint"][:60])
        return accepted

    async def sweep(self) -> int:
        """Safety net for notifications whose NOTIFY was missed (worker restart)."""
        if not self.enabled:
            return 0
        rows = await db.fetch(
            """SELECT id FROM notifications
               WHERE pushed_at IS NULL AND read_at IS NULL
                 AND created_at BETWEEN now() - interval '15 minutes' AND now() - interval '30 seconds'
               ORDER BY created_at LIMIT 200""")
        sent = 0
        for row in rows:
            sent += await self.deliver(row["id"])
        return sent
