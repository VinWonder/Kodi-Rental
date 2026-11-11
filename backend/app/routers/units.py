"""Units (doors / rooms / beds): CRUD, status engine, gallery, condition log."""
from __future__ import annotations

import re
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field

from ..db import as_dicts, build_update, db, or_404
from ..deps import AnyMember, IpDep, Staff
from ..state import StorageDep
from ..utils import Money, PositiveMoney

router = APIRouter(prefix="/accounts/{account_id}", tags=["units"])

UnitType = Literal["single_room", "bedsitter", "studio", "one_bedroom", "two_bedroom", "three_bedroom",
                   "four_plus_bedroom", "shared_hostel_room", "shared_hostel_bed", "shop", "office",
                   "warehouse", "other"]
# 'reserved' and 'occupied' are driven by leases, never set by hand.
ManualStatus = Literal["vacant", "under_maintenance", "cleaning", "inactive"]

UNIT_COLUMNS = """u.id, u.account_id, u.property_id, p.name AS property_name, u.parent_unit_id, u.unit_number,
                  u.payment_code, u.unit_type, u.floor_number, u.bedrooms, u.bathrooms, u.size_sqm,
                  u.bed_capacity, u.monthly_rent, u.deposit_amount, u.status, u.status_changed_at,
                  u.is_listed_public, u.listed_at, u.condition_summary, u.condition_tags, u.features,
                  u.created_at, u.updated_at"""


class UnitIn(BaseModel):
    unit_number: str = Field(min_length=1, max_length=30)
    payment_code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{2,20}$",
                                     description="M-Pesa 'Account No.'; generated if omitted")
    unit_type: UnitType
    parent_unit_id: UUID | None = None
    floor_number: int | None = Field(default=None, ge=-5, le=200)
    bedrooms: int | None = Field(default=None, ge=0, le=20)
    bathrooms: int | None = Field(default=None, ge=0, le=20)
    size_sqm: float | None = Field(default=None, gt=0, le=100000)
    bed_capacity: int = Field(default=1, ge=1, le=50)
    monthly_rent: PositiveMoney
    deposit_amount: Money = 0
    status: ManualStatus = "vacant"
    condition_summary: str | None = Field(default=None, max_length=2000)
    condition_tags: list[str] = Field(default_factory=list, max_length=30)
    features: list[str] = Field(default_factory=list, max_length=40)


class UnitPatch(BaseModel):
    unit_number: str | None = Field(default=None, min_length=1, max_length=30)
    payment_code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{2,20}$")
    unit_type: UnitType | None = None
    floor_number: int | None = Field(default=None, ge=-5, le=200)
    bedrooms: int | None = Field(default=None, ge=0, le=20)
    bathrooms: int | None = Field(default=None, ge=0, le=20)
    size_sqm: float | None = Field(default=None, gt=0, le=100000)
    bed_capacity: int | None = Field(default=None, ge=1, le=50)
    monthly_rent: PositiveMoney | None = None
    deposit_amount: Money | None = None
    is_listed_public: bool | None = Field(default=None, description="Hide/show a vacant unit")
    features: list[str] | None = None


class StatusIn(BaseModel):
    status: ManualStatus
    reason: str | None = Field(default=None, max_length=500)


class MediaPatch(BaseModel):
    caption: str | None = Field(default=None, max_length=200)
    sort_order: int | None = Field(default=None, ge=0, le=1000)
    is_cover: bool | None = None


class ConditionLogIn(BaseModel):
    notes: str = Field(min_length=3, max_length=4000)
    tags: list[str] = Field(default_factory=list, max_length=30)
    media_ids: list[UUID] = Field(default_factory=list, max_length=20)


def _default_payment_code(property_name: str, unit_number: str) -> str:
    prefix = re.sub(r"[^A-Z0-9]", "", property_name.upper())[:4] or "UNIT"
    suffix = re.sub(r"[^A-Z0-9]", "", unit_number.upper())[:12] or "0"
    return f"{prefix}-{suffix}"[:20]


async def _fetch_unit(account_id: UUID, unit_id: UUID) -> dict:
    row = await db.fetchrow(
        f"""SELECT {UNIT_COLUMNS}, f.lease_id, f.tenant_id, f.tenant_name, f.outstanding_balance,
                   f.days_in_arrears, f.financial_state
            FROM units u JOIN properties p ON p.id = u.property_id
            LEFT JOIN v_unit_financials f ON f.unit_id = u.id
            WHERE u.id = $1 AND u.account_id = $2""", unit_id, account_id)
    unit = or_404(row, "Unit")
    unit["gallery"] = as_dicts(await db.fetch(
        """SELECT um.media_id, um.caption, um.sort_order, um.is_cover, mf.mime_type,
                  '/api/v1/media/' || um.media_id AS url
           FROM unit_media um JOIN media_files mf ON mf.id = um.media_id AND mf.deleted_at IS NULL
           WHERE um.unit_id = $1 ORDER BY um.is_cover DESC, um.sort_order, um.created_at""", unit_id))
    return unit


