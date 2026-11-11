"""Generic uploads (chat attachments, issue photos, signatures, ID scans,
lease PDFs) and access-controlled downloads."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from ..db import db
from ..deps import UserDep
from ..services.storage import STAFF_ONLY_PURPOSES, TENANT_PURPOSES
from ..state import StorageDep

router = APIRouter(prefix="/media", tags=["media"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def upload(
    user: UserDep,
    storage: StorageDep,
    file: UploadFile = File(...),
    purpose: str = Form(...),
    account_id: UUID | None = Form(default=None),
    duration_ms: int | None = Form(default=None, ge=0, le=3_600_000, description="Audio/video length"),
):
    if purpose == "avatar":
        account_id = None
    elif account_id is None:
        raise HTTPException(422, "account_id is required for this purpose")
    else:
        role = await db.fetchval("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
                                 account_id, user.id)
        is_tenant = await db.fetchval(
            "SELECT EXISTS (SELECT 1 FROM tenants WHERE account_id = $1 AND user_id = $2)", account_id, user.id)
        staff_ok = role in ("owner", "manager", "accountant") or (role is not None and purpose == "chat_attachment")
        tenant_ok = is_tenant and purpose in TENANT_PURPOSES
        if purpose in STAFF_ONLY_PURPOSES and role not in ("owner", "manager"):
            raise HTTPException(403, "Only owners and managers can upload this file type")
        if not (staff_ok or tenant_ok):
            raise HTTPException(403, "You cannot upload files to this account")

    async with db.tx(user_id=user.id) as conn:
        media = await storage.save_upload(conn, file, purpose=purpose, account_id=account_id,
                                          uploaded_by=user.id, duration_ms=duration_ms)
    if purpose == "avatar":
        await db.execute("UPDATE users SET avatar_media_id = $2 WHERE id = $1", user.id, media["id"])
    return media


@router.get("/{media_id}", response_class=FileResponse)
async def download(media_id: UUID, user: UserDep, storage: StorageDep):
    row = await db.fetchrow(
        """SELECT mf.storage_key, mf.mime_type, mf.original_filename
           FROM media_files mf
           WHERE mf.id = $1 AND mf.deleted_at IS NULL
             AND (
                 mf.uploaded_by = $2
                 OR EXISTS (SELECT 1 FROM account_members am WHERE am.account_id = mf.account_id AND am.user_id = $2)
                 -- tenants: only files attached to things they are part of
                 OR EXISTS (SELECT 1 FROM messages msg
                              JOIN conversation_participants cp ON cp.conversation_id = msg.conversation_id
                             WHERE msg.media_id = mf.id AND cp.user_id = $2)
                 OR EXISTS (SELECT 1 FROM issue_attachments ia JOIN issues i ON i.id = ia.issue_id
                              JOIN tenants t ON t.id = i.tenant_id
                             WHERE ia.media_id = mf.id AND t.user_id = $2)
                 OR EXISTS (SELECT 1 FROM leases l JOIN tenants t ON t.id = l.tenant_id
                             WHERE mf.id IN (l.lease_document_media_id, l.signature_media_id) AND t.user_id = $2)
                 OR EXISTS (SELECT 1 FROM receipts r JOIN payments p ON p.id = r.payment_id
                              JOIN tenants t ON t.id = p.tenant_id
                             WHERE r.pdf_media_id = mf.id AND t.user_id = $2)
                 OR EXISTS (SELECT 1 FROM unit_media um WHERE um.media_id = mf.id)
             )""", media_id, user.id)
    if row is None:
        raise HTTPException(404, "File not found")
    return FileResponse(storage.path_for(row["storage_key"]), media_type=row["mime_type"],
                        filename=row["original_filename"],
                        headers={"Cache-Control": "private, max-age=3600"})
