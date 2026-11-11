"""Phase 3: Web Push delivery and PWA static hosting."""
from __future__ import annotations

import asyncio
import time

import asyncpg

from conftest import TEST_DSN, VAPID_PUBLIC

KEYS = {"p256dh": "BOrhR3a1QkqfVvJ7Wm0r0r5s9Q0dXn2wWm7cVvXy1u8G4xYz", "auth": "k3yAuthSecret123"}


def h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _sql(query: str, *args):
    async def run():
        conn = await asyncpg.connect(TEST_DSN)
        try:
            return await conn.fetchval(query, *args)
        finally:
            await conn.close()
    return asyncio.run(run())


def test_push_config_subscription_delivery_and_cleanup(client, fake_push):
    r = client.post("/api/v1/auth/register",
                    json={"full_name": "Brian Otieno", "phone": "0733 111 222", "password": "Push-pass-1"})
    token, user_id = r.json()["access_token"], r.json()["user"]["id"]

    cfg = client.get("/api/v1/push/config").json()
    assert cfg == {"enabled": True, "public_key": VAPID_PUBLIC}

    phone = "https://fcm.googleapis.com/fcm/send/device-phone"
    laptop = "https://updates.push.services.mozilla.com/wpush/v2/device-laptop"
    for endpoint in (phone, laptop):
        r = client.post("/api/v1/push-subscriptions", headers=h(token), json={"endpoint": endpoint, "keys": KEYS})
        assert r.status_code == 201, r.text
    assert client.post("/api/v1/push-subscriptions", headers=h(token),
                       json={"endpoint": "http://insecure.example", "keys": KEYS}).status_code == 422

    # Test push reaches both devices; a device the push service reports gone is removed.
    fake_push.status_by_endpoint[laptop] = 410
    r = client.post("/api/v1/push/test", headers=h(token))
    assert r.json() == {"devices": 1}
    assert {m["endpoint"] for m in fake_push.sent[-2:]} == {phone, laptop}
    assert _sql("SELECT count(*) FROM push_subscriptions WHERE user_id = $1::uuid", user_id) == 1

    # A notification created by the database is pushed exactly once via LISTEN/NOTIFY.
    before = len(fake_push.sent)
    notification_id = _sql(
        """INSERT INTO notifications (user_id, type, title, body, data)
           VALUES ($1::uuid, 'payment_received', 'Payment received', 'KES 20,000 via M-Pesa', '{"invoice_id": "abc"}')
           RETURNING id""", user_id)
    # pushed_at is claimed just before sending, so wait for the push itself.
    deadline = time.time() + 10
    while time.time() < deadline and len(fake_push.sent) == before:
        time.sleep(0.05)
    time.sleep(0.3)  # a duplicate push would arrive in this window
    assert _sql("SELECT pushed_at FROM notifications WHERE id = $1", notification_id) is not None
    pushed = fake_push.sent[before:]
    assert len(pushed) == 1
    payload = pushed[0]["payload"]
    assert payload["title"] == "Payment received" and payload["url"] == "/#/payments"
    assert payload["tag"] == "payment_received:abc" and pushed[0]["headers"]["Urgency"] == "high"

    # Unsubscribe.
    assert client.request("DELETE", "/api/v1/push-subscriptions", headers=h(token),
                          json={"endpoint": phone}).status_code == 204
    assert client.post("/api/v1/push/test", headers=h(token)).json() == {"devices": 0}


def test_pwa_static_hosting(client):
    index = client.get("/")
    assert index.status_code == 200 and 'rel="manifest"' in index.text
    assert index.headers["cache-control"] == "no-cache"

    sw = client.get("/sw.js")
    assert sw.status_code == 200 and sw.headers["cache-control"] == "no-cache"
    assert sw.headers["service-worker-allowed"] == "/"
    assert "javascript" in sw.headers["content-type"]

    manifest = client.get("/manifest.json")
    assert manifest.headers["content-type"].startswith("application/manifest+json")
    data = manifest.json()
    assert data["display"] == "standalone" and data["start_url"].startswith("/")
    sizes = {(i["sizes"], i.get("purpose", "any")) for i in data["icons"]}
    assert {("192x192", "any"), ("512x512", "any"), ("512x512", "maskable")} <= sizes
    for icon in data["icons"]:
        res = client.get(icon["src"])
        assert res.status_code == 200 and res.content.startswith(b"\x89PNG"), icon["src"]
        assert "max-age=2592000" in res.headers["cache-control"]

    # Every precached shell file must exist, or the service worker install fails.
    import re
    shell = re.search(r"const SHELL = \[(.*?)\];", sw.text, re.S).group(1)
    precached = set(re.findall(r"'([^']+)'", shell))
    for path in precached:
        assert client.get(path).status_code == 200, path
    # ...and every app module must be precached, or that screen breaks offline.
    from pathlib import Path
    frontend = Path(__file__).resolve().parents[2] / "frontend"
    modules = {"/" + p.relative_to(frontend).as_posix() for p in (frontend / "js").rglob("*.js")}
    assert modules <= precached, f"Add to SHELL in sw.js: {sorted(modules - precached)}"

    # API routes still win over the static mount.
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/api/v1/locations/counties").status_code == 200
    assert client.get("/does-not-exist.js").status_code == 404
