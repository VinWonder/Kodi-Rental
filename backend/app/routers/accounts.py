"""Landlord accounts, team members, M-Pesa settings and the dashboard summary."""
from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from ..db import as_dicts, build_update, db, or_404
from ..deps import AnyMember, IpDep, Owner, SettingsDep, Staff, UserDep
from ..services.daraja import DarajaError, callback_urls, load_credentials
from ..state import BoxDep, DarajaDep
from ..utils import KePhone

router = APIRouter(prefix="/accounts", tags=["accounts"])

ACCOUNT_COLUMNS = """id, business_name, kra_pin, contact_phone, contact_email, county_id,
                     default_payment_due_days, currency, is_active, created_at, updated_at"""
KraPin = Field(default=None, pattern=r"^[AP][0-9]{9}[A-Z]$")


class AccountIn(BaseModel):
    business_name: str = Field(min_length=2, max_length=150)
    contact_phone: KePhone | None = None   # defaults to the creator's phone
    contact_email: str | None = Field(default=None, max_length=254)
    county_id: int | None = Field(default=None, ge=1, le=47)
    kra_pin: str | None = KraPin
    default_payment_due_days: int = Field(default=5, ge=0, le=28)


class AccountPatch(BaseModel):
    business_name: str | None = Field(default=None, min_length=2, max_length=150)
    contact_phone: KePhone | None = None
    contact_email: str | None = Field(default=None, max_length=254)
    county_id: int | None = Field(default=None, ge=1, le=47)
    kra_pin: str | None = KraPin
    default_payment_due_days: int | None = Field(default=None, ge=0, le=28)


class MemberIn(BaseModel):
    phone: KePhone
    role: Literal["owner", "manager", "accountant", "viewer"] = "manager"


class MpesaSettingsIn(BaseModel):
    environment: Literal["sandbox", "production"] = "sandbox"
    shortcode_type: Literal["paybill", "till"]
    business_shortcode: str = Field(pattern=r"^[0-9]{5,7}$")
    stk_party_b: str | None = Field(default=None, pattern=r"^[0-9]{5,7}$",
                                    description="Till number (Buy Goods only)")
    consumer_key: str = Field(min_length=10, max_length=200)
    consumer_secret: str = Field(min_length=10, max_length=200)
    passkey: str = Field(min_length=10, max_length=200)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_account(body: AccountIn, user: UserDep, ip: IpDep):
    async with db.tx(user_id=user.id, client_ip=ip) as conn:
        account = await conn.fetchrow(
            f"""INSERT INTO accounts (business_name, contact_phone, contact_email, county_id, kra_pin,
                                      default_payment_due_days)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING {ACCOUNT_COLUMNS}""",
            body.business_name.strip(), body.contact_phone or user.phone, body.contact_email,
            body.county_id, body.kra_pin, body.default_payment_due_days,
        )
        await conn.execute("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')",
                           account["id"], user.id)
    return {**dict(account), "role": "owner"}


@router.get("")
async def list_accounts(user: UserDep):
    rows = await db.fetch(
        f"""SELECT {', '.join('a.' + c.strip() for c in ACCOUNT_COLUMNS.split(','))}, m.role
            FROM accounts a JOIN account_members m ON m.account_id = a.id
            WHERE m.user_id = $1 ORDER BY a.business_name""", user.id)
    return as_dicts(rows)


@router.get("/{account_id}")
async def get_account(m: AnyMember):
    row = await db.fetchrow(f"SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE id = $1", m.account_id)
    return {**or_404(row, "Account"), "role": m.role}


@router.patch("/{account_id}")
async def update_account(body: AccountPatch, m: Owner, ip: IpDep):
    sql, args = build_update("accounts", body.model_dump(exclude_unset=True), {"id": m.account_id}, ACCOUNT_COLUMNS)
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        return dict(await conn.fetchrow(sql, *args))


# ------------------------------------------------------------------ members
@router.get("/{account_id}/members")
async def list_members(m: AnyMember):
    rows = await db.fetch(
        """SELECT u.id AS user_id, u.full_name, u.phone, am.role, am.created_at
           FROM account_members am JOIN users u ON u.id = am.user_id
           WHERE am.account_id = $1 ORDER BY am.created_at""", m.account_id)
    return as_dicts(rows)


