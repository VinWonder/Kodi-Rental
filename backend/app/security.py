"""Password hashing (argon2id), JWT access tokens, opaque refresh/invite tokens,
symmetric encryption for stored Daraja secrets, and TURN credentials."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.fernet import Fernet

from .config import Settings

_hasher = PasswordHasher()
# Verified against when the phone number is unknown, so response time does not
# reveal whether an account exists.
_DUMMY_HASH = _hasher.hash("kodi-timing-equaliser")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def create_access_token(user_id: UUID, settings: Settings) -> tuple[str, int]:
    ttl = settings.access_token_minutes * 60
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "typ": "access",
        "iat": now,
        "exp": now + timedelta(seconds=ttl),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm), ttl


def decode_access_token(token: str, settings: Settings) -> dict[str, Any]:
    payload = jwt.decode(
        token,
        settings.jwt_secret,
        algorithms=[settings.jwt_algorithm],
        options={"require": ["exp", "sub", "typ"]},
    )
    if payload.get("typ") != "access":
        raise jwt.InvalidTokenError("Not an access token")
    return payload


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def new_opaque_token() -> tuple[str, str]:
    """Returns (raw_token_for_client, sha256_hash_for_database)."""
    raw = secrets.token_urlsafe(48)
    return raw, sha256_hex(raw)


class SecretBox:
    """Fernet (AES-128-CBC + HMAC-SHA256) wrapper for Daraja credentials."""

    def __init__(self, key: str) -> None:
        self._fernet = Fernet(key.encode())

    def encrypt(self, plaintext: str) -> bytes:
        return self._fernet.encrypt(plaintext.encode())

    def decrypt(self, ciphertext: bytes) -> str:
        return self._fernet.decrypt(bytes(ciphertext)).decode()


def ice_servers(settings: Settings, user_id: UUID) -> list[dict[str, Any]]:
    """WebRTC ICE servers. TURN credentials follow the coturn REST-API scheme
    (use-auth-secret): username = "<expiry>:<user>", credential = HMAC-SHA1."""
    servers: list[dict[str, Any]] = []
    if settings.stun_urls:
        servers.append({"urls": settings.stun_urls})
    if settings.turn_urls and settings.turn_secret:
        expiry = int(time.time()) + settings.turn_credential_ttl_seconds
        username = f"{expiry}:{user_id}"
        digest = hmac.new(settings.turn_secret.encode(), username.encode(), hashlib.sha1).digest()
        servers.append({
            "urls": settings.turn_urls,
            "username": username,
            "credential": base64.b64encode(digest).decode(),
        })
    return servers
