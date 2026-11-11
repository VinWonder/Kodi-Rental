"""Tenant profiles, next of kin, identity verification and app invites."""
from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field, model_validator

from ..db import as_dicts, build_update, db, or_404
from ..deps import AnyMember, IpDep, SettingsDep, Staff
from ..security import new_opaque_token
from ..utils import KePhone

router = APIRouter(prefix="/accounts/{account_id}/tenants", tags=["tenants"])

IdType = Literal["national_id", "passport", "alien_id", "military_id"]
TENANT_COLUMNS = """t.id, t.account_id, t.user_id, t.first_name, t.middle_name, t.last_name, t.full_name,
                    t.id_document_type, t.id_document_number, t.date_of_birth, t.phone, t.alt_phone, t.email,
                    t.kra_pin, t.occupation, t.employer, t.id_front_media_id, t.id_back_media_id,
                    t.passport_photo_media_id, t.identity_verified_at, t.is_blacklisted, t.blacklist_reason,
                    t.notes, t.created_at, t.updated_at"""


class NextOfKinIn(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    relationship: str = Field(min_length=2, max_length=40)
    phone: KePhone
    alt_phone: KePhone | None = None
    id_number: str | None = Field(default=None, max_length=20)
    is_primary: bool = False


class _TenantFields(BaseModel):
    @model_validator(mode="after")
    def check_id(self):
        doc_type = getattr(self, "id_document_type", None)
        number = getattr(self, "id_document_number", None)
        if doc_type in (None, "national_id") and number is not None and not number.isdigit():
            raise ValueError("Kenyan national ID numbers contain digits only")
        return self


class TenantIn(_TenantFields):
    first_name: str = Field(min_length=1, max_length=60)
    middle_name: str | None = Field(default=None, max_length=60)
    last_name: str = Field(min_length=1, max_length=60)
    id_document_type: IdType = "national_id"
    id_document_number: str = Field(min_length=6, max_length=20)
    date_of_birth: date | None = None
    phone: KePhone = Field(description="M-Pesa registered number (STK Push target)")
    alt_phone: KePhone | None = None
    email: str | None = Field(default=None, max_length=254)
    kra_pin: str | None = Field(default=None, pattern=r"^[AP][0-9]{9}[A-Z]$")
    occupation: str | None = Field(default=None, max_length=100)
    employer: str | None = Field(default=None, max_length=150)
    id_front_media_id: UUID | None = None
    id_back_media_id: UUID | None = None
    passport_photo_media_id: UUID | None = None
    notes: str | None = Field(default=None, max_length=2000)
    next_of_kin: list[NextOfKinIn] = Field(default_factory=list, max_length=5)


class TenantPatch(_TenantFields):
    first_name: str | None = Field(default=None, min_length=1, max_length=60)
    middle_name: str | None = Field(default=None, max_length=60)
    last_name: str | None = Field(default=None, min_length=1, max_length=60)
    id_document_type: IdType | None = None
    id_document_number: str | None = Field(default=None, min_length=6, max_length=20)
    date_of_birth: date | None = None
    phone: KePhone | None = None
    alt_phone: KePhone | None = None
    email: str | None = Field(default=None, max_length=254)
    kra_pin: str | None = Field(default=None, pattern=r"^[AP][0-9]{9}[A-Z]$")
    occupation: str | None = Field(default=None, max_length=100)
    employer: str | None = Field(default=None, max_length=150)
    id_front_media_id: UUID | None = None
    id_back_media_id: UUID | None = None
    passport_photo_media_id: UUID | None = None
    notes: str | None = Field(default=None, max_length=2000)
    is_blacklisted: bool | None = None
    blacklist_reason: str | None = Field(default=None, max_length=500)


async def _fetch_tenant(account_id: UUID, tenant_id: UUID) -> dict:
    row = await db.fetchrow(f"SELECT {TENANT_COLUMNS} FROM tenants t WHERE t.id = $1 AND t.account_id = $2",
                            tenant_id, account_id)
    tenant = or_404(row, "Tenant")
    tenant["next_of_kin"] = as_dicts(await db.fetch(
        """SELECT id, full_name, relationship, phone, alt_phone, id_number, is_primary
           FROM next_of_kin WHERE tenant_id = $1 ORDER BY is_primary DESC, created_at""", tenant_id))
    tenant["leases"] = as_dicts(await db.fetch(
        """SELECT l.id, l.lease_number, l.status, l.start_date, l.end_date, l.monthly_rent,
                  u.unit_number, p.name AS property_name
           FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
           WHERE l.tenant_id = $1 ORDER BY l.start_date DESC""", tenant_id))
    tenant["balance"] = await db.fetchval(
        """SELECT coalesce(sum(balance), 0) FROM invoices
           WHERE tenant_id = $1 AND status IN ('issued', 'partially_paid', 'overdue')""", tenant_id)
    tenant["credit"] = await db.fetchval(
        """SELECT coalesce(sum(unallocated_amount), 0) FROM payments
           WHERE tenant_id = $1 AND status = 'completed'""", tenant_id)
    tenant["app_linked"] = tenant["user_id"] is not None
    return tenant


async def _check_media(conn, account_id: UUID, ids: list[UUID | None]) -> None:
    wanted = {i for i in ids if i}
    if not wanted:
        return
    found = await conn.fetchval(
        """SELECT count(*) FROM media_files WHERE id = ANY($1::uuid[]) AND account_id = $2
           AND purpose = 'tenant_id_document' AND deleted_at IS NULL""", list(wanted), account_id)
    if found != len(wanted):
        raise HTTPException(422, "ID images must be uploaded with purpose=tenant_id_document")


@router.get("")
async def list_tenants(
    m: AnyMember,
    q: str | None = Query(default=None, max_length=100, description="Name (typo tolerant), phone or ID number"),
    active_only: bool = False,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    rows = await db.fetch(
        f"""SELECT {TENANT_COLUMNS}, cur.lease_id, cur.lease_status, cur.unit_number, cur.property_name,
                   coalesce(bal.balance, 0) AS balance
            FROM tenants t
            LEFT JOIN LATERAL (
                SELECT l.id AS lease_id, l.status AS lease_status, u.unit_number, p.name AS property_name
                FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
                WHERE l.tenant_id = t.id AND l.status IN ('pending_signature', 'active', 'notice_given')
                ORDER BY l.start_date DESC LIMIT 1) cur ON true
            LEFT JOIN LATERAL (
                SELECT sum(i.balance) AS balance FROM invoices i
                WHERE i.tenant_id = t.id AND i.status IN ('issued', 'partially_paid', 'overdue')) bal ON true
            WHERE t.account_id = $1
              AND (NOT $2 OR cur.lease_id IS NOT NULL)
              AND ($3::text IS NULL OR t.full_name % $3 OR t.full_name ILIKE '%' || $3 || '%'
                   OR t.phone LIKE '%' || regexp_replace($3, '\\D', '', 'g') || '%' AND length(regexp_replace($3, '\\D', '', 'g')) >= 4
                   OR t.id_document_number = $3)
            ORDER BY t.full_name LIMIT $4 OFFSET $5""",
        m.account_id, active_only, q, limit, offset)
    return as_dicts(rows)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_tenant(body: TenantIn, m: Staff, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        await _check_media(conn, m.account_id, [body.id_front_media_id, body.id_back_media_id,
                                                 body.passport_photo_media_id])
        tenant_id = await conn.fetchval(
            """INSERT INTO tenants (account_id, first_name, middle_name, last_name, id_document_type,
                                    id_document_number, date_of_birth, phone, alt_phone, email, kra_pin,
                                    occupation, employer, id_front_media_id, id_back_media_id,
                                    passport_photo_media_id, notes)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
               RETURNING id""",
            m.account_id, body.first_name.strip(), body.middle_name, body.last_name.strip(),
            body.id_document_type, body.id_document_number.strip().upper(), body.date_of_birth, body.phone,
            body.alt_phone, body.email, body.kra_pin, body.occupation, body.employer, body.id_front_media_id,
            body.id_back_media_id, body.passport_photo_media_id, body.notes)
        if sum(k.is_primary for k in body.next_of_kin) > 1:
            raise HTTPException(422, "Only one next of kin can be primary")
        await conn.executemany(
            """INSERT INTO next_of_kin (tenant_id, full_name, relationship, phone, alt_phone, id_number, is_primary)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            [(tenant_id, k.full_name, k.relationship, k.phone, k.alt_phone, k.id_number,
              k.is_primary or (i == 0 and not any(x.is_primary for x in body.next_of_kin)))
             for i, k in enumerate(body.next_of_kin)])
    return await _fetch_tenant(m.account_id, tenant_id)


@router.get("/{tenant_id}")
async def get_tenant(tenant_id: UUID, m: AnyMember):
    return await _fetch_tenant(m.account_id, tenant_id)


@router.patch("/{tenant_id}")
async def update_tenant(tenant_id: UUID, body: TenantPatch, m: Staff, ip: IpDep):
    changes = body.model_dump(exclude_unset=True)
    if changes.get("id_document_number"):
        changes["id_document_number"] = changes["id_document_number"].strip().upper()
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        await _check_media(conn, m.account_id, [changes.get("id_front_media_id"), changes.get("id_back_media_id"),
                                                 changes.get("passport_photo_media_id")])
        sql, args = build_update("tenants", changes, {"id": tenant_id, "account_id": m.account_id}, "id")
        or_404(await conn.fetchrow(sql, *args), "Tenant")
    return await _fetch_tenant(m.account_id, tenant_id)


@router.post("/{tenant_id}/next-of-kin", status_code=status.HTTP_201_CREATED)
async def add_next_of_kin(tenant_id: UUID, body: NextOfKinIn, m: Staff):
    async with db.tx(user_id=m.user.id) as conn:
        or_404(await conn.fetchrow("SELECT id FROM tenants WHERE id = $1 AND account_id = $2",
                                   tenant_id, m.account_id), "Tenant")
        if body.is_primary:
            await conn.execute("UPDATE next_of_kin SET is_primary = false WHERE tenant_id = $1", tenant_id)
        row = await conn.fetchrow(
            """INSERT INTO next_of_kin (tenant_id, full_name, relationship, phone, alt_phone, id_number, is_primary)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id, full_name, relationship, phone, alt_phone, id_number, is_primary""",
            tenant_id, body.full_name, body.relationship, body.phone, body.alt_phone, body.id_number,
            body.is_primary)
    return dict(row)


@router.delete("/{tenant_id}/next-of-kin/{kin_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_next_of_kin(tenant_id: UUID, kin_id: UUID, m: Staff):
    result = await db.execute(
        """DELETE FROM next_of_kin k USING tenants t
           WHERE k.id = $1 AND k.tenant_id = t.id AND t.id = $2 AND t.account_id = $3""",
        kin_id, tenant_id, m.account_id)
    if result.endswith(" 0"):
        raise HTTPException(404, "Next of kin not found")


@router.post("/{tenant_id}/verify-identity")
async def verify_identity(tenant_id: UUID, m: Staff, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        or_404(await conn.fetchrow(
            """UPDATE tenants SET identity_verified_at = now(), identity_verified_by = $3
               WHERE id = $1 AND account_id = $2 RETURNING id""", tenant_id, m.account_id, m.user.id), "Tenant")
    return await _fetch_tenant(m.account_id, tenant_id)


@router.post("/{tenant_id}/invite", status_code=status.HTTP_201_CREATED)
async def invite_tenant(tenant_id: UUID, m: Staff, settings: SettingsDep):
    """Single-use link the landlord sends by SMS/WhatsApp. Opening it lets the
    tenant set a password and see their lease, invoices and chat."""
    raw, token_hash = new_opaque_token()
    async with db.tx(user_id=m.user.id) as conn:
        tenant = or_404(await conn.fetchrow(
            "SELECT first_name, user_id FROM tenants WHERE id = $1 AND account_id = $2",
            tenant_id, m.account_id), "Tenant")
        if tenant["user_id"] is not None:
            raise HTTPException(409, "This tenant already uses the app")
        await conn.execute(
            "UPDATE tenant_invites SET revoked_at = now() WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL",
            tenant_id)
        expires_at = await conn.fetchval(
            """INSERT INTO tenant_invites (tenant_id, token_hash, created_by, expires_at)
               VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING expires_at""",
            tenant_id, token_hash, m.user.id, settings.invite_token_days)
        business = await conn.fetchval("SELECT business_name FROM accounts WHERE id = $1", m.account_id)
    link = f"{settings.frontend_base_url.rstrip('/')}/invite.html#token={raw}"
    return {
        "invite_url": link,
        "expires_at": expires_at,
        "sms_text": f"Hi {tenant['first_name']}, {business} invites you to manage your tenancy, pay rent "
                    f"via M-Pesa and report issues online: {link}",
    }


@router.get("/{tenant_id}/statement")
async def tenant_statement(tenant_id: UUID, m: AnyMember, date_from: date | None = None, date_to: date | None = None):
    rows = await db.fetch(
        """SELECT entry_date, entry_type, ref_id, reference, description, debit, credit, running_balance
           FROM v_tenant_ledger
           WHERE account_id = $1 AND tenant_id = $2
             AND ($3::date IS NULL OR entry_date >= $3) AND ($4::date IS NULL OR entry_date <= $4)
           ORDER BY entry_date, entry_ts, entry_type""", m.account_id, tenant_id, date_from, date_to)
    return as_dicts(rows)
