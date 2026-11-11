"""Room allocation (leases) for landlords, and lease signing for tenants.
Allocation creates a 'pending_signature' lease (unit becomes 'reserved');
the tenant's signature activates it, which starts billing (database trigger)."""
from __future__ import annotations

import hashlib
from datetime import date
from decimal import Decimal
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, model_validator

from ..db import as_dicts, db, or_404
from ..deps import AnyMember, IpDep, Staff, UserDep
from ..utils import Money, PositiveMoney

router = APIRouter(tags=["leases"])

LEASE_COLUMNS = """l.id, l.account_id, l.unit_id, u.unit_number, p.id AS property_id, p.name AS property_name,
                   l.tenant_id, t.full_name AS tenant_name, t.phone AS tenant_phone, l.lease_number, l.status,
                   l.start_date, l.end_date, l.monthly_rent, l.deposit_amount, l.vat_rate, l.billing_cycle,
                   l.billing_day, l.payment_due_days, l.next_billing_date, l.late_fee_type, l.late_fee_value,
                   l.notice_period_days, l.terms_version, l.terms_sha256, l.lease_document_media_id,
                   l.signature_media_id, l.signed_at, l.activated_at, l.notice_given_at, l.terminated_at,
                   l.termination_reason, l.created_at, l.updated_at,
                   u.payment_code, ms.shortcode_type AS paybill_type, ms.business_shortcode AS paybill_number"""
# Paybill/till number and the unit's account number let tenants pay from the
# M-Pesa menu as well as via STK prompts (both are public payment details).
LEASE_FROM = """leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
                JOIN tenants t ON t.id = l.tenant_id
                LEFT JOIN account_mpesa_settings ms ON ms.account_id = l.account_id"""
LeaseStatus = Literal["draft", "pending_signature", "active", "notice_given", "terminated", "expired"]


class LeaseIn(BaseModel):
    unit_id: UUID
    tenant_id: UUID
    start_date: date
    end_date: date | None = Field(default=None, description="Move-out date (exclusive); omit for periodic tenancy")
    monthly_rent: PositiveMoney | None = Field(default=None, description="Defaults to the unit's rent")
    deposit_amount: Money | None = Field(default=None, description="Defaults to the unit's deposit")
    vat_rate: Decimal = Field(default=Decimal(0), ge=0, le=100, description="16 for commercial premises")
    billing_cycle: Literal["every_30_days", "fixed_monthly_day"] = "every_30_days"
    billing_day: int | None = Field(default=None, ge=1, le=28)
    payment_due_days: int | None = Field(default=None, ge=0, le=28)
    late_fee_type: Literal["none", "flat", "percent"] = "none"
    late_fee_value: Money = 0
    notice_period_days: int = Field(default=30, ge=0, le=365)
    terms_version: str = Field(default="v1", max_length=20)
    terms_snapshot: str = Field(min_length=20, max_length=100_000, description="Exact text the tenant will sign")
    lease_document_media_id: UUID | None = None

    @model_validator(mode="after")
    def check(self):
        if self.end_date and self.end_date <= self.start_date:
            raise ValueError("end_date must be after start_date")
        if self.billing_cycle == "fixed_monthly_day" and self.billing_day is None:
            raise ValueError("billing_day is required for fixed_monthly_day")
        if self.late_fee_type == "percent" and self.late_fee_value > 100:
            raise ValueError("Percentage late fee cannot exceed 100")
        return self


class NoticeIn(BaseModel):
    move_out_date: date
    reason: str | None = Field(default=None, max_length=500)


class TerminateIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class SignIn(BaseModel):
    accept_terms: Literal[True]
    terms_sha256: str = Field(pattern=r"^[0-9a-f]{64}$", description="SHA-256 of the terms text shown to the tenant")
    signature_media_id: UUID


async def _fetch_lease(lease_id: UUID, *, account_id: UUID | None = None, tenant_user: UUID | None = None,
                       include_terms: bool = False) -> dict:
    extra = ", l.terms_snapshot" if include_terms else ""
    row = await db.fetchrow(
        f"""SELECT {LEASE_COLUMNS}{extra} FROM {LEASE_FROM}
            WHERE l.id = $1 AND ($2::uuid IS NULL OR l.account_id = $2) AND ($3::uuid IS NULL OR t.user_id = $3)""",
        lease_id, account_id, tenant_user)
    return or_404(row, "Lease")


