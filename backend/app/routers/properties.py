"""Properties (buildings) owned by a landlord account."""
from __future__ import annotations

from decimal import Decimal
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, Field, model_validator

from ..db import as_dicts, build_update, db, or_404
from ..deps import AnyMember, IpDep, Staff

router = APIRouter(prefix="/accounts/{account_id}/properties", tags=["properties"])

PropertyType = Literal["apartment_flats", "storey_building", "hostel", "commercial_plaza",
                       "bungalow", "maisonette", "mixed_use", "other"]

PROPERTY_COLUMNS = """p.id, p.account_id, p.name, p.property_type, p.county_id, c.name AS county_name,
                      p.sub_county_id, sc.name AS sub_county_name, p.ward, p.area, p.street_address,
                      p.landmark, p.latitude, p.longitude, p.floors_count, p.amenities, p.description,
                      p.is_active, p.created_at, p.updated_at"""
PROPERTY_FROM = """properties p
                   JOIN counties c ON c.id = p.county_id
                   LEFT JOIN sub_counties sc ON sc.id = p.sub_county_id"""
OCCUPANCY_COLUMNS = """o.total_units, o.occupied, o.vacant, o.reserved, o.under_maintenance, o.cleaning,
                       o.occupancy_rate_pct, o.actual_rent_roll, o.potential_rent_roll"""


class _Location(BaseModel):
    latitude: Decimal | None = Field(default=None, ge=Decimal("-4.9"), le=Decimal("5.1"), decimal_places=6)
    longitude: Decimal | None = Field(default=None, ge=Decimal("33.8"), le=Decimal("42.0"), decimal_places=6)

    @model_validator(mode="after")
    def both_or_neither(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("Provide both latitude and longitude, or neither")
        return self


class PropertyIn(_Location):
    name: str = Field(min_length=2, max_length=150)
    property_type: PropertyType
    county_id: int = Field(ge=1, le=47)
    sub_county_id: int | None = None
    ward: str | None = Field(default=None, max_length=80)
    area: str = Field(min_length=2, max_length=120, description="Estate / neighbourhood, e.g. Kilimani")
    street_address: str | None = Field(default=None, max_length=200)
    landmark: str | None = Field(default=None, max_length=200)
    floors_count: int | None = Field(default=None, ge=1, le=200)
    amenities: list[str] = Field(default_factory=list, max_length=40)
    description: str | None = Field(default=None, max_length=5000)


class PropertyPatch(_Location):
    name: str | None = Field(default=None, min_length=2, max_length=150)
    property_type: PropertyType | None = None
    county_id: int | None = Field(default=None, ge=1, le=47)
    sub_county_id: int | None = None
    ward: str | None = Field(default=None, max_length=80)
    area: str | None = Field(default=None, min_length=2, max_length=120)
    street_address: str | None = Field(default=None, max_length=200)
    landmark: str | None = Field(default=None, max_length=200)
    floors_count: int | None = Field(default=None, ge=1, le=200)
    amenities: list[str] | None = None
    description: str | None = Field(default=None, max_length=5000)
    is_active: bool | None = None


async def _fetch_property(account_id: UUID, property_id: UUID) -> dict:
    row = await db.fetchrow(
        f"""SELECT {PROPERTY_COLUMNS}, {OCCUPANCY_COLUMNS}
            FROM {PROPERTY_FROM}
            LEFT JOIN v_property_occupancy o ON o.property_id = p.id
            WHERE p.id = $1 AND p.account_id = $2""", property_id, account_id)
    return or_404(row, "Property")


@router.get("")
async def list_properties(
    m: AnyMember,
    q: str | None = Query(default=None, max_length=100, description="Name, estate, landmark (typo tolerant)"),
    county_id: int | None = Query(default=None, ge=1, le=47),
    include_inactive: bool = False,
):
    rows = await db.fetch(
        f"""SELECT {PROPERTY_COLUMNS}, {OCCUPANCY_COLUMNS}
            FROM {PROPERTY_FROM}
            LEFT JOIN v_property_occupancy o ON o.property_id = p.id
            WHERE p.account_id = $1
              AND ($2::boolean OR p.is_active)
              AND ($3::smallint IS NULL OR p.county_id = $3)
              AND ($4::text IS NULL
                   OR p.search_vector @@ websearch_to_tsquery('simple', $4)
                   OR p.area % $4 OR p.name % $4)
            ORDER BY p.name""",
        m.account_id, include_inactive, county_id, q)
    return as_dicts(rows)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_property(body: PropertyIn, m: Staff, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        property_id = await conn.fetchval(
            """INSERT INTO properties (account_id, name, property_type, county_id, sub_county_id, ward, area,
                                       street_address, landmark, latitude, longitude, floors_count,
                                       amenities, description)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id""",
            m.account_id, body.name.strip(), body.property_type, body.county_id, body.sub_county_id,
            body.ward, body.area.strip(), body.street_address, body.landmark, body.latitude,
            body.longitude, body.floors_count, [a.strip().lower() for a in body.amenities], body.description)
    return await _fetch_property(m.account_id, property_id)


@router.get("/{property_id}")
async def get_property(property_id: UUID, m: AnyMember):
    return await _fetch_property(m.account_id, property_id)


@router.patch("/{property_id}")
async def update_property(property_id: UUID, body: PropertyPatch, m: Staff, ip: IpDep):
    changes = body.model_dump(exclude_unset=True)
    if "amenities" in changes and changes["amenities"] is not None:
        changes["amenities"] = [a.strip().lower() for a in changes["amenities"]]
    sql, args = build_update("properties", changes, {"id": property_id, "account_id": m.account_id}, "id")
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        or_404(await conn.fetchrow(sql, *args), "Property")
    return await _fetch_property(m.account_id, property_id)


@router.delete("/{property_id}", status_code=status.HTTP_204_NO_CONTENT)
async def archive_property(property_id: UUID, m: Staff, ip: IpDep):
    """Soft delete: hides the property; history, invoices and payments are kept."""
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        or_404(await conn.fetchrow(
            "UPDATE properties SET is_active = false WHERE id = $1 AND account_id = $2 RETURNING id",
            property_id, m.account_id), "Property")
