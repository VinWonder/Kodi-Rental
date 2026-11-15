"""Unauthenticated endpoints: Kenyan locations and the public vacancy
marketplace (only units the vacancy engine has listed)."""
from __future__ import annotations

from decimal import Decimal
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..db import as_dicts, db, or_404
from ..deps import UserDep
from ..state import StorageDep
from .units import UnitType

router = APIRouter(tags=["public"])


class SubCountyIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)


@router.get("/locations/counties")
async def counties():
    return as_dicts(await db.fetch("SELECT id, name, region FROM counties ORDER BY name"))


@router.get("/locations/counties/{county_id}/sub-counties")
async def sub_counties(county_id: int):
    return as_dicts(await db.fetch(
        "SELECT id, county_id, name FROM sub_counties WHERE county_id = $1 ORDER BY name", county_id))


@router.post("/locations/counties/{county_id}/sub-counties", status_code=status.HTTP_201_CREATED)
async def add_sub_county(county_id: int, body: SubCountyIn, _user: UserDep):
    row = await db.fetchrow(
        """INSERT INTO sub_counties (county_id, name) VALUES ($1, initcap($2))
           ON CONFLICT (county_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id, county_id, name""", county_id, body.name.strip())
    return dict(row)


@router.get("/public/vacancies")
async def search_vacancies(
    county_id: int | None = Query(default=None, ge=1, le=47),
    sub_county_id: int | None = None,
    q: str | None = Query(default=None, max_length=100, description="Estate, landmark or building name"),
    unit_type: UnitType | None = None,
    min_rent: Decimal | None = Query(default=None, ge=0),
    max_rent: Decimal | None = Query(default=None, ge=0),
    lat: float | None = Query(default=None, ge=-4.9, le=5.1),
    lng: float | None = Query(default=None, ge=33.8, le=42.0),
    sort: Literal["newest", "price_asc", "price_desc", "nearest"] = "newest",
    limit: int = Query(default=24, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    if sort == "nearest" and (lat is None or lng is None):
        raise HTTPException(422, "sort=nearest needs lat and lng")
    order = {
        "newest": "v.listed_at DESC",
        "price_asc": "v.monthly_rent ASC",
        "price_desc": "v.monthly_rent DESC",
        "nearest": "distance_km NULLS LAST",
    }[sort]
    rows = await db.fetch(
        f"""SELECT v.unit_id, v.unit_number, v.unit_type, v.bedrooms, v.bathrooms, v.size_sqm, v.monthly_rent,
                   v.deposit_amount, v.features, v.listed_at, v.property_id, v.property_name, v.property_type,
                   v.area, v.ward, v.landmark, v.latitude, v.longitude, v.amenities, v.county_id, v.county_name,
                   v.sub_county_name,
                   CASE WHEN cover.media_id IS NOT NULL THEN '/api/v1/public/media/' || cover.media_id END AS cover_url,
                   COALESCE(photos.urls, ARRAY[]::text[]) AS photos,
                   rv.rating_avg, COALESCE(rv.rating_count, 0) AS rating_count,
                   -- Kenya sits on the equator, so 1 degree ~ 111.32 km on both axes (error < 1%).
                   CASE WHEN $9::float8 IS NOT NULL AND $10::float8 IS NOT NULL AND v.latitude IS NOT NULL
                        THEN round(((point(v.longitude, v.latitude) <-> point($9, $10)) * 111.32)::numeric, 2)
                   END AS distance_km
            FROM v_public_vacancies v
            LEFT JOIN LATERAL (SELECT um.media_id FROM unit_media um
                               WHERE um.unit_id = v.unit_id ORDER BY um.is_cover DESC, um.sort_order LIMIT 1) cover ON true
            -- Up to five photos for the swipeable card carousel.
            LEFT JOIN LATERAL (SELECT array_agg('/api/v1/public/media/' || p.media_id ORDER BY p.is_cover DESC, p.sort_order) AS urls
                               FROM (SELECT um.media_id, um.is_cover, um.sort_order FROM unit_media um
                                     WHERE um.unit_id = v.unit_id ORDER BY um.is_cover DESC, um.sort_order LIMIT 5) p) photos ON true
            -- Verified-tenant rating of the building (see routers/reviews.py).
            LEFT JOIN LATERAL (SELECT round(avg(r.rating), 1)::float AS rating_avg, count(*)::int AS rating_count
                               FROM property_reviews r WHERE r.property_id = v.property_id) rv ON true
            WHERE ($1::smallint IS NULL OR v.county_id = $1)
              AND ($2::integer IS NULL OR v.property_id IN (SELECT id FROM properties WHERE sub_county_id = $2))
              AND ($3::text IS NULL OR v.property_id IN (
                      SELECT id FROM properties
                      WHERE search_vector @@ websearch_to_tsquery('simple', $3) OR area % $3 OR name % $3))
              AND ($4::unit_type IS NULL OR v.unit_type = $4)
              AND ($5::numeric IS NULL OR v.monthly_rent >= $5)
              AND ($6::numeric IS NULL OR v.monthly_rent <= $6)
            ORDER BY {order}
            LIMIT $7 OFFSET $8""",
        county_id, sub_county_id, q, unit_type, min_rent, max_rent, limit, offset, lng, lat)
    return as_dicts(rows)


@router.get("/public/vacancies/{unit_id}")
async def vacancy_detail(unit_id: UUID):
    row = await db.fetchrow(
        """SELECT v.*, a.business_name AS landlord_name, a.contact_phone AS landlord_phone,
                  rv.rating_avg, COALESCE(rv.rating_count, 0) AS rating_count
           FROM v_public_vacancies v JOIN accounts a ON a.id = v.account_id
           LEFT JOIN LATERAL (SELECT round(avg(r.rating), 1)::float AS rating_avg, count(*)::int AS rating_count
                              FROM property_reviews r WHERE r.property_id = v.property_id) rv ON true
           WHERE v.unit_id = $1""", unit_id)
    unit = or_404(row, "Listing")
    unit.pop("cover_image_key", None)
    unit["gallery"] = [f"/api/v1/public/media/{r['media_id']}" for r in await db.fetch(
        "SELECT media_id FROM unit_media WHERE unit_id = $1 ORDER BY is_cover DESC, sort_order", unit_id)]
    return unit


@router.get("/public/media/{media_id}", response_class=FileResponse)
async def public_media(media_id: UUID, storage: StorageDep):
    """Only gallery images of currently listed units are public."""
    row = await db.fetchrow(
        """SELECT mf.storage_key, mf.mime_type FROM media_files mf
           JOIN unit_media um ON um.media_id = mf.id
           JOIN units u ON u.id = um.unit_id AND u.is_listed_public
           WHERE mf.id = $1 AND mf.deleted_at IS NULL LIMIT 1""", media_id)
    if row is None:
        raise HTTPException(404, "Image not found")
    return FileResponse(storage.path_for(row["storage_key"]), media_type=row["mime_type"],
                        headers={"Cache-Control": "public, max-age=86400"})
