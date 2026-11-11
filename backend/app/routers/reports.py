"""Downloadable financial statements (PDF / CSV) and receipt PDFs.

The JSON versions of each report live in billing.py; these endpoints turn the
same data into files. Landlord exports are stored and listed (export history);
tenant statements are rendered on demand.
"""
from __future__ import annotations

from datetime import date
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, model_validator

from ..db import as_dicts, db
from ..deps import AnyMember, Finance, UserDep
from ..services import exports
from ..services.exports import ExportFormat, ReportParams, ReportType
from ..state import StorageDep

router = APIRouter(tags=["reports"])


class ExportIn(BaseModel):
    report_type: ReportType
    format: ExportFormat = "pdf"
    date_from: date | None = None
    date_to: date | None = None
    property_id: UUID | None = None
    tenant_id: UUID | None = None

    @model_validator(mode="after")
    def _check(self) -> "ExportIn":
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("date_from must be on or before date_to")
        if self.report_type == "tenant_statement" and self.tenant_id is None:
            raise ValueError("tenant_id is required for a tenant statement")
        return self

    def params(self) -> ReportParams:
        return ReportParams(self.date_from, self.date_to, self.property_id, self.tenant_id)


def _file(path, mime: str, filename: str) -> FileResponse:
    return FileResponse(path, media_type=mime, filename=filename,
                        headers={"Cache-Control": "private, max-age=86400"})


# ------------------------------------------------------------------ landlord exports
@router.post("/accounts/{account_id}/reports/exports", status_code=status.HTTP_201_CREATED)
async def create_export(body: ExportIn, m: Finance, storage: StorageDep) -> dict[str, Any]:
    """Generate a statement now. The response includes `url` for downloading it."""
    return await exports.create_export(storage, account_id=m.account_id, user_id=m.user.id,
                                       report_type=body.report_type, fmt=body.format, params=body.params())


@router.get("/accounts/{account_id}/reports/exports")
async def list_exports(m: Finance, limit: int = Query(default=50, ge=1, le=200)):
    rows = await db.fetch(
        f"""SELECT {exports.EXPORT_COLUMNS} FROM report_exports e LEFT JOIN media_files mf ON mf.id = e.media_id
            WHERE e.account_id = $1 ORDER BY e.requested_at DESC LIMIT $2""", m.account_id, limit)
    return as_dicts(rows)


@router.get("/accounts/{account_id}/reports/exports/{export_id}/download", response_class=FileResponse)
async def download_export(export_id: UUID, m: Finance, storage: StorageDep):
    row = await db.fetchrow(
        """SELECT e.status, mf.storage_key, mf.mime_type, mf.original_filename
           FROM report_exports e LEFT JOIN media_files mf ON mf.id = e.media_id AND mf.deleted_at IS NULL
           WHERE e.id = $1 AND e.account_id = $2""", export_id, m.account_id)
    if row is None:
        raise HTTPException(404, "Export not found")
    if row["status"] != "ready" or row["storage_key"] is None:
        raise HTTPException(409, f"Export is {row['status']}, not ready for download")
    return _file(storage.path_for(row["storage_key"]), row["mime_type"], row["original_filename"])


# ------------------------------------------------------------------ receipts
@router.get("/accounts/{account_id}/receipts/{receipt_id}/pdf", response_class=FileResponse)
async def receipt_pdf(receipt_id: UUID, m: AnyMember, storage: StorageDep):
    if await exports.load_receipt(receipt_id, account_id=m.account_id) is None:
        raise HTTPException(404, "Receipt not found")
    media = await exports.ensure_receipt_pdf(storage, receipt_id)
    return _file(storage.path_for(media["storage_key"]), "application/pdf", media["original_filename"])


@router.get("/me/receipts/{receipt_id}")
async def my_receipt(receipt_id: UUID, user: UserDep):
    receipt = await exports.load_receipt(receipt_id, tenant_user_id=user.id)
    if receipt is None:
        raise HTTPException(404, "Receipt not found")
    return receipt


@router.get("/me/receipts/{receipt_id}/pdf", response_class=FileResponse)
async def my_receipt_pdf(receipt_id: UUID, user: UserDep, storage: StorageDep):
    if await exports.load_receipt(receipt_id, tenant_user_id=user.id) is None:
        raise HTTPException(404, "Receipt not found")
    media = await exports.ensure_receipt_pdf(storage, receipt_id)
    return _file(storage.path_for(media["storage_key"]), "application/pdf", media["original_filename"])


# ------------------------------------------------------------------ tenant statement
@router.get("/me/statement/export")
async def my_statement_export(
    user: UserDep,
    format: ExportFormat = "pdf",
    account_id: UUID | None = Query(default=None, description="Needed only if you rent from several landlords"),
    date_from: date | None = None,
    date_to: date | None = None,
):
    tenancies = await db.fetch(
        "SELECT id, account_id FROM tenants WHERE user_id = $1 AND ($2::uuid IS NULL OR account_id = $2)",
        user.id, account_id)
    if not tenancies:
        raise HTTPException(404, "No tenancy found for this login")
    if len(tenancies) > 1:
        raise HTTPException(422, "You rent from more than one landlord: pass account_id")
    tenancy = tenancies[0]
    data, filename, mime = await exports.render_report_file(
        tenancy["account_id"], "tenant_statement", format,
        ReportParams(date_from, date_to, None, tenancy["id"]))
    return Response(data, media_type=mime, headers={
        "Content-Disposition": f'attachment; filename="{filename.replace("tenant-statement", "my-statement")}"',
        "Cache-Control": "private, max-age=300",
    })
