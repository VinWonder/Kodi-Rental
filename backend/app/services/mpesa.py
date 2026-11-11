"""M-Pesa business flows on top of the Daraja client and the SQL functions
from Phase 1 (fn_process_stk_callback / fn_process_c2b_confirmation)."""
from __future__ import annotations

import logging
import math
import re
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import HTTPException

from ..config import Settings
from ..db import db
from ..security import SecretBox
from .daraja import DarajaClient, DarajaError, callback_urls, load_credentials

log = logging.getLogger("kodi.mpesa")

STK_COLUMNS = """id, account_id, invoice_id, lease_id, tenant_id, phone, amount, account_reference,
                 merchant_request_id, checkout_request_id, status, response_description,
                 customer_message, result_code, result_desc, mpesa_receipt_number,
                 created_at, completed_at"""

_PROCESSORS = {
    "stk_callback": "fn_process_stk_callback",
    "c2b_confirmation": "fn_process_c2b_confirmation",
}

# Daraja result codes -> our stk_status
_RESULT_STATUS = {1032: "cancelled", 1037: "timeout", 1019: "timeout"}


async def initiate_stk_push(
    *,
    account_id: UUID,
    invoice_id: UUID,
    phone: str | None,
    amount: int | None,
    initiated_by: UUID,
    client_ip: str | None,
    daraja: DarajaClient,
    box: SecretBox,
    settings: Settings,
) -> dict[str, Any]:
    # 1. Validate and record the request (committed before calling Safaricom,
    #    so a fast callback always finds its row).
    async with db.tx(user_id=initiated_by, client_ip=client_ip) as conn:
        inv = await conn.fetchrow(
            """SELECT i.id, i.status, i.balance, i.lease_id, i.tenant_id, i.invoice_number,
                      u.payment_code, t.phone AS tenant_phone
               FROM invoices i
               JOIN units u   ON u.id = i.unit_id
               JOIN tenants t ON t.id = i.tenant_id
               WHERE i.id = $1 AND i.account_id = $2""",
            invoice_id, account_id,
        )
        if inv is None:
            raise HTTPException(404, "Invoice not found")
        if inv["status"] not in ("issued", "partially_paid", "overdue") or inv["balance"] <= 0:
            raise HTTPException(409, "This invoice has no outstanding balance")

        # Daraja only accepts whole shillings: round pro-rated balances up.
        max_amount = int(math.ceil(Decimal(inv["balance"])))
        charge = amount or max_amount
        if not 1 <= charge <= max_amount:
            raise HTTPException(422, f"Amount must be between KES 1 and KES {max_amount:,}")
        msisdn = phone or inv["tenant_phone"]

        creds = await load_credentials(conn, account_id, box)
        stk_id = await conn.fetchval(
            """INSERT INTO mpesa_stk_requests (account_id, invoice_id, lease_id, tenant_id, initiated_by,
                                               phone, amount, account_reference, transaction_desc, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Rent payment', 'initiated')
               RETURNING id""",
            account_id, invoice_id, inv["lease_id"], inv["tenant_id"], initiated_by,
            msisdn, charge, inv["payment_code"][:12],
        )

    # 2. Call Safaricom outside any DB transaction.
    urls = callback_urls(settings, creds.callback_token)
    try:
        request_payload, response = await daraja.stk_push(
            creds, phone=msisdn, amount=charge, account_reference=inv["payment_code"],
            description="Rent payment", callback_url=urls["stk_callback_url"],
        )
    except DarajaError as exc:
        await db.execute(
            """UPDATE mpesa_stk_requests
                  SET status = 'failed', response_description = $2, response_payload = $3, completed_at = now()
                WHERE id = $1""",
            stk_id, str(exc)[:500], exc.payload,
        )
        raise HTTPException(502, f"M-Pesa did not accept the request: {exc}") from exc

    accepted = str(response.get("ResponseCode")) == "0"
    row = await db.fetchrow(
        f"""UPDATE mpesa_stk_requests
               SET merchant_request_id = $2, checkout_request_id = $3, response_code = $4,
                   response_description = $5, customer_message = $6,
                   request_payload = $7, response_payload = $8,
                   status = $9::stk_status,
                   completed_at = CASE WHEN $9::stk_status = 'failed' THEN now() END
             WHERE id = $1
         RETURNING {STK_COLUMNS}""",
        stk_id, response.get("MerchantRequestID"), response.get("CheckoutRequestID"),
        str(response.get("ResponseCode")), response.get("ResponseDescription"),
        response.get("CustomerMessage"), request_payload, response,
        "pending" if accepted else "failed",
    )
    if not accepted:
        raise HTTPException(502, f"M-Pesa rejected the request: {response.get('ResponseDescription')}")
    return dict(row)


