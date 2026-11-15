"""Verified tenant reviews of buildings.

Trust rules (why Kodi ratings mean something):
* only a tenant record linked to the reviewer's own login counts;
* that tenant must have a signed lease on a unit in the property that has run
  for at least REVIEW_AFTER_DAYS days (current or past tenancy);
* one review per tenant per property; editing replaces it;
* the landlord may reply publicly but can never edit or delete a review.
Public listings show only a first name and last initial.
"""
from __future__ import annotations

import json
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..db import as_dicts, db
from ..deps import AnyMember, IpDep, Staff, UserDep

router = APIRouter(tags=["reviews"])

REVIEW_AFTER_DAYS = 30
SIGNED_STATUSES = "('active', 'notice_given', 'terminated', 'expired')"

# Public author label: "Wanjiru K." - never a full name, phone or unit.
AUTHOR = "t.first_name || ' ' || left(t.last_name, 1) || '.'"


class ReviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=1000)


class ReplyIn(BaseModel):
    reply: str = Field(min_length=2, max_length=1000)


def _clean(text: str | None) -> str | None:
    text = (text or "").strip()
    return text or None


# ------------------------------------------------------------------ tenant
@router.get("/me/reviews")
async def my_reviewable_homes(user: UserDep):
    """Every building the user has rented in, whether they can review it yet,
    and their review if they wrote one."""
    rows = await db.fetch(
        f"""SELECT p.id AS property_id, p.name AS property_name, p.area, t.id AS tenant_id,
                   min(l.activated_at) AS since,
                   (min(l.activated_at) + make_interval(days => {REVIEW_AFTER_DAYS}))::date AS eligible_from,
                   min(l.activated_at) <= now() - make_interval(days => {REVIEW_AFTER_DAYS}) AS eligible,
                   bool_or(l.status IN ('active', 'notice_given')) AS current_home,
                   r.id AS review_id, r.rating, r.comment, r.landlord_reply, r.replied_at, r.updated_at AS reviewed_at
            FROM tenants t
            JOIN leases l ON l.tenant_id = t.id AND l.status IN {SIGNED_STATUSES} AND l.activated_at IS NOT NULL
            JOIN units u ON u.id = l.unit_id
            JOIN properties p ON p.id = u.property_id
            LEFT JOIN property_reviews r ON r.property_id = p.id AND r.tenant_id = t.id
            WHERE t.user_id = $1
            GROUP BY p.id, t.id, r.id
            ORDER BY current_home DESC, since DESC""", user.id)
    return as_dicts(rows)


async def _eligible_tenant(conn, user_id: UUID, property_id: UUID):
    return await conn.fetchrow(
        f"""SELECT t.id AS tenant_id, t.account_id, p.name AS property_name,
                   min(l.activated_at) <= now() - make_interval(days => {REVIEW_AFTER_DAYS}) AS eligible
            FROM tenants t
            JOIN leases l ON l.tenant_id = t.id AND l.status IN {SIGNED_STATUSES} AND l.activated_at IS NOT NULL
            JOIN units u ON u.id = l.unit_id AND u.property_id = $2
            JOIN properties p ON p.id = u.property_id
            WHERE t.user_id = $1
            GROUP BY t.id, p.id
            ORDER BY eligible DESC LIMIT 1""", user_id, property_id)


@router.put("/me/reviews/{property_id}")
async def write_review(property_id: UUID, body: ReviewIn, user: UserDep, ip: IpDep):
    async with db.tx(user_id=user.id, client_ip=ip) as conn:
        who = await _eligible_tenant(conn, user.id, property_id)
        if who is None:
            raise HTTPException(403, "Only tenants who have rented in this building can review it")
        if not who["eligible"]:
            raise HTTPException(403, f"You can review your home after living there {REVIEW_AFTER_DAYS} days")
        row = await conn.fetchrow(
            """INSERT INTO property_reviews (account_id, property_id, tenant_id, author_user_id, rating, comment)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (property_id, tenant_id) DO UPDATE
                 SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()
               RETURNING id, property_id, rating, comment, landlord_reply, replied_at, created_at, updated_at,
                         (xmax = 0) AS is_new""",
            who["account_id"], property_id, who["tenant_id"], user.id, body.rating, _clean(body.comment))
        if row["is_new"]:
            await conn.execute(
                "SELECT fn_notify_account_staff($1, 'system', $2, $3, $4::jsonb)",
                who["account_id"], f"New {body.rating}-star review",
                f"{who['property_name']}: {(_clean(body.comment) or 'No comment')[:120]}",
                json.dumps({"review_id": str(row["id"]), "property_id": str(property_id)}))
    out = dict(row)
    out.pop("is_new")
    return out


