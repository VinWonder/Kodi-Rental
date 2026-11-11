"""Public Safaricom Daraja webhooks.

Rules that keep money safe:
1. Every hit is stored raw (mpesa_callbacks) before anything else happens.
2. Safaricom always gets an immediate 200 "Accepted"; processing failures are
   recorded and retried by the scheduler instead of making Safaricom resend.
3. Processing is idempotent (unique M-Pesa receipt numbers), so retries and
   duplicate callbacks never double-credit a tenant.
"""
from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from ..config import Settings
from ..db import db
from ..deps import SettingsDep
from ..services import mpesa
from ..utils import client_ip

log = logging.getLogger("kodi.hooks")
router = APIRouter(prefix="/hooks", tags=["daraja-webhooks"], include_in_schema=False)

ACCEPTED = {"ResultCode": 0, "ResultDesc": "Accepted"}
_SAFE_HEADERS = {"content-type", "user-agent", "x-forwarded-for", "x-real-ip", "host"}


async def _resolve(token: str, request: Request, settings: Settings) -> tuple[UUID, str | None]:
    ip = client_ip(request, settings.trust_proxy_headers)
    if settings.mpesa_callback_ip_allowlist and ip not in settings.mpesa_callback_ip_allowlist:
        log.warning("Rejected Daraja callback from unlisted IP %s", ip)
        raise HTTPException(403, "Forbidden")
    account_id = await db.fetchval("SELECT account_id FROM account_mpesa_settings WHERE callback_token = $1", token)
    if account_id is None:
        raise HTTPException(404, "Not found")
    return account_id, ip


async def _payload(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {"_raw": data}
    except ValueError:
        return {"_raw": (await request.body()).decode(errors="replace")[:10000]}


def _headers(request: Request) -> dict[str, str]:
    return {k: v for k, v in request.headers.items() if k.lower() in _SAFE_HEADERS}


@router.post("/{token}/stk")
async def stk_callback(token: str, request: Request, settings: SettingsDep):
    account_id, ip = await _resolve(token, request, settings)
    payload = await _payload(request)
    callback_id = await mpesa.store_callback(account_id=account_id, callback_type="stk_callback",
                                             source_ip=ip, headers=_headers(request), payload=payload)
    await mpesa.process_callback(callback_id, "stk_callback")
    return ACCEPTED


@router.post("/{token}/c2b/validate")
async def c2b_validate(token: str, request: Request, settings: SettingsDep):
    """Only called if Safaricom enabled External Validation on the shortcode."""
    account_id, ip = await _resolve(token, request, settings)
    payload = await _payload(request)
    callback_id = await mpesa.store_callback(account_id=account_id, callback_type="c2b_validation",
                                             source_ip=ip, headers=_headers(request), payload=payload)
    known = await mpesa.c2b_reference_known(account_id, payload.get("BillRefNumber"))
    await db.execute(
        "UPDATE mpesa_callbacks SET processed_at = now(), trans_id = $2, processing_error = $3 WHERE id = $1",
        callback_id, payload.get("TransID"), None if known else "Unknown account number")
    if not known and settings.mpesa_c2b_reject_unknown_ref:
        return {"ResultCode": "C2B00012", "ResultDesc": "Rejected"}  # "Invalid Account Number"
    return {"ResultCode": "0", "ResultDesc": "Accepted"}


@router.post("/{token}/c2b/confirm")
async def c2b_confirm(token: str, request: Request, settings: SettingsDep):
    account_id, ip = await _resolve(token, request, settings)
    payload = await _payload(request)
    callback_id = await mpesa.store_callback(account_id=account_id, callback_type="c2b_confirmation",
                                             source_ip=ip, headers=_headers(request), payload=payload)
    await mpesa.process_callback(callback_id, "c2b_confirmation")
    return ACCEPTED
