"""Media storage on local disk (swap `_persist` for S3/R2 later without
changing callers). File types are checked by magic bytes, not just the
browser-supplied Content-Type."""
from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO
from uuid import UUID

import anyio
import asyncpg
from fastapi import HTTPException, UploadFile

IMAGE = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
VIDEO = {"video/mp4", "video/webm", "video/quicktime"}
AUDIO = {"audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav"}
PDF = {"application/pdf"}

# Which file types each upload purpose accepts.
PURPOSE_TYPES: dict[str, set[str]] = {
    "avatar": IMAGE,
    "unit_gallery": IMAGE,
    "unit_condition": IMAGE | VIDEO,
    "tenant_id_document": IMAGE | PDF,
    "lease_document": PDF,
    "signature": {"image/png"},
    "issue_attachment": IMAGE | VIDEO | AUDIO,
    "chat_attachment": IMAGE | VIDEO | AUDIO | PDF,
    "expense_receipt": IMAGE | PDF,
}
STAFF_ONLY_PURPOSES = {"unit_gallery", "unit_condition", "lease_document", "expense_receipt"}
TENANT_PURPOSES = {"chat_attachment", "issue_attachment", "signature", "tenant_id_document"}

_EXTENSIONS = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic",
    "image/heif": ".heif", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "audio/webm": ".weba", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
    "audio/wav": ".wav", "application/pdf": ".pdf",
}


def _sniff(head: bytes) -> set[str]:
    """Content types compatible with the file's magic bytes."""
    if head.startswith(b"\xff\xd8\xff"):
        return {"image/jpeg"}
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return {"image/png"}
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return {"image/webp"}
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return {"audio/wav"}
    if head.startswith(b"%PDF-"):
        return {"application/pdf"}
    if head.startswith(b"\x1a\x45\xdf\xa3"):          # EBML: WebM / Matroska
        return {"video/webm", "audio/webm"}
    if head.startswith(b"OggS"):
        return {"audio/ogg"}
    if head.startswith(b"ID3") or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return {"audio/mpeg"}
    if head[4:8] == b"ftyp":                          # ISO BMFF family
        brand = head[8:12]
        if brand in (b"heic", b"heix", b"hevc", b"heim", b"heis"):
            return {"image/heic"}
        if brand in (b"mif1", b"msf1"):
            return {"image/heif", "image/heic"}
        if brand == b"M4A ":
            return {"audio/mp4"}
        if brand == b"qt  ":
            return {"video/quicktime"}
        return {"video/mp4", "audio/mp4", "video/quicktime"}
    return set()


def _persist(src: BinaryIO, dest: Path, max_bytes: int) -> tuple[int, str, bytes]:
    """Blocking copy (run in a worker thread). Returns (size, sha256, head)."""
    digest = hashlib.sha256()
    size = 0
    head = b""
    dest.parent.mkdir(parents=True, exist_ok=True)
    src.seek(0)
    with open(dest, "wb") as out:
        while chunk := src.read(1024 * 1024):
            if not head:
                head = chunk[:64]
            size += len(chunk)
            if size > max_bytes:
                raise ValueError("too_large")
            digest.update(chunk)
            out.write(chunk)
    return size, digest.hexdigest(), head