@router.get("/units")
async def list_units(
    m: AnyMember,
    property_id: UUID | None = None,
    unit_status: ManualStatus | Literal["reserved", "occupied"] | None = Query(default=None, alias="status"),
    unit_type: UnitType | None = None,
    q: str | None = Query(default=None, max_length=50),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    rows = await db.fetch(
        f"""SELECT {UNIT_COLUMNS}, f.tenant_name, f.outstanding_balance, f.financial_state
            FROM units u JOIN properties p ON p.id = u.property_id
            LEFT JOIN v_unit_financials f ON f.unit_id = u.id
            WHERE u.account_id = $1
              AND ($2::uuid IS NULL OR u.property_id = $2)
              AND ($3::unit_status IS NULL OR u.status = $3)
              AND ($4::unit_type IS NULL OR u.unit_type = $4)
              AND ($5::text IS NULL OR u.unit_number ILIKE '%' || $5 || '%' OR u.payment_code ILIKE '%' || $5 || '%')
            ORDER BY p.name, u.floor_number NULLS FIRST, u.unit_number
            LIMIT $6 OFFSET $7""",
        m.account_id, property_id, unit_status, unit_type, q, limit, offset)
    return as_dicts(rows)


@router.post("/properties/{property_id}/units", status_code=status.HTTP_201_CREATED)
async def create_unit(property_id: UUID, body: UnitIn, m: Staff, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        prop_name = await conn.fetchval(
            "SELECT name FROM properties WHERE id = $1 AND account_id = $2 AND is_active", property_id, m.account_id)
        if prop_name is None:
            raise HTTPException(404, "Property not found")
        if body.parent_unit_id:
            ok = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM units WHERE id = $1 AND property_id = $2)",
                                     body.parent_unit_id, property_id)
            if not ok:
                raise HTTPException(422, "parent_unit_id must be a unit in the same property")
        unit_id = await conn.fetchval(
            """INSERT INTO units (account_id, property_id, parent_unit_id, unit_number, payment_code, unit_type,
                                  floor_number, bedrooms, bathrooms, size_sqm, bed_capacity, monthly_rent,
                                  deposit_amount, status, condition_summary, condition_tags, features)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
               RETURNING id""",
            m.account_id, property_id, body.parent_unit_id, body.unit_number.strip(),
            (body.payment_code or _default_payment_code(prop_name, body.unit_number)).upper(),
            body.unit_type, body.floor_number, body.bedrooms, body.bathrooms, body.size_sqm,
            body.bed_capacity, body.monthly_rent, body.deposit_amount, body.status,
            body.condition_summary, body.condition_tags, body.features)
    return await _fetch_unit(m.account_id, unit_id)


@router.get("/units/{unit_id}")
async def get_unit(unit_id: UUID, m: AnyMember):
    return await _fetch_unit(m.account_id, unit_id)


@router.patch("/units/{unit_id}")
async def update_unit(unit_id: UUID, body: UnitPatch, m: Staff, ip: IpDep):
    changes = body.model_dump(exclude_unset=True)
    if changes.get("payment_code"):
        changes["payment_code"] = changes["payment_code"].upper()
    sql, args = build_update("units", changes, {"id": unit_id, "account_id": m.account_id}, "id")
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        or_404(await conn.fetchrow(sql, *args), "Unit")
    return await _fetch_unit(m.account_id, unit_id)


@router.post("/units/{unit_id}/status")
async def change_unit_status(unit_id: UUID, body: StatusIn, m: Staff, ip: IpDep):
    """Vacant -> auto-listed publicly + staff alerted (database trigger)."""
    async with db.tx(user_id=m.user.id, reason=body.reason, client_ip=ip) as conn:
        or_404(await conn.fetchrow(
            "UPDATE units SET status = $3 WHERE id = $1 AND account_id = $2 RETURNING id",
            unit_id, m.account_id, body.status), "Unit")
    return await _fetch_unit(m.account_id, unit_id)


@router.get("/units/{unit_id}/history")
async def unit_history(unit_id: UUID, m: AnyMember):
    rows = await db.fetch(
        """SELECT h.id, h.from_status, h.to_status, h.reason, h.changed_at, u.full_name AS changed_by
           FROM unit_status_history h
           JOIN units un ON un.id = h.unit_id AND un.account_id = $2
           LEFT JOIN users u ON u.id = h.changed_by
           WHERE h.unit_id = $1 ORDER BY h.changed_at DESC LIMIT 200""", unit_id, m.account_id)
    return as_dicts(rows)


