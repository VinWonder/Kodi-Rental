"""Translate database errors raised by constraints and triggers into clean HTTP
responses. Trigger messages (RAISE EXCEPTION ... USING ERRCODE) are written
for humans, so they are passed through."""
from __future__ import annotations

import logging

import asyncpg
from asyncpg import exceptions as pgx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("kodi.errors")

_CONSTRAINT_MESSAGES = {
    "ex_leases_no_double_allocation": "This unit already has a live allocation for that period.",
    "ux_stk_inflight_per_invoice": "A payment prompt is already pending for this invoice. "
                                   "Ask the tenant to check their phone, or try again in 3 minutes.",
    "users_phone_key": "This phone number is already registered.",
    "users_email_key": "This email is already registered.",
    "units_property_id_unit_number_key": "A unit with this number already exists in the property.",
    "units_account_id_payment_code_key": "Another unit already uses this M-Pesa account number.",
    "tenants_account_id_id_document_type_id_document_number_key": "A tenant with this ID number already exists.",
    "properties_account_id_name_key": "You already have a property with this name.",
}


def _response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": message, "code": code})


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(asyncpg.PostgresError)
    async def postgres_error(request: Request, exc: asyncpg.PostgresError) -> JSONResponse:
        constraint = getattr(exc, "constraint_name", None)
        friendly = _CONSTRAINT_MESSAGES.get(constraint or "")
        message = friendly or getattr(exc, "message", None) or str(exc)

        if isinstance(exc, (pgx.ExclusionViolationError, pgx.UniqueViolationError)):
            return _response(409, "conflict", message)
        if isinstance(exc, pgx.CheckViolationError):
            return _response(409 if friendly or constraint is None else 422, "rule_violation", message)
        if isinstance(exc, pgx.ForeignKeyViolationError):
            return _response(422, "invalid_reference", friendly or "A referenced record does not exist.")
        if isinstance(exc, pgx.NotNullViolationError):
            return _response(422, "missing_value", message)
        if isinstance(exc, pgx.InsufficientPrivilegeError):
            return _response(403, "forbidden", message)
        if isinstance(exc, pgx.NoDataFoundError):
            return _response(404, "not_found", message)
        if isinstance(exc, (pgx.DataError, pgx.RaiseError)):
            return _response(422, "invalid_data", message)

        log.exception("Unhandled database error on %s %s", request.method, request.url.path)
        return _response(500, "database_error", "Unexpected database error.")