class MediaStorage:
    def __init__(self, root: str, max_upload_mb: int) -> None:
        self.root = Path(root).resolve()
        self.max_bytes = max_upload_mb * 1024 * 1024
        (self.root / "tmp").mkdir(parents=True, exist_ok=True)

    def path_for(self, storage_key: str) -> Path:
        path = (self.root / storage_key).resolve()
        if self.root not in path.parents:
            raise HTTPException(400, "Invalid storage key")
        return path

    async def save_upload(
        self,
        conn: asyncpg.Connection,
        upload: UploadFile,
        *,
        purpose: str,
        account_id: UUID | None,
        uploaded_by: UUID,
        duration_ms: int | None = None,
    ) -> dict[str, Any]:
        allowed = PURPOSE_TYPES.get(purpose)
        if allowed is None:
            raise HTTPException(422, f"Uploads are not allowed for purpose '{purpose}'")

        declared = (upload.content_type or "").split(";")[0].strip().lower()
        declared = {"audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/mp3": "audio/mpeg",
                    "audio/x-m4a": "audio/mp4"}.get(declared, declared)

        tmp = self.root / "tmp" / f"{uuid.uuid4().hex}.part"
        try:
            size, sha, head = await anyio.to_thread.run_sync(_persist, upload.file, tmp, self.max_bytes)
        except ValueError:
            tmp.unlink(missing_ok=True)
            raise HTTPException(413, f"File exceeds {self.max_bytes // (1024 * 1024)} MB")
        if size == 0:
            tmp.unlink(missing_ok=True)
            raise HTTPException(422, "Empty file")

        sniffed = _sniff(head)
        candidates = sniffed & allowed
        if declared in candidates:
            mime = declared
        elif len(candidates) == 1:
            mime = next(iter(candidates))
        else:
            tmp.unlink(missing_ok=True)
            raise HTTPException(415, f"Unsupported or mismatched file type for {purpose.replace('_', ' ')}")

        now = datetime.now(timezone.utc)
        media_id = uuid.uuid4()
        storage_key = f"{account_id or 'users'}/{now:%Y/%m}/{media_id.hex}{_EXTENSIONS[mime]}"
        final = self.path_for(storage_key)
        final.parent.mkdir(parents=True, exist_ok=True)
        await anyio.to_thread.run_sync(shutil.move, str(tmp), str(final))

        try:
            row = await conn.fetchrow(
                """INSERT INTO media_files (id, account_id, uploaded_by, purpose, storage_key,
                                            original_filename, mime_type, size_bytes, sha256, duration_ms)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                   RETURNING id, account_id, purpose, mime_type, size_bytes, original_filename,
                             duration_ms, created_at""",
                media_id, account_id, uploaded_by, purpose, storage_key,
                (upload.filename or "")[:255] or None, mime, size, sha, duration_ms,
            )
        except Exception:
            final.unlink(missing_ok=True)
            raise
        result = dict(row)
        result["url"] = f"/api/v1/media/{media_id}"
        return result

    async def save_bytes(
        self,
        conn: asyncpg.Connection,
        data: bytes,
        *,
        purpose: str,
        account_id: UUID | None,
        uploaded_by: UUID | None,
        filename: str,
        mime: str,
        extension: str,
    ) -> dict[str, Any]:
        """Store a server-generated file (receipt PDF, report export). The file
        is removed again if the surrounding transaction fails to record it."""
        if not data:
            raise ValueError("Refusing to store an empty generated file")
        now = datetime.now(timezone.utc)
        media_id = uuid.uuid4()
        storage_key = f"{account_id or 'users'}/{now:%Y/%m}/{media_id.hex}{extension}"
        final = self.path_for(storage_key)

        def _write() -> None:
            final.parent.mkdir(parents=True, exist_ok=True)
            final.write_bytes(data)

        await anyio.to_thread.run_sync(_write)
        try:
            row = await conn.fetchrow(
                """INSERT INTO media_files (id, account_id, uploaded_by, purpose, storage_key,
                                            original_filename, mime_type, size_bytes, sha256)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                   RETURNING id, account_id, purpose, mime_type, size_bytes, original_filename, created_at""",
                media_id, account_id, uploaded_by, purpose, storage_key, filename[:255], mime, len(data),
                hashlib.sha256(data).hexdigest(),
            )
        except BaseException:
            final.unlink(missing_ok=True)
            raise
        result = dict(row)
        result["url"] = f"/api/v1/media/{media_id}"
        result["storage_key"] = storage_key
        return result

    def delete_file(self, storage_key: str) -> None:
        try:
            os.remove(self.path_for(storage_key))
        except FileNotFoundError:
            pass
