"""Realtime hub: tracks WebSocket clients and bridges PostgreSQL LISTEN/NOTIFY
to browsers.

* `kodi_events` - business events emitted by database triggers (notifications,
  chat messages, payments, unit/lease/issue changes).
* `kodi_rtc`    - ephemeral signalling (typing, call invites, SDP/ICE) relayed
  between API workers when the recipient is connected to another worker.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Awaitable, Iterable
from uuid import UUID

import asyncpg
from fastapi import WebSocket

from ..db import db
from . import chat

log = logging.getLogger("kodi.realtime")
INSTANCE_ID = uuid.uuid4().hex
NOTIFY_LIMIT = 7900  # PostgreSQL NOTIFY payloads must stay under 8000 bytes


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return str(value)


def dumps(message: dict[str, Any]) -> str:
    return json.dumps(message, default=_json_default)


@dataclass(eq=False)
class Client:
    ws: WebSocket
    user_id: UUID
    staff_accounts: set[UUID]
    tenant_ids: set[UUID]
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, message: dict[str, Any]) -> bool:
        try:
            async with self._lock:
                await self.ws.send_text(dumps(message))
            return True
        except Exception:  # noqa: BLE001 - socket already gone
            return False


class RealtimeHub:
    def __init__(self) -> None:
        self.clients: dict[UUID, set[Client]] = defaultdict(set)
        self._listener: asyncio.Task | None = None
        self._stopping = False
        self._tasks: set[asyncio.Task] = set()
        self.timers: dict[UUID, asyncio.Task] = {}
        self.push: Any = None  # PushSender, set at startup

    # ------------------------------------------------------------ registry
    def register(self, client: Client) -> None:
        self.clients[client.user_id].add(client)

    def unregister(self, client: Client) -> bool:
        """Returns True when that was the user's last open socket."""
        sockets = self.clients.get(client.user_id)
        if sockets is None:
            return True
        sockets.discard(client)
        if not sockets:
            del self.clients[client.user_id]
            return True
        return False

    def is_online(self, user_id: UUID) -> bool:
        return bool(self.clients.get(user_id))

    def spawn(self, coro: Awaitable[Any]) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    # ------------------------------------------------------------ delivery
    async def send_to_user(self, user_id: UUID, message: dict[str, Any]) -> int:
        delivered = 0
        for client in list(self.clients.get(user_id, ())):
            if await client.send(message):
                delivered += 1
        return delivered

    async def send_to_users(self, user_ids: Iterable[UUID], message: dict[str, Any]) -> None:
        for user_id in set(user_ids):
            await self.send_to_user(user_id, message)

    async def relay(self, user_id: UUID, message: dict[str, Any]) -> bool:
        """Deliver an ephemeral signal locally, or via NOTIFY to other workers."""
        if await self.send_to_user(user_id, message):
            return True
        payload = dumps({"origin": INSTANCE_ID, "to": str(user_id), "msg": message})
        if len(payload.encode()) > NOTIFY_LIMIT or db.pool is None:
            return False
        await db.execute("SELECT pg_notify('kodi_rtc', $1)", payload)
        return True

    # ------------------------------------------------------------ listener
    async def start(self) -> None:
        self._stopping = False
        self._listener = asyncio.create_task(self._listen_forever(), name="kodi-pg-listener")

    async def stop(self) -> None:
        self._stopping = True
        for task in [self._listener, *self.timers.values(), *self._tasks]:
            if task:
                task.cancel()
        await asyncio.gather(*(t for t in [self._listener, *self._tasks] if t), return_exceptions=True)
        for sockets in list(self.clients.values()):
            for client in list(sockets):
                try:
                    await client.ws.close(code=1012)  # service restart
                except Exception:  # noqa: BLE001
                    pass
        self.clients.clear()

    async def _listen_forever(self) -> None:
        backoff = 1.0
        while not self._stopping:
            conn: asyncpg.Connection | None = None
            try:
                conn = await asyncpg.connect(db.dsn)
                closed = asyncio.Event()
                conn.add_termination_listener(lambda _c: closed.set())
                await conn.add_listener("kodi_events", self._on_event)
                await conn.add_listener("kodi_rtc", self._on_rtc)
                log.info("Listening on kodi_events / kodi_rtc")
                backoff = 1.0
                await closed.wait()
                log.warning("LISTEN connection closed; reconnecting")
            except asyncio.CancelledError:
                break
            except Exception:  # noqa: BLE001
                log.exception("LISTEN connection failed")
            finally:
                if conn is not None and not conn.is_closed():
                    try:
                        await conn.close(timeout=2)
                    except Exception:  # noqa: BLE001
                        pass
            if not self._stopping:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    def _on_event(self, _conn: Any, _pid: int, _channel: str, payload: str) -> None:
        try:
            event = json.loads(payload)
        except ValueError:
            log.warning("Ignoring malformed event payload")
            return
        self.spawn(self._dispatch_event(event))

    def _on_rtc(self, _conn: Any, _pid: int, _channel: str, payload: str) -> None:
        try:
            data = json.loads(payload)
        except ValueError:
            return
        if data.get("origin") == INSTANCE_ID:
            return
        self.spawn(self.send_to_user(UUID(data["to"]), data["msg"]))

    async def _dispatch_event(self, event: dict[str, Any]) -> None:
        try:
            kind = event.get("event")
            if kind == "notification":
                row = await db.fetchrow(
                    """SELECT id, account_id, type, title, body, data, read_at, created_at
                       FROM notifications WHERE id = $1""",
                    int(event["notification_id"]),
                )
                if row:
                    await self.send_to_user(UUID(event["user_id"]),
                                            {"type": "notification", "notification": dict(row)})
                    if self.push is not None:
                        # The service worker hides it if the app is already on screen.
                        await self.push.deliver(row["id"])
                return

            if kind == "chat_message":
                message = await chat.fetch_message(int(event["message_id"]))
                if message:
                    recipients = await chat.participant_ids(UUID(event["conversation_id"]))
                    await self.send_to_users(recipients, {"type": "chat.message", "message": message})
                return

            # Domain events: landlord staff of the account, plus the tenant concerned.
            account_id = UUID(event["account_id"]) if event.get("account_id") else None
            tenant_id = UUID(event["tenant_id"]) if event.get("tenant_id") else None
            outgoing = {"type": "event", "event": kind, "data": event}
            for sockets in list(self.clients.values()):
                for client in list(sockets):
                    if (account_id and account_id in client.staff_accounts) or \
                       (tenant_id and tenant_id in client.tenant_ids):
                        await client.send(outgoing)
        except Exception:  # noqa: BLE001
            log.exception("Failed to dispatch event %s", event.get("event"))


hub = RealtimeHub()