async def query_stk_request(
    *, account_id: UUID, stk_id: UUID, daraja: DarajaClient, box: SecretBox
) -> dict[str, Any]:
    """Ask Safaricom for the status of a prompt whose callback has not arrived.
    STK Query never returns the receipt number, so success is left to the
    callback (or the C2B confirmation); only failures are applied here."""
    row = await db.fetchrow(f"SELECT {STK_COLUMNS} FROM mpesa_stk_requests WHERE id = $1 AND account_id = $2",
                            stk_id, account_id)
    if row is None:
        raise HTTPException(404, "Payment request not found")
    result = dict(row)
    if row["status"] not in ("initiated", "pending") or not row["checkout_request_id"]:
        return result

    async with db.tx() as conn:
        creds = await load_credentials(conn, account_id, box)
    try:
        response = await daraja.stk_query(creds, row["checkout_request_id"])
    except DarajaError as exc:
        # Daraja answers "The transaction is being processed" with an HTTP error.
        result["query_message"] = str(exc)
        return result

    code = response.get("ResultCode")
    result["query_message"] = response.get("ResultDesc")
    if code is not None and str(code) != "0":
        status = _RESULT_STATUS.get(int(code), "failed")
        updated = await db.fetchrow(
            f"""UPDATE mpesa_stk_requests
                   SET status = $2::stk_status, result_code = $3, result_desc = $4, completed_at = now()
                 WHERE id = $1 AND status IN ('initiated', 'pending')
             RETURNING {STK_COLUMNS}""",
            stk_id, status, int(code), response.get("ResultDesc"),
        )
        if updated:
            result.update(dict(updated))
    return result


async def store_callback(
    *, account_id: UUID, callback_type: str, source_ip: str | None,
    headers: dict[str, str], payload: dict[str, Any],
) -> int:
    return await db.fetchval(
        """INSERT INTO mpesa_callbacks (account_id, callback_type, source_ip, http_headers, payload)
           VALUES ($1, $2, $3::inet, $4, $5) RETURNING id""",
        account_id, callback_type, source_ip, headers, payload,
    )


async def process_callback(callback_id: int, callback_type: str) -> UUID | None:
    """Run the SQL ingestion function. Failures are recorded on the raw row and
    retried by the scheduler, so Safaricom always gets an immediate 200."""
    function = _PROCESSORS[callback_type]
    try:
        async with db.tx() as conn:
            return await conn.fetchval(f"SELECT {function}($1)", callback_id)
    except Exception as exc:  # noqa: BLE001 - we must never fail the webhook
        log.exception("Processing %s callback %s failed", callback_type, callback_id)
        await db.execute(
            "UPDATE mpesa_callbacks SET processing_error = $2 WHERE id = $1",
            callback_id, f"{type(exc).__name__}: {exc}"[:1000],
        )
        return None


async def c2b_reference_known(account_id: UUID, bill_ref: str | None) -> bool:
    ref = re.sub(r"\s", "", bill_ref or "").upper()
    if not ref:
        return False
    return await db.fetchval(
        """SELECT EXISTS (SELECT 1 FROM units u
                            JOIN leases l ON l.unit_id = u.id AND l.status IN ('active', 'notice_given')
                           WHERE u.account_id = $1 AND u.payment_code = $2)
               OR EXISTS (SELECT 1 FROM invoices WHERE account_id = $1 AND invoice_number = $2)
               OR EXISTS (SELECT 1 FROM tenants t
                            JOIN leases l ON l.tenant_id = t.id AND l.status IN ('active', 'notice_given')
                           WHERE t.account_id = $1 AND t.id_document_number = $2)""",
        account_id, ref,
    )