# ------------------------------------------------------------------ gallery
@router.post("/units/{unit_id}/media", status_code=status.HTTP_201_CREATED)
async def upload_unit_media(
    unit_id: UUID, m: Staff, storage: StorageDep, ip: IpDep,
    files: list[UploadFile] = File(..., description="Up to 10 images"),
    caption: str | None = Form(default=None, max_length=200),
):
    if len(files) > 10:
        raise HTTPException(422, "Upload at most 10 images at a time")
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        exists = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM units WHERE id = $1 AND account_id = $2)",
                                     unit_id, m.account_id)
        if not exists:
            raise HTTPException(404, "Unit not found")
        has_cover = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM unit_media WHERE unit_id = $1 AND is_cover)",
                                        unit_id)
        next_order = await conn.fetchval(
            "SELECT coalesce(max(sort_order) + 1, 0) FROM unit_media WHERE unit_id = $1", unit_id)
        for index, upload in enumerate(files):
            media = await storage.save_upload(conn, upload, purpose="unit_gallery",
                                              account_id=m.account_id, uploaded_by=m.user.id)
            await conn.execute(
                """INSERT INTO unit_media (unit_id, media_id, caption, sort_order, is_cover)
                   VALUES ($1, $2, $3, $4, $5)""",
                unit_id, media["id"], caption, next_order + index, not has_cover and index == 0)
    return (await _fetch_unit(m.account_id, unit_id))["gallery"]


@router.patch("/units/{unit_id}/media/{media_id}")
async def update_unit_media(unit_id: UUID, media_id: UUID, body: MediaPatch, m: Staff):
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(user_id=m.user.id) as conn:
        owned = await conn.fetchval(
            """SELECT EXISTS (SELECT 1 FROM unit_media um JOIN units u ON u.id = um.unit_id
                              WHERE um.unit_id = $1 AND um.media_id = $2 AND u.account_id = $3)""",
            unit_id, media_id, m.account_id)
        if not owned:
            raise HTTPException(404, "Image not found")
        if changes.get("is_cover"):
            await conn.execute("UPDATE unit_media SET is_cover = false WHERE unit_id = $1 AND is_cover", unit_id)
        sql, args = build_update("unit_media", changes, {"unit_id": unit_id, "media_id": media_id}, "media_id")
        await conn.fetchrow(sql, *args)
    return (await _fetch_unit(m.account_id, unit_id))["gallery"]


@router.delete("/units/{unit_id}/media/{media_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_unit_media(unit_id: UUID, media_id: UUID, m: Staff):
    async with db.tx(user_id=m.user.id) as conn:
        deleted = await conn.fetchval(
            """DELETE FROM unit_media um USING units u
               WHERE um.unit_id = u.id AND u.account_id = $3 AND um.unit_id = $1 AND um.media_id = $2
               RETURNING um.media_id""", unit_id, media_id, m.account_id)
        if deleted is None:
            raise HTTPException(404, "Image not found")
        await conn.execute("UPDATE media_files SET deleted_at = now() WHERE id = $1", media_id)


# ------------------------------------------------------------------ condition log
@router.get("/units/{unit_id}/condition-logs")
async def list_condition_logs(unit_id: UUID, m: AnyMember):
    rows = await db.fetch(
        """SELECT l.id, l.notes, l.tags, l.logged_at, us.full_name AS logged_by,
                  coalesce(array_agg(lm.media_id) FILTER (WHERE lm.media_id IS NOT NULL), '{}') AS media_ids
           FROM unit_condition_logs l
           JOIN units u ON u.id = l.unit_id AND u.account_id = $2
           LEFT JOIN users us ON us.id = l.logged_by
           LEFT JOIN unit_condition_log_media lm ON lm.log_id = l.id
           WHERE l.unit_id = $1
           GROUP BY l.id, us.full_name ORDER BY l.logged_at DESC""", unit_id, m.account_id)
    return as_dicts(rows)


@router.post("/units/{unit_id}/condition-logs", status_code=status.HTTP_201_CREATED)
async def add_condition_log(unit_id: UUID, body: ConditionLogIn, m: Staff, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        exists = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM units WHERE id = $1 AND account_id = $2)",
                                     unit_id, m.account_id)
        if not exists:
            raise HTTPException(404, "Unit not found")
        if body.media_ids:
            valid = await conn.fetchval(
                """SELECT count(*) FROM media_files WHERE id = ANY($1::uuid[]) AND account_id = $2
                   AND purpose = 'unit_condition' AND deleted_at IS NULL""", body.media_ids, m.account_id)
            if valid != len(set(body.media_ids)):
                raise HTTPException(422, "Upload photos with purpose=unit_condition first")
        log_id = await conn.fetchval(
            "INSERT INTO unit_condition_logs (unit_id, logged_by, notes, tags) VALUES ($1, $2, $3, $4) RETURNING id",
            unit_id, m.user.id, body.notes.strip(), [t.strip().lower() for t in body.tags])
        await conn.executemany(
            "INSERT INTO unit_condition_log_media (log_id, media_id) VALUES ($1, $2)",
            [(log_id, mid) for mid in set(body.media_ids)])
    return {"id": log_id}
