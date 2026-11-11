"""Small shared helpers: Kenyan phone normalisation, client IP, EAT timezone."""
from __future__ import annotations

import ipaddress
import re
from datetime import timedelta, timezone
from decimal import Decimal
from typing import Annotated

from pydantic import AfterValidator, Field
from starlette.requests import HTTPConnection

# Kenya has no daylight saving, so a fixed offset is exact (and avoids needing
# the tzdata package on Windows).
EAT = timezone(timedelta(hours=3), "EAT")

_MSISDN = re.compile(r"^254(7|1)\d{8}$")


def normalize_msisdn(raw: str) -> str:
    """Accepts 0712345678, +254 712 345 678, 254712345678 or 712345678 and
    returns the Daraja format 254712345678."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 10 and digits.startswith("0"):
        digits = "254" + digits[1:]
    elif len(digits) == 9 and digits[0] in "17":
        digits = "254" + digits
    if not _MSISDN.match(digits):
        raise ValueError("Enter a valid Kenyan mobile number, e.g. 0712 345 678")
    return digits


KePhone = Annotated[str, AfterValidator(normalize_msisdn)]
Money = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2)]
PositiveMoney = Annotated[Decimal, Field(gt=0, max_digits=14, decimal_places=2)]


def client_ip(conn: HTTPConnection, trust_proxy: bool) -> str | None:
    candidate: str | None = None
    if trust_proxy:
        forwarded = conn.headers.get("x-forwarded-for")
        if forwarded:
            candidate = forwarded.split(",")[0].strip()
    if not candidate and conn.client:
        candidate = conn.client.host
    try:
        return str(ipaddress.ip_address(candidate)) if candidate else None
    except ValueError:
        return None
