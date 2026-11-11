"""Unit tests for the real Daraja HTTP client using a mocked transport."""
from __future__ import annotations

import asyncio
import base64
import json
import uuid

import httpx

from app.config import get_settings
from app.services.daraja import DarajaClient, DarajaCredentials


def _creds(**overrides) -> DarajaCredentials:
    base = dict(account_id=uuid.uuid4(), environment="sandbox", shortcode_type="paybill",
                business_shortcode="174379", stk_party_b=None, consumer_key="key", consumer_secret="secret",
                passkey="passkey123", callback_token="tok")
    base.update(overrides)
    return DarajaCredentials(**base)


def _run(handler, coro_factory):
    async def main():
        client = DarajaClient(get_settings(), http=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        try:
            return await coro_factory(client)
        finally:
            await client.aclose()
    return asyncio.run(main())


def test_stk_push_payload_and_token_cache():
    calls = {"oauth": 0, "stk": []}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/v1/generate":
            calls["oauth"] += 1
            assert request.headers["Authorization"] == "Basic " + base64.b64encode(b"key:secret").decode()
            return httpx.Response(200, json={"access_token": "tkn", "expires_in": "3599"})
        assert request.headers["Authorization"] == "Bearer tkn"
        body = json.loads(request.content)
        calls["stk"].append(body)
        return httpx.Response(200, json={"MerchantRequestID": "m", "CheckoutRequestID": "c", "ResponseCode": "0"})

    async def flow(client: DarajaClient):
        creds = _creds()
        for _ in range(2):
            sanitised, resp = await client.stk_push(creds, phone="254708374149", amount=1500,
                                                    account_reference="SUNRISE-A1-LONGREF", description="Rent payment",
                                                    callback_url="https://x/hooks/tok/stk")
        return sanitised, resp

    sanitised, resp = _run(handler, flow)
    assert calls["oauth"] == 1, "token must be cached between requests"
    body = calls["stk"][0]
    expected_password = base64.b64encode(f"174379passkey123{body['Timestamp']}".encode()).decode()
    assert body["Password"] == expected_password
    assert body["TransactionType"] == "CustomerPayBillOnline"
    assert body["PartyB"] == "174379" and body["PartyA"] == "254708374149"
    assert body["AccountReference"] == "SUNRISE-A1-L" and len(body["TransactionDesc"]) <= 13
    assert "Password" not in sanitised and resp["ResponseCode"] == "0"


def test_till_uses_buy_goods_and_retries_after_401():
    state = {"oauth": 0, "stk": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/v1/generate":
            state["oauth"] += 1
            return httpx.Response(200, json={"access_token": f"t{state['oauth']}", "expires_in": "3599"})
        state["stk"] += 1
        if state["stk"] == 1:
            return httpx.Response(401, json={"errorMessage": "Invalid Access Token"})
        body = json.loads(request.content)
        assert body["TransactionType"] == "CustomerBuyGoodsOnline" and body["PartyB"] == "5432101"
        return httpx.Response(200, json={"ResponseCode": "0"})

    _run(handler, lambda c: c.stk_push(_creds(shortcode_type="till", stk_party_b="5432101"), phone="254708374149",
                                       amount=10, account_reference="A", description="Rent",
                                       callback_url="https://x"))
    assert state == {"oauth": 2, "stk": 2}
