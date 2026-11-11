"""Safaricom Daraja client: OAuth token cache, STK Push, STK Query and C2B URL
registration. One instance is shared by the app (holds an httpx pool)."""
from __future__ import annotations

import asyncio
import base64
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import asyncpg
import httpx
from fastapi import HTTPException

from ..config import Settings
from ..security import SecretBox
from ..utils import EAT

log = logging.getLogger("kodi.daraja")


class DarajaError(Exception):
    def __init__(self, message: str, payload: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.payload = payload or {}


@dataclass(frozen=True, slots=True)
class DarajaCredentials:
    account_id: UUID
    environment: str
    shortcode_type: str
    business_shortcode: str
    stk_party_b: str | None
    consumer_key: str
    consumer_secret: str
    passkey: str
    callback_token: str


async def load_credentials(conn: asyncpg.Connection, account_id: UUID, box: SecretBox) -> DarajaCredentials:
    row = await conn.fetchrow(
        """SELECT environment, shortcode_type, business_shortcode, stk_party_b,
                  consumer_key_enc, consumer_secret_enc, passkey_enc, callback_token
           FROM account_mpesa_settings WHERE account_id = $1 AND is_active""",
        account_id,
    )
    if row is None:
        raise HTTPException(409, "M-Pesa is not configured for this account. Add your Daraja credentials first.")
    return DarajaCredentials(
        account_id=account_id,
        environment=row["environment"],
        shortcode_type=row["shortcode_type"],
        business_shortcode=row["business_shortcode"],
        stk_party_b=row["stk_party_b"],
        consumer_key=box.decrypt(row["consumer_key_enc"]),
        consumer_secret=box.decrypt(row["consumer_secret_enc"]),
        passkey=box.decrypt(row["passkey_enc"]),
        callback_token=row["callback_token"],
    )


class DarajaClient:
    def __init__(self, settings: Settings, http: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self.http = http or httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
        self._tokens: dict[tuple[str, str], tuple[str, float]] = {}
        self._lock = asyncio.Lock()

    def base_url(self, environment: str) -> str:
        return (self.settings.mpesa_production_base_url if environment == "production"
                else self.settings.mpesa_sandbox_base_url).rstrip("/")

    async def aclose(self) -> None:
        await self.http.aclose()

    # ---------------------------------------------------------------- auth
    async def _token(self, creds: DarajaCredentials, *, force: bool = False) -> str:
        key = (creds.environment, creds.consumer_key)
        cached = self._tokens.get(key)
        if cached and not force and cached[1] > time.monotonic():
            return cached[0]
        async with self._lock:
            cached = self._tokens.get(key)
            if cached and not force and cached[1] > time.monotonic():
                return cached[0]
            basic = base64.b64encode(f"{creds.consumer_key}:{creds.consumer_secret}".encode()).decode()
            try:
                resp = await self.http.get(
                    f"{self.base_url(creds.environment)}/oauth/v1/generate",
                    params={"grant_type": "client_credentials"},
                    headers={"Authorization": f"Basic {basic}"},
                )
            except httpx.HTTPError as exc:
                raise DarajaError(f"Could not reach Safaricom: {exc}") from exc
            if resp.status_code != 200:
                raise DarajaError("Daraja rejected the consumer key/secret", {"status": resp.status_code})
            data = resp.json()
            ttl = int(data.get("expires_in", 3599))
            # Refresh a minute early to avoid using a token as it expires.
            self._tokens[key] = (data["access_token"], time.monotonic() + max(ttl - 60, 30))
            return data["access_token"]

    async def _post(self, creds: DarajaCredentials, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url(creds.environment)}{path}"
        for attempt in (1, 2):
            token = await self._token(creds, force=attempt == 2)
            try:
                resp = await self.http.post(url, json=payload, headers={"Authorization": f"Bearer {token}"})
            except httpx.HTTPError as exc:
                raise DarajaError(f"Could not reach Safaricom: {exc}") from exc
            if resp.status_code == 401 and attempt == 1:
                continue
            try:
                data = resp.json()
            except ValueError:
                data = {"raw": resp.text[:500]}
            if resp.status_code >= 400:
                message = data.get("errorMessage") or data.get("ResponseDescription") or f"HTTP {resp.status_code}"
                raise DarajaError(message, data)
            return data
        raise DarajaError("Daraja authentication failed")

    # ------------------------------------------------------------ helpers
    @staticmethod
    def timestamp() -> str:
        return datetime.now(EAT).strftime("%Y%m%d%H%M%S")

    @staticmethod
    def password(shortcode: str, passkey: str, timestamp: str) -> str:
        return base64.b64encode(f"{shortcode}{passkey}{timestamp}".encode()).decode()

    # ------------------------------------------------------------ endpoints
    async def stk_push(
        self,
        creds: DarajaCredentials,
        *,
        phone: str,
        amount: int,
        account_reference: str,
        description: str,
        callback_url: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Returns (sanitised_request, response)."""
        ts = self.timestamp()
        is_till = creds.shortcode_type == "till"
        payload = {
            "BusinessShortCode": creds.business_shortcode,
            "Password": self.password(creds.business_shortcode, creds.passkey, ts),
            "Timestamp": ts,
            "TransactionType": "CustomerBuyGoodsOnline" if is_till else "CustomerPayBillOnline",
            "Amount": amount,
            "PartyA": phone,
            "PartyB": creds.stk_party_b if is_till else creds.business_shortcode,
            "PhoneNumber": phone,
            "CallBackURL": callback_url,
            "AccountReference": account_reference[:12],
            "TransactionDesc": description[:13],
        }
        response = await self._post(creds, "/mpesa/stkpush/v1/processrequest", payload)
        sanitised = {k: v for k, v in payload.items() if k != "Password"}
        return sanitised, response

    async def stk_query(self, creds: DarajaCredentials, checkout_request_id: str) -> dict[str, Any]:
        ts = self.timestamp()
        return await self._post(creds, "/mpesa/stkpushquery/v1/query", {
            "BusinessShortCode": creds.business_shortcode,
            "Password": self.password(creds.business_shortcode, creds.passkey, ts),
            "Timestamp": ts,
            "CheckoutRequestID": checkout_request_id,
        })

    async def register_c2b_urls(self, creds: DarajaCredentials, *, confirmation_url: str,
                                validation_url: str) -> dict[str, Any]:
        # "Completed": if our validation URL is unreachable, Safaricom completes the payment anyway.
        return await self._post(creds, "/mpesa/c2b/v2/registerurl", {
            "ShortCode": creds.business_shortcode,
            "ResponseType": "Completed",
            "ConfirmationURL": confirmation_url,
            "ValidationURL": validation_url,
        })


def callback_urls(settings: Settings, callback_token: str) -> dict[str, str]:
    # Daraja refuses C2B URLs containing words such as "mpesa", "safaricom",
    # "query", "exec" or "sql", hence the neutral /hooks/ prefix.
    base = settings.public_base_url.rstrip("/")
    return {
        "stk_callback_url": f"{base}/hooks/{callback_token}/stk",
        "c2b_validation_url": f"{base}/hooks/{callback_token}/c2b/validate",
        "c2b_confirmation_url": f"{base}/hooks/{callback_token}/c2b/confirm",
    }
