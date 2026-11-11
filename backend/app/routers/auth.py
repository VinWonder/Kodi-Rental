"""Registration, login, refresh-token rotation and tenant invite acceptance."""
from __future__ import annotations

from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from ..config import Settings
from ..db import db
from ..deps import IpDep, SettingsDep, UserDep
from ..security import (create_access_token, hash_password, new_opaque_token, password_needs_rehash,
                        sha256_hex, verify_password)
from ..utils import KePhone

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterIn(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    phone: KePhone
    email: str | None = Field(default=None, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)
    password: str = Field(min_length=8, max_length=128)


class LoginIn(BaseModel):
    phone: KePhone
    password: str = Field(max_length=128)


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=200)


class AcceptInviteIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(min_length=8, max_length=128)


async def _issue_tokens(conn: asyncpg.Connection, user_id: UUID, request: Request,
                        ip: str | None, settings: Settings) -> dict[str, Any]:
    raw_refresh, refresh_hash = new_opaque_token()
    await conn.execute(
        """INSERT INTO user_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
           VALUES ($1, $2, $3, $4::inet, now() + make_interval(days => $5))""",
        user_id, refresh_hash, (request.headers.get("user-agent") or "")[:500], ip,
        settings.refresh_token_days,
    )
    access, ttl = create_access_token(user_id, settings)
    user = await conn.fetchrow("SELECT id, full_name, phone, email FROM users WHERE id = $1", user_id)
    return {"access_token": access, "token_type": "bearer", "expires_in": ttl,
            "refresh_token": raw_refresh, "user": dict(user)}


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(body: RegisterIn, request: Request, ip: IpDep, settings: SettingsDep):
    async with db.tx(client_ip=ip) as conn:
        user_id = await conn.fetchval(
            """INSERT INTO users (full_name, phone, email, password_hash)
               VALUES ($1, $2, $3, $4) RETURNING id""",
            body.full_name.strip(), body.phone, body.email, hash_password(body.password),
        )
        return await _issue_tokens(conn, user_id, request, ip, settings)


@router.post("/login")
async def login(body: LoginIn, request: Request, ip: IpDep, settings: SettingsDep):
    row = await db.fetchrow("SELECT id, password_hash, is_active FROM users WHERE phone = $1", body.phone)
    if not verify_password(row["password_hash"] if row else None, body.password) or not row["is_active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid phone number or password")
    async with db.tx(user_id=row["id"], client_ip=ip) as conn:
        if password_needs_rehash(row["password_hash"]):
            await conn.execute("UPDATE users SET password_hash = $2 WHERE id = $1",
                               row["id"], hash_password(body.password))
        await conn.execute("UPDATE users SET last_login_at = now() WHERE id = $1", row["id"])
        return await _issue_tokens(conn, row["id"], request, ip, settings)


@router.post("/refresh")
async def refresh(body: RefreshIn, request: Request, ip: IpDep, settings: SettingsDep):
    token_hash = sha256_hex(body.refresh_token)
    async with db.tx(client_ip=ip) as conn:
        session = await conn.fetchrow(
            """SELECT s.id, s.user_id, s.revoked_at, s.expires_at < now() AS expired, u.is_active
               FROM user_sessions s JOIN users u ON u.id = s.user_id
               WHERE s.refresh_token_hash = $1 FOR UPDATE OF s""",
            token_hash,
        )
        if session is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")
        if session["revoked_at"] is None:
            if session["expired"] or not session["is_active"]:
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired. Please sign in again.")
            await conn.execute("UPDATE user_sessions SET revoked_at = now() WHERE id = $1", session["id"])
            return await _issue_tokens(conn, session["user_id"], request, ip, settings)

    # A rotated-out token was replayed: assume it was stolen and sign out every
    # device. Done outside the transaction above so the 401 cannot roll it back.
    await db.execute("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
                     session["user_id"])
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session revoked. Please sign in again.")


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(body: RefreshIn):
    await db.execute("UPDATE user_sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL",
                     sha256_hex(body.refresh_token))


@router.post("/accept-invite")
async def accept_invite(body: AcceptInviteIn, request: Request, ip: IpDep, settings: SettingsDep):
    """Tenant opens the landlord's invite link. Creates their login (or, if the
    phone is already registered, verifies the password) and links the tenant
    profile so the lease, invoices and chat become visible."""
    async with db.tx(client_ip=ip) as conn:
        invite = await conn.fetchrow(
            """SELECT i.id, i.tenant_id, t.phone, t.full_name, t.user_id AS linked_user
               FROM tenant_invites i JOIN tenants t ON t.id = i.tenant_id
               WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
                 AND i.expires_at > now()
               FOR UPDATE OF i""",
            sha256_hex(body.token),
        )
        if invite is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "This invite link is invalid or has expired")

        existing = await conn.fetchrow("SELECT id, password_hash FROM users WHERE phone = $1", invite["phone"])
        if existing:
            if not verify_password(existing["password_hash"], body.password):
                raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                                    "This phone already has an account. Enter that account's password.")
            user_id = existing["id"]
        else:
            user_id = await conn.fetchval(
                "INSERT INTO users (full_name, phone, password_hash) VALUES ($1, $2, $3) RETURNING id",
                invite["full_name"], invite["phone"], hash_password(body.password),
            )
        if invite["linked_user"] not in (None, user_id):
            raise HTTPException(status.HTTP_409_CONFLICT, "This tenant profile is linked to another login")

        await conn.execute("SELECT set_config('app.current_user_id', $1, true)", str(user_id))
        await conn.execute("UPDATE tenants SET user_id = $2 WHERE id = $1", invite["tenant_id"], user_id)
        await conn.execute("UPDATE tenant_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1",
                           invite["id"], user_id)
        return await _issue_tokens(conn, user_id, request, ip, settings)


@router.get("/me")
async def me(user: UserDep):
    profile = await db.fetchrow(
        "SELECT id, full_name, phone, email, avatar_media_id, is_platform_admin, created_at FROM users WHERE id = $1",
        user.id)
    memberships = await db.fetch(
        """SELECT a.id AS account_id, a.business_name, m.role
           FROM account_members m JOIN accounts a ON a.id = m.account_id
           WHERE m.user_id = $1 AND a.is_active ORDER BY a.business_name""", user.id)
    tenancies = await db.fetch(
        """SELECT t.id AS tenant_id, t.account_id, a.business_name,
                  l.id AS lease_id, l.status AS lease_status, u.unit_number, p.name AS property_name
           FROM tenants t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN LATERAL (SELECT * FROM leases l WHERE l.tenant_id = t.id
                               ORDER BY (l.status IN ('pending_signature', 'active', 'notice_given')) DESC,
                                        l.start_date DESC LIMIT 1) l ON true
           LEFT JOIN units u ON u.id = l.unit_id
           LEFT JOIN properties p ON p.id = u.property_id
           WHERE t.user_id = $1""", user.id)
    return {"user": dict(profile), "memberships": [dict(r) for r in memberships],
            "tenancies": [dict(r) for r in tenancies]}