# ------------------------------------------------------------------ landlord
@router.post("/accounts/{account_id}/leases", status_code=status.HTTP_201_CREATED)
async def allocate_unit(body: LeaseIn, m: Staff, ip: IpDep):
    terms_hash = hashlib.sha256(body.terms_snapshot.encode()).hexdigest()
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        tenant = await conn.fetchrow("SELECT full_name, is_blacklisted FROM tenants WHERE id = $1 AND account_id = $2",
                                     body.tenant_id, m.account_id)
        if tenant is None:
            raise HTTPException(404, "Tenant not found")
        if tenant["is_blacklisted"]:
            raise HTTPException(409, f"{tenant['full_name']} is blacklisted on this account")
        if body.lease_document_media_id:
            ok = await conn.fetchval(
                """SELECT EXISTS (SELECT 1 FROM media_files WHERE id = $1 AND account_id = $2
                                  AND purpose = 'lease_document' AND deleted_at IS NULL)""",
                body.lease_document_media_id, m.account_id)
            if not ok:
                raise HTTPException(422, "Upload the lease PDF with purpose=lease_document first")
        lease_id = await conn.fetchval(
            """INSERT INTO leases (account_id, unit_id, tenant_id, status, start_date, end_date, monthly_rent,
                                   deposit_amount, vat_rate, billing_cycle, billing_day, payment_due_days,
                                   late_fee_type, late_fee_value, notice_period_days, terms_version,
                                   terms_snapshot, terms_sha256, lease_document_media_id)
               VALUES ($1, $2, $3, 'pending_signature', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                       $16, $17, $18)
               RETURNING id""",
            m.account_id, body.unit_id, body.tenant_id, body.start_date, body.end_date, body.monthly_rent,
            body.deposit_amount, body.vat_rate, body.billing_cycle, body.billing_day, body.payment_due_days,
            body.late_fee_type, body.late_fee_value, body.notice_period_days, body.terms_version,
            body.terms_snapshot, terms_hash, body.lease_document_media_id)
        await conn.execute(
            "SELECT fn_notify_tenant($1, 'system', 'Your lease is ready to sign', $2, $3)",
            body.tenant_id, "Review and sign your tenancy agreement to activate your unit.",
            {"lease_id": str(lease_id)})
    return await _fetch_lease(lease_id, account_id=m.account_id)