@router.delete("/me/reviews/{property_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_review(property_id: UUID, user: UserDep, ip: IpDep):
    async with db.tx(user_id=user.id, client_ip=ip) as conn:
        await conn.execute(
            """DELETE FROM property_reviews r USING tenants t
               WHERE r.tenant_id = t.id AND t.user_id = $1 AND r.property_id = $2""", user.id, property_id)


# ------------------------------------------------------------------ landlord
@router.get("/accounts/{account_id}/reviews")
async def account_reviews(m: AnyMember, property_id: UUID | None = None,
                          limit: int = Query(default=50, ge=1, le=200)):
    rows = await db.fetch(
        f"""SELECT r.id, r.property_id, p.name AS property_name, r.rating, r.comment, r.landlord_reply,
                   r.replied_at, r.created_at, r.updated_at, {AUTHOR} AS author, t.id AS tenant_id
            FROM property_reviews r
            JOIN properties p ON p.id = r.property_id
            JOIN tenants t ON t.id = r.tenant_id
            WHERE r.account_id = $1 AND ($2::uuid IS NULL OR r.property_id = $2)
            ORDER BY r.created_at DESC LIMIT $3""", m.account_id, property_id, limit)
    return as_dicts(rows)


@router.post("/accounts/{account_id}/reviews/{review_id}/reply")
async def reply_to_review(review_id: UUID, body: ReplyIn, m: Staff, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        row = await conn.fetchrow(
            """UPDATE property_reviews SET landlord_reply = $3, replied_at = now(), replied_by = $4
               WHERE id = $1 AND account_id = $2
               RETURNING id, property_id, rating, comment, landlord_reply, replied_at, tenant_id""",
            review_id, m.account_id, body.reply.strip(), m.user.id)
        if row is None:
            raise HTTPException(404, "Review not found")
        await conn.execute(
            "SELECT fn_notify_tenant($1, 'system', 'Your landlord replied to your review', $2, $3::jsonb)",
            row["tenant_id"], body.reply.strip()[:140], json.dumps({"review_id": str(review_id)}))
    out = dict(row)
    out.pop("tenant_id")
    return out


# ------------------------------------------------------------------ public
@router.get("/public/properties/{property_id}/reviews")
async def public_reviews(property_id: UUID, limit: int = Query(default=20, ge=1, le=100),
                         offset: int = Query(default=0, ge=0)):
    summary = await db.fetchrow(
        """SELECT count(*)::int AS count, round(avg(rating), 1)::float AS average,
                  count(*) FILTER (WHERE rating = 5)::int AS r5, count(*) FILTER (WHERE rating = 4)::int AS r4,
                  count(*) FILTER (WHERE rating = 3)::int AS r3, count(*) FILTER (WHERE rating = 2)::int AS r2,
                  count(*) FILTER (WHERE rating = 1)::int AS r1
           FROM property_reviews r JOIN properties p ON p.id = r.property_id AND p.is_active
           WHERE r.property_id = $1""", property_id)
    rows = await db.fetch(
        f"""SELECT r.id, r.rating, r.comment, r.landlord_reply, r.replied_at, r.created_at, r.updated_at,
                   {AUTHOR} AS author,
                   bool_or(l.status IN ('active', 'notice_given')) AS current_tenant,
                   min(l.activated_at)::date AS lived_since
            FROM property_reviews r
            JOIN properties p ON p.id = r.property_id AND p.is_active
            JOIN tenants t ON t.id = r.tenant_id
            LEFT JOIN leases l ON l.tenant_id = t.id AND l.status IN {SIGNED_STATUSES}
                              AND l.unit_id IN (SELECT id FROM units WHERE property_id = r.property_id)
            WHERE r.property_id = $1
            GROUP BY r.id, t.id
            ORDER BY r.created_at DESC LIMIT $2 OFFSET $3""", property_id, limit, offset)
    s = dict(summary)
    return {"count": s["count"], "average": s["average"],
            "distribution": {str(k): s[f"r{k}"] for k in range(5, 0, -1)},
            "reviews": as_dicts(rows)}
