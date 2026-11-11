"""Auth, session rotation and access-control boundaries."""
from __future__ import annotations


def _register(client, phone: str, name: str = "Test User") -> dict:
    r = client.post("/api/v1/auth/register", json={"full_name": name, "phone": phone, "password": "Pass-word-123"})
    assert r.status_code == 201, r.text
    return r.json()


def test_phone_normalisation_and_duplicates(client):
    _register(client, "0701 000 001")
    r = client.post("/api/v1/auth/register",
                    json={"full_name": "Dup", "phone": "+254701000001", "password": "Pass-word-123"})
    assert r.status_code == 409 and "already registered" in r.json()["detail"]
    r = client.post("/api/v1/auth/register", json={"full_name": "Bad", "phone": "0201234567", "password": "x" * 10})
    assert r.status_code == 422


def test_login_and_refresh_rotation_with_reuse_detection(client):
    _register(client, "0701000002")
    assert client.post("/api/v1/auth/login", json={"phone": "0701000002", "password": "wrong-pass"}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"phone": "0799999999", "password": "whatever1"}).status_code == 401
    first = client.post("/api/v1/auth/login", json={"phone": "0701000002", "password": "Pass-word-123"}).json()

    second = client.post("/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert second.status_code == 200
    second = second.json()
    assert second["refresh_token"] != first["refresh_token"]

    # Replaying the rotated-out token signals theft: every session is revoked.
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]}).status_code == 401
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": second["refresh_token"]}).status_code == 401


def test_account_isolation(client):
    owner = _register(client, "0701000003")
    outsider = _register(client, "0701000004")
    account = client.post("/api/v1/accounts", json={"business_name": "Private Homes"},
                          headers={"Authorization": f"Bearer {owner['access_token']}"}).json()
    r = client.get(f"/api/v1/accounts/{account['id']}/tenants",
                   headers={"Authorization": f"Bearer {outsider['access_token']}"})
    assert r.status_code == 404, "non-members must not learn the account exists"
    assert client.get(f"/api/v1/accounts/{account['id']}").status_code == 401


def test_viewer_cannot_write(client):
    owner = _register(client, "0701000005")
    viewer = _register(client, "0701000006")
    oh = {"Authorization": f"Bearer {owner['access_token']}"}
    account = client.post("/api/v1/accounts", json={"business_name": "Viewer Test"}, headers=oh).json()
    client.post(f"/api/v1/accounts/{account['id']}/members", json={"phone": "0701000006", "role": "viewer"},
                headers=oh)
    vh = {"Authorization": f"Bearer {viewer['access_token']}"}
    assert client.get(f"/api/v1/accounts/{account['id']}/properties", headers=vh).status_code == 200
    r = client.post(f"/api/v1/accounts/{account['id']}/properties", headers=vh,
                    json={"name": "X", "property_type": "other", "county_id": 1, "area": "Nyali"})
    assert r.status_code == 403
    r = client.request("DELETE", f"/api/v1/accounts/{account['id']}/members/{owner['user']['id']}", headers=oh)
    assert r.status_code == 409, "last owner cannot be removed"


def test_websocket_requires_auth(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "auth", "token": "not-a-jwt"})
        message = ws.receive()
        assert message["type"] == "websocket.close" and message["code"] == 4401
