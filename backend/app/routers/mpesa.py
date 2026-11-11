"""STK Push initiation (landlord-triggered and tenant self-pay) and status."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..db import as_dicts, db, or_404
from ..deps import AnyMember, Finance, IpDep, SettingsDep, UserDep
from ..services import mpesa
from ..state import BoxDep, DarajaDep
from ..utils import KePhone

router = APIRouter(tags=["mpesa"])


class StkPushIn(BaseModel):
    phone: KePhone | None = Field(default=None, description="Defaults to the tenant's M-Pesa number")
    amount: int | None = Field(default=None, ge=1, le=250_000, description="Defaults to the full balance")


@router.post("/accounts/{account_id}/invoices/{invoice_id}/stk-push", status_code=202)
async def landlord_stk_push(invoice_id: UUID, body: StkPushIn, m: Finance, ip: IpDep,
                            daraja: DarajaDep, box: BoxDep, settings: SettingsDep):
    """Sends the 'Enter M-Pesa PIN' prompt to the tenant's phone. The result
    arrives on the Safaricom callback and is pushed to the dashboard over the
    WebSocket (event `payment_recorded` / `invoice_status_changed`)."""
    return await mpesa.initiate_stk_push(
        account_id=m.account_id, invoice_id=invoice_id, phone=body.phone, amount=body.amount,
        initiated_by=m.user.id, client_ip=ip, daraja=daraja, box=box, settings=settings)


@router.get("/accounts/{account_id}/stk-requests")
async def list_stk_requests(
    m: AnyMember,
    stk_status: Literal["initiated", "pending", "success", "failed", "cancelled", "timeout"] | None =
        Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
):
    return as_dicts(await db.fetch(
        f"""SELECT {mpesa.STK_COLUMNS} FROM mpesa_stk_requests
            WHERE account_id = $1 AND ($2::stk_status IS NULL OR status = $2)
            ORDER BY created_at DESC LIMIT $3""", m.account_id, stk_status, limit))


@router.get("/accounts/{account_id}/stk-requests/{stk_id}")
async def get_stk_request(stk_id: UUID, m: AnyMember):
    return or_404(await db.fetchrow(
        f"SELECT {mpesa.STK_COLUMNS} FROM mpesa_stk_requests WHERE id = $1 AND account_id = $2",
        stk_id, m.account_id), "Payment request")


@router.post("/accounts/{account_id}/stk-requests/{stk_id}/query")
async def query_stk_request(stk_id: UUID, m: Finance, daraja: DarajaDep, box: BoxDep):
    return await mpesa.query_stk_request(account_id=m.account_id, stk_id=stk_id, daraja=daraja, box=box)


# ------------------------------------------------------------------ tenant self-pay
@router.post("/me/invoices/{invoice_id}/stk-push", status_code=202)
async def tenant_stk_push(invoice_id: UUID, body: StkPushIn, user: UserDep, ip: IpDep,
                          daraja: DarajaDep, box: BoxDep, settings: SettingsDep):
    account_id = await db.fetchval(
        """SELECT i.account_id FROM invoices i JOIN tenants t ON t.id = i.tenant_id
           WHERE i.id = $1 AND t.user_id = $2""", invoice_id, user.id)
    if account_id is None:
        raise HTTPException(404, "Invoice not found")
    return await mpesa.initiate_stk_push(
        account_id=account_id, invoice_id=invoice_id, phone=body.phone, amount=body.amount,
        initiated_by=user.id, client_ip=ip, daraja=daraja, box=box, settings=settings)


@router.get("/me/stk-requests/{stk_id}")
async def tenant_stk_status(stk_id: UUID, user: UserDep):
    return or_404(await db.fetchrow(
        f"""SELECT {', '.join('s.' + c.strip() for c in mpesa.STK_COLUMNS.split(','))}
            FROM mpesa_stk_requests s JOIN tenants t ON t.id = s.tenant_id
            WHERE s.id = $1 AND t.user_id = $2""", stk_id, user.id), "Payment request")
