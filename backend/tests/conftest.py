"""Test fixtures: a fresh PostgreSQL database built from the real schema,
the FastAPI app with a fake Daraja client, and WebSocket helpers.

Set KODI_TEST_ADMIN_DSN to a server where the tests may create/drop the
database `kodi_test` (default: postgresql://postgres@localhost:54329/postgres).
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable

import anyio
import asyncpg
import pytest
from cryptography.fernet import Fernet

from app.tools.gen_vapid import generate as generate_vapid

ROOT = Path(__file__).resolve().parents[2]


def _dotenv_value(key: str) -> str | None:
    """Read one key from backend/.env so `pytest` works without exporting it."""
    env_file = ROOT / "backend" / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            name, sep, value = line.partition("=")
            if sep and name.strip() == key:
                return value.strip()
    return None


ADMIN_DSN = (os.environ.get("KODI_TEST_ADMIN_DSN") or _dotenv_value("KODI_TEST_ADMIN_DSN")
             or "postgresql://postgres@localhost:54329/postgres")
TEST_DB = "kodi_test"
TEST_DSN = ADMIN_DSN.rsplit("/", 1)[0] + f"/{TEST_DB}"
MEDIA_DIR = tempfile.mkdtemp(prefix="kodi-media-")

os.environ.update({
    "KODI_ENV": "test",
    "KODI_DATABASE_URL": TEST_DSN,
    "KODI_JWT_SECRET": "test-secret-" + "x" * 40,
    "KODI_FERNET_KEY": Fernet.generate_key().decode(),
    "KODI_PUBLIC_BASE_URL": "https://api.example.test",
    "KODI_MEDIA_ROOT": MEDIA_DIR,
    "KODI_SCHEDULER_ENABLED": "false",
    "KODI_TURN_URLS": '["turn:turn.example.test:3478"]',
    "KODI_TURN_SECRET": "turn-secret",
    "KODI_CALL_RING_TIMEOUT_SECONDS": "30",
})
VAPID_PUBLIC, VAPID_PRIVATE = generate_vapid()
os.environ.update({"KODI_VAPID_PUBLIC_KEY": VAPID_PUBLIC, "KODI_VAPID_PRIVATE_KEY": VAPID_PRIVATE,
                   "KODI_VAPID_SUBJECT": "mailto:tests@example.com"})

SQL_FILES = [
    ROOT / "database" / "schema.sql",
    ROOT / "database" / "seeds" / "001_kenya_locations.sql",
    ROOT / "database" / "migrations" / "002_tenant_invites.sql",
    ROOT / "database" / "migrations" / "003_property_reviews.sql",
]


async def _build_database() -> None:
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
        await admin.execute(f"CREATE DATABASE {TEST_DB}")
    finally:
        await admin.close()
    conn = await asyncpg.connect(TEST_DSN)
    try:
        for path in SQL_FILES:
            await conn.execute(path.read_text(encoding="utf-8"))
    finally:
        await conn.close()


class FakeDaraja:
    """Stands in for Safaricom: accepts every STK push and records it."""

    def __init__(self) -> None:
        self.pushes: list[dict[str, Any]] = []
        self.query_result: dict[str, Any] = {"ResultCode": "1032", "ResultDesc": "Request cancelled by user"}

    async def stk_push(self, creds, *, phone, amount, account_reference, description, callback_url):
        n = len(self.pushes) + 1
        self.pushes.append({"phone": phone, "amount": amount, "account_reference": account_reference,
                            "callback_url": callback_url, "shortcode": creds.business_shortcode})
        return ({"PhoneNumber": phone, "Amount": amount},
                {"MerchantRequestID": f"29115-0000-{n}", "CheckoutRequestID": f"ws_CO_TEST_{n}",
                 "ResponseCode": "0", "ResponseDescription": "Success. Request accepted for processing",
                 "CustomerMessage": "Success. Request accepted for processing"})

    async def stk_query(self, creds, checkout_request_id):
        return self.query_result

    async def register_c2b_urls(self, creds, *, confirmation_url, validation_url):
        return {"ResponseCode": "0", "ResponseDescription": "Success"}

    async def aclose(self) -> None:
        pass


@pytest.fixture(scope="session")
def fake_daraja() -> FakeDaraja:
    return FakeDaraja()


class FakePushService:
    """Stands in for FCM / Mozilla autopush / Apple push: records each push."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.status_by_endpoint: dict[str, int] = {}

    def __call__(self, subscription: dict[str, Any], payload: str, headers: dict[str, str]) -> int:
        self.sent.append({"endpoint": subscription["endpoint"], "payload": json.loads(payload), "headers": headers})
        return self.status_by_endpoint.get(subscription["endpoint"], 201)


@pytest.fixture(scope="session")
def fake_push() -> FakePushService:
    return FakePushService()


@pytest.fixture(scope="session")
def client(fake_daraja, fake_push):
    asyncio.run(_build_database())
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app()
    app.state.daraja = fake_daraja
    from app.config import get_settings
    from app.services.push import PushSender
    app.state.push = PushSender(get_settings(), transport=fake_push)
    with TestClient(app) as test_client:
        yield test_client
    shutil.rmtree(MEDIA_DIR, ignore_errors=True)


def recv(ws, timeout: float = 5.0) -> dict[str, Any]:
    async def _receive():
        with anyio.fail_after(timeout):
            return await ws._send_rx.receive()
    message = ws.portal.call(_receive)
    if message["type"] == "websocket.close":
        raise AssertionError(f"socket closed: {message}")
    return json.loads(message["text"])


def wait_for(ws, predicate: Callable[[dict[str, Any]], bool], timeout: float = 5.0,
             max_messages: int = 50) -> dict[str, Any]:
    """Read frames until one matches (skips unrelated notifications/events)."""
    seen = []
    for _ in range(max_messages):
        msg = recv(ws, timeout)
        if predicate(msg):
            return msg
        seen.append((msg.get("type"), msg.get("event")))
    raise AssertionError(f"No matching frame; saw {seen}")


def ws_connect(client, token: str):
    ws = client.websocket_connect("/ws")
    session = ws.__enter__()
    session.send_json({"type": "auth", "token": token})
    ready = recv(session)
    assert ready["type"] == "ready", ready
    return ws, session, ready


# A valid 1x1 PNG (magic bytes are what the upload validator checks).
PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")