@router.get("/accounts/{account_id}/leases")
async def list_leases(
    m: AnyMember,
    lease_status: LeaseStatus | None = Query(default=None, alias="status"),
    unit_id: UUID | None = None,
    tenant_id: UUID | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    rows = await db.fetch(
        f"""SELECT {LEASE_COLUMNS} FROM {LEASE_FROM}
            WHERE l.account_id = $1 AND ($2::lease_status IS NULL OR l.status = $2)
              AND ($3::uuid IS NULL OR l.unit_id = $3) AND ($4::uuid IS NULL OR l.tenant_id = $4)
            ORDER BY l.start_date DESC LIMIT $5 OFFSET $6""",
        m.account_id, lease_status, unit_id, tenant_id, limit, offset)
    return as_dicts(rows)


@router.get("/accounts/{account_id}/leases/{lease_id}")
async def get_lease(lease_id: UUID, m: AnyMember):
    return await _fetch_lease(lease_id, account_id=m.account_id, include_terms=True)


@router.post("/accounts/{account_id}/leases/{lease_id}/notice")
async def give_notice(lease_id: UUID, body: NoticeIn, m: Staff, ip: IpDep):
    async with db.tx(user_id=m.user.id, reason=body.reason, client_ip=ip) as conn:
        lease = or_404(await conn.fetchrow(
            "SELECT status, start_date FROM leases WHERE id = $1 AND account_id = $2 FOR UPDATE",
            lease_id, m.account_id), "Lease")
        if lease["status"] != "active":
            raise HTTPException(409, "Notice can only be given on an active lease")
        if body.move_out_date <= lease["start_date"]:
            raise HTTPException(422, "move_out_date must be after the lease start date")
        await conn.execute("UPDATE leases SET status = 'notice_given', end_date = $2 WHERE id = $1",
                           lease_id, body.move_out_date)
    return await _fetch_lease(lease_id, account_id=m.account_id)


@router.post("/accounts/{account_id}/leases/{lease_id}/terminate")
async def terminate_lease(lease_id: UUID, body: TerminateIn, m: Staff, ip: IpDep):
    """Immediate move-out. The unit moves to 'cleaning'; mark it vacant when ready."""
    async with db.tx(user_id=m.user.id, reason=body.reason, client_ip=ip) as conn:
        lease = or_404(await conn.fetchrow(
            "SELECT status FROM leases WHERE id = $1 AND account_id = $2 FOR UPDATE", lease_id, m.account_id), "Lease")
        if lease["status"] not in ("active", "notice_given"):
            raise HTTPException(409, f"A {lease['status'].replace('_', ' ')} lease cannot be terminated")
        await conn.execute(
            "UPDATE leases SET status = 'terminated', termination_reason = $2 WHERE id = $1", lease_id, body.reason)
    return await _fetch_lease(lease_id, account_id=m.account_id)


@router.post("/accounts/{account_id}/leases/{lease_id}/cancel")
async def cancel_allocation(lease_id: UUID, m: Staff, ip: IpDep):
    """Withdraw an unsigned allocation; the reserved unit returns to vacant."""
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        updated = await conn.fetchval(
            """UPDATE leases SET status = 'draft' WHERE id = $1 AND account_id = $2 AND status = 'pending_signature'
               RETURNING id""", lease_id, m.account_id)
        if updated is None:
            raise HTTPException(409, "Only allocations awaiting signature can be cancelled")
    return await _fetch_lease(lease_id, account_id=m.account_id)


# ------------------------------------------------------------------ tenant
@router.get("/me/leases")
async def my_leases(user: UserDep):
    rows = await db.fetch(
        f"SELECT {LEASE_COLUMNS} FROM {LEASE_FROM} WHERE t.user_id = $1 AND l.status <> 'draft' ORDER BY l.start_date DESC",
        user.id)
    return as_dicts(rows)


@router.get("/me/leases/{lease_id}")
async def my_lease(lease_id: UUID, user: UserDep):
    return await _fetch_lease(lease_id, tenant_user=user.id, include_terms=True)


@router.post("/me/leases/{lease_id}/sign")
async def sign_lease(lease_id: UUID, body: SignIn, user: UserDep, request: Request, ip: IpDep):
    async with db.tx(user_id=user.id, client_ip=ip) as conn:
        lease = await conn.fetchrow(
            """SELECT l.status, l.terms_sha256, l.account_id FROM leases l JOIN tenants t ON t.id = l.tenant_id
               WHERE l.id = $1 AND t.user_id = $2 FOR UPDATE OF l""", lease_id, user.id)
        if lease is None:
            raise HTTPException(404, "Lease not found")
        if lease["status"] != "pending_signature":
            raise HTTPException(409, "This lease is not awaiting your signature")
        if lease["terms_sha256"] != body.terms_sha256:
            raise HTTPException(409, "The lease terms changed since you opened them. Reload and review again.")
        signature_ok = await conn.fetchval(
            """SELECT EXISTS (SELECT 1 FROM media_files WHERE id = $1 AND uploaded_by = $2
                              AND purpose = 'signature' AND account_id = $3 AND deleted_at IS NULL)""",
            body.signature_media_id, user.id, lease["account_id"])
        if not signature_ok:
            raise HTTPException(422, "Upload your signature (PNG, purpose=signature) first")
        # The BEFORE trigger sees signed_at and activates the lease -> unit occupied -> invoices generated.
        await conn.execute(
            """UPDATE leases SET signed_at = now(), signed_ip = $2::inet, signed_user_agent = $3,
                                 signature_media_id = $4
               WHERE id = $1""",
            lease_id, ip, (request.headers.get("user-agent") or "")[:500], body.signature_media_id)
    return await _fetch_lease(lease_id, tenant_user=user.id)