@router.post("/{account_id}/members", status_code=status.HTTP_201_CREATED)
async def add_member(body: MemberIn, m: Owner, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        user_id = await conn.fetchval("SELECT id FROM users WHERE phone = $1 AND is_active", body.phone)
        if user_id is None:
            raise HTTPException(404, "No user with that phone. Ask them to register first.")
        await conn.execute(
            """INSERT INTO account_members (account_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
               ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role""",
            m.account_id, user_id, body.role, m.user.id)
    return {"user_id": user_id, "role": body.role}


@router.delete("/{account_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(user_id: UUID, m: Owner, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        owners = await conn.fetch(
            "SELECT user_id FROM account_members WHERE account_id = $1 AND role = 'owner' FOR UPDATE",
            m.account_id)
        if [r["user_id"] for r in owners] == [user_id]:
            raise HTTPException(409, "An account must keep at least one owner")
        await conn.execute("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2",
                           m.account_id, user_id)


# ------------------------------------------------------------------ M-Pesa settings
@router.get("/{account_id}/mpesa")
async def get_mpesa_settings(m: Staff, settings: SettingsDep):
    row = await db.fetchrow(
        """SELECT environment, shortcode_type, business_shortcode, stk_party_b, callback_token,
                  c2b_urls_registered_at, is_active, updated_at
           FROM account_mpesa_settings WHERE account_id = $1""", m.account_id)
    if row is None:
        return {"configured": False}
    data = dict(row)
    token = data.pop("callback_token")
    return {"configured": True, **data, **callback_urls(settings, token)}


@router.put("/{account_id}/mpesa")
async def put_mpesa_settings(body: MpesaSettingsIn, m: Owner, box: BoxDep, ip: IpDep, settings: SettingsDep):
    if body.shortcode_type == "till" and not body.stk_party_b:
        raise HTTPException(422, "Buy Goods (till) accounts need stk_party_b set to the till number")
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        token = await conn.fetchval(
            """INSERT INTO account_mpesa_settings (account_id, environment, shortcode_type, business_shortcode,
                                                   stk_party_b, consumer_key_enc, consumer_secret_enc, passkey_enc)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (account_id) DO UPDATE SET
                   environment = EXCLUDED.environment, shortcode_type = EXCLUDED.shortcode_type,
                   business_shortcode = EXCLUDED.business_shortcode, stk_party_b = EXCLUDED.stk_party_b,
                   consumer_key_enc = EXCLUDED.consumer_key_enc,
                   consumer_secret_enc = EXCLUDED.consumer_secret_enc,
                   passkey_enc = EXCLUDED.passkey_enc, is_active = true,
                   c2b_urls_registered_at = NULL
               RETURNING callback_token""",
            m.account_id, body.environment, body.shortcode_type, body.business_shortcode,
            body.stk_party_b, box.encrypt(body.consumer_key), box.encrypt(body.consumer_secret),
            box.encrypt(body.passkey),
        )
    return {"configured": True, "environment": body.environment, "business_shortcode": body.business_shortcode,
            **callback_urls(settings, token)}


@router.post("/{account_id}/mpesa/register-c2b")
async def register_c2b(m: Owner, daraja: DarajaDep, box: BoxDep, settings: SettingsDep):
    """Tell Safaricom where to send Paybill/Till confirmations for this shortcode."""
    async with db.tx(user_id=m.user.id) as conn:
        creds = await load_credentials(conn, m.account_id, box)
    urls = callback_urls(settings, creds.callback_token)
    try:
        response = await daraja.register_c2b_urls(creds, confirmation_url=urls["c2b_confirmation_url"],
                                                  validation_url=urls["c2b_validation_url"])
    except DarajaError as exc:
        raise HTTPException(502, f"Safaricom rejected URL registration: {exc}") from exc
    await db.execute("UPDATE account_mpesa_settings SET c2b_urls_registered_at = now() WHERE account_id = $1",
                     m.account_id)
    return {"registered": True, "response": response, **urls}


# ------------------------------------------------------------------ dashboard
@router.get("/{account_id}/dashboard")
async def dashboard(m: AnyMember):
    occupancy = await db.fetchrow(
        """SELECT coalesce(sum(total_units), 0) AS total_units, coalesce(sum(occupied), 0) AS occupied,
                  coalesce(sum(vacant), 0) AS vacant, coalesce(sum(reserved), 0) AS reserved,
                  coalesce(sum(under_maintenance), 0) AS under_maintenance, coalesce(sum(cleaning), 0) AS cleaning,
                  coalesce(sum(actual_rent_roll), 0) AS actual_rent_roll,
                  coalesce(sum(potential_rent_roll), 0) AS potential_rent_roll
           FROM v_property_occupancy WHERE account_id = $1""", m.account_id)
    arrears = await db.fetchrow(
        """SELECT count(*) AS defaulters, coalesce(sum(amount_overdue), 0) AS amount_overdue
           FROM v_defaulters WHERE account_id = $1""", m.account_id)
    month = await db.fetchrow(
        """SELECT coalesce(sum(invoiced), 0) AS invoiced, coalesce(sum(collected), 0) AS collected,
                  coalesce(sum(maintenance_cost), 0) AS maintenance_cost
           FROM v_monthly_revenue
           WHERE account_id = $1 AND month = date_trunc('month', nairobi_today()::timestamp)::date""",
        m.account_id)
    issues = await db.fetch(
        """SELECT priority, count(*) AS open FROM issues
           WHERE account_id = $1 AND status NOT IN ('resolved', 'closed', 'rejected')
           GROUP BY priority""", m.account_id)
    unmatched = await db.fetchval(
        "SELECT count(*) FROM payments WHERE account_id = $1 AND tenant_id IS NULL AND status = 'completed'",
        m.account_id)
    recent = await db.fetch(
        """SELECT p.id, p.amount, p.method, p.mpesa_receipt_number, p.paid_at, t.full_name AS tenant_name
           FROM payments p LEFT JOIN tenants t ON t.id = p.tenant_id
           WHERE p.account_id = $1 AND p.status = 'completed'
           ORDER BY p.paid_at DESC LIMIT 5""", m.account_id)
    total = occupancy["total_units"] or 0
    return {
        "generated_at": datetime.now().astimezone().isoformat(),
        "occupancy": {**dict(occupancy),
                      "occupancy_rate_pct": round(100 * occupancy["occupied"] / total, 1) if total else 0},
        "arrears": dict(arrears),
        "this_month": dict(month),
        "open_issues": {r["priority"]: r["open"] for r in issues},
        "unmatched_payments": unmatched,
        "recent_payments": as_dicts(recent),
    }
