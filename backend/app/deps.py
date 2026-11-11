"""FastAPI dependencies: current user, account role checks, request context."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings, get_settings
from .db import db
from .security import decode_access_token
from .utils import client_ip

_bearer = HTTPBearer(auto_error=False)
SettingsDep = Annotated[Settings, Depends(get_settings)]


@dataclass(frozen=True, slots=True)
class CurrentUser:
    id: UUID
    full_name: str
    phone: str
    is_platform_admin: bool


async def load_user_from_token(token: str, settings: Settings) -> CurrentUser | None:
    try:
        payload = decode_access_token(token, settings)
        user_id = UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
    row = await db.fetchrow(
        "SELECT id, full_name, phone, is_platform_admin FROM users WHERE id = $1 AND is_active",
        user_id,
    )
    return CurrentUser(**dict(row)) if row else None


async def get_current_user(
    settings: SettingsDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> CurrentUser:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated",
                            headers={"WWW-Authenticate": "Bearer"})
    user = await load_user_from_token(creds.credentials, settings)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token",
                            headers={"WWW-Authenticate": "Bearer"})
    return user


UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@dataclass(frozen=True, slots=True)
class Member:
    account_id: UUID
    user: CurrentUser
    role: str


def require_role(*roles: str):
    """Dependency for routes under /accounts/{account_id}/...; 404 for
    non-members so account ids cannot be probed."""

    async def dependency(account_id: UUID, user: UserDep) -> Member:
        role = await db.fetchval(
            "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
            account_id, user.id,
        )
        if role is None:
            if user.is_platform_admin:
                return Member(account_id, user, "owner")
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
        if roles and role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires role: {', '.join(roles)}")
        return Member(account_id, user, role)

    return dependency


AnyMember = Annotated[Member, Depends(require_role())]
Staff = Annotated[Member, Depends(require_role("owner", "manager"))]
Finance = Annotated[Member, Depends(require_role("owner", "manager", "accountant"))]
Owner = Annotated[Member, Depends(require_role("owner"))]


def request_ip(request: Request, settings: SettingsDep) -> str | None:
    return client_ip(request, settings.trust_proxy_headers)


IpDep = Annotated[str | None, Depends(request_ip)]
