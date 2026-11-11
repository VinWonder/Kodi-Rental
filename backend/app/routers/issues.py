"""Caretaker elimination engine: tenant-reported issues, landlord triage,
contractor dispatch and maintenance expenses."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..db import as_dicts, build_update, db, or_404
from ..deps import AnyMember, IpDep, Staff, UserDep
from ..utils import KePhone, Money, PositiveMoney

router = APIRouter(tags=["issues"])

Category = Literal["plumbing", "electrical", "structural", "security", "pest_control", "appliance",
                   "sanitation", "internet", "other"]
Priority = Literal["low", "medium", "high", "emergency"]
IssueStatus = Literal["received", "under_review", "dispatched_contractor", "in_progress", "resolved",
                      "closed", "rejected"]
OPEN_STATUSES = ("received", "under_review", "dispatched_contractor", "in_progress")

ISSUE_COLUMNS = """i.id, i.account_id, i.ticket_number, i.property_id, p.name AS property_name, i.unit_id,
                   u.unit_number, i.tenant_id, t.full_name AS tenant_name, t.phone AS tenant_phone, i.lease_id,
                   i.category, i.priority, i.title, i.description, i.status, i.assigned_contractor_id,
                   c.name AS contractor_name, c.phone AS contractor_phone, i.scheduled_for, i.estimated_cost,
                   i.actual_cost, i.acknowledged_at, i.dispatched_at, i.resolved_at, i.closed_at,
                   i.resolution_notes, i.tenant_rating, i.tenant_feedback, i.created_at, i.updated_at"""
ISSUE_FROM = """issues i JOIN units u ON u.id = i.unit_id JOIN properties p ON p.id = i.property_id
                LEFT JOIN tenants t ON t.id = i.tenant_id LEFT JOIN contractors c ON c.id = i.assigned_contractor_id"""


class TenantIssueIn(BaseModel):
    lease_id: UUID | None = Field(default=None, description="Needed only if you rent more than one unit")
    category: Category
    priority: Priority = "medium"
    title: str = Field(min_length=3, max_length=150)
    description: str = Field(min_length=5, max_length=5000)
    attachment_media_ids: list[UUID] = Field(default_factory=list, max_length=10)


class StaffIssueIn(BaseModel):
    unit_id: UUID
    category: Category
    priority: Priority = "medium"
    title: str = Field(min_length=3, max_length=150)
    description: str = Field(min_length=5, max_length=5000)
    attachment_media_ids: list[UUID] = Field(default_factory=list, max_length=10)


class IssuePatch(BaseModel):
    status: IssueStatus | None = None
    priority: Priority | None = None
    assigned_contractor_id: UUID | None = None
    scheduled_for: datetime | None = None
    estimated_cost: Money | None = None
    actual_cost: Money | None = None
    resolution_notes: str | None = Field(default=None, max_length=4000)
    comment: str | None = Field(default=None, max_length=2000,
                                description="Shown to the tenant in the ticket timeline/notification")


class CommentIn(BaseModel):
    comment: str = Field(min_length=1, max_length=2000)
    is_internal: bool = False


class RatingIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    feedback: str | None = Field(default=None, max_length=1000)


class ContractorIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    company_name: str | None = Field(default=None, max_length=150)
    phone: KePhone
    email: str | None = Field(default=None, max_length=254)
    specialties: list[Category] = Field(default_factory=list)


class ContractorPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    company_name: str | None = Field(default=None, max_length=150)
    phone: KePhone | None = None
    email: str | None = Field(default=None, max_length=254)
    specialties: list[Category] | None = None
    rating: float | None = Field(default=None, ge=0, le=5)
    is_active: bool | None = None


class ExpenseIn(BaseModel):
    property_id: UUID
    unit_id: UUID | None = None
    contractor_id: UUID | None = None
    category: Category
    description: str = Field(min_length=3, max_length=250)
    amount: PositiveMoney
    incurred_on: date | None = None
    receipt_media_id: UUID | None = None


async def _issue_detail(issue_id: UUID, *, account_id: UUID | None = None,
                        tenant_user: UUID | None = None) -> dict:
    row = await db.fetchrow(
        f"""SELECT {ISSUE_COLUMNS} FROM {ISSUE_FROM}
            WHERE i.id = $1 AND ($2::uuid IS NULL OR i.account_id = $2) AND ($3::uuid IS NULL OR t.user_id = $3)""",
        issue_id, account_id, tenant_user)
    issue = or_404(row, "Issue")
    issue["timeline"] = as_dicts(await db.fetch(
        """SELECT iu.id, iu.from_status, iu.to_status, iu.comment, iu.is_internal, iu.created_at,
                  u.full_name AS author
           FROM issue_updates iu LEFT JOIN users u ON u.id = iu.author_id
           WHERE iu.issue_id = $1 AND (NOT $2 OR NOT iu.is_internal) ORDER BY iu.created_at""",
        issue_id, tenant_user is not None))
    issue["attachments"] = as_dicts(await db.fetch(
        """SELECT ia.media_id, mf.mime_type, '/api/v1/media/' || ia.media_id AS url, ia.created_at
           FROM issue_attachments ia JOIN media_files mf ON mf.id = ia.media_id AND mf.deleted_at IS NULL
           WHERE ia.issue_id = $1 ORDER BY ia.created_at""", issue_id))
    return issue


async def _attach(conn, issue_id: UUID, account_id: UUID, user_id: UUID, media_ids: list[UUID]) -> None:
    wanted = list(set(media_ids))
    if not wanted:
        return
    found = await conn.fetchval(
        """SELECT count(*) FROM media_files WHERE id = ANY($1::uuid[]) AND account_id = $2 AND uploaded_by = $3
           AND purpose = 'issue_attachment' AND deleted_at IS NULL""", wanted, account_id, user_id)
    if found != len(wanted):
        raise HTTPException(422, "Upload photos/videos with purpose=issue_attachment first")
    await conn.executemany(
        "INSERT INTO issue_attachments (issue_id, media_id, uploaded_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [(issue_id, mid, user_id) for mid in wanted])


# ------------------------------------------------------------------ tenant
@router.post("/me/issues", status_code=status.HTTP_201_CREATED)
async def report_issue(body: TenantIssueIn, user: UserDep, ip: IpDep):
    leases = await db.fetch(
        """SELECT l.id, l.account_id, l.unit_id, l.tenant_id FROM leases l JOIN tenants t ON t.id = l.tenant_id
           WHERE t.user_id = $1 AND l.status IN ('active', 'notice_given')""", user.id)
    if body.lease_id:
        leases = [l for l in leases if l["id"] == body.lease_id]
    if not leases:
        raise HTTPException(404, "No active tenancy found for your account")
    if len(leases) > 1:
        raise HTTPException(422, "You rent more than one unit: specify lease_id")
    lease = leases[0]
    async with db.tx(user_id=user.id, client_ip=ip) as conn:
        issue_id = await conn.fetchval(
            """INSERT INTO issues (account_id, unit_id, tenant_id, lease_id, reported_by, category, priority,
                                   title, description)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id""",
            lease["account_id"], lease["unit_id"], lease["tenant_id"], lease["id"], user.id, body.category,
            body.priority, body.title.strip(), body.description.strip())
        await _attach(conn, issue_id, lease["account_id"], user.id, body.attachment_media_ids)
    return await _issue_detail(issue_id, tenant_user=user.id)


@router.get("/me/issues")
async def my_issues(user: UserDep, open_only: bool = False):
    rows = await db.fetch(
        f"""SELECT {ISSUE_COLUMNS} FROM {ISSUE_FROM}
            WHERE t.user_id = $1 AND (NOT $2 OR i.status = ANY($3::issue_status[]))
            ORDER BY i.created_at DESC""", user.id, open_only, list(OPEN_STATUSES))
    return as_dicts(rows)


@router.get("/me/issues/{issue_id}")
async def my_issue(issue_id: UUID, user: UserDep):
    return await _issue_detail(issue_id, tenant_user=user.id)


@router.post("/me/issues/{issue_id}/comments", status_code=status.HTTP_201_CREATED)
async def tenant_comment(issue_id: UUID, body: CommentIn, user: UserDep):
    await _issue_detail(issue_id, tenant_user=user.id)  # access check
    await db.execute("INSERT INTO issue_updates (issue_id, author_id, comment) VALUES ($1, $2, $3)",
                     issue_id, user.id, body.comment.strip())
    return await _issue_detail(issue_id, tenant_user=user.id)


@router.post("/me/issues/{issue_id}/rate")
async def rate_issue(issue_id: UUID, body: RatingIn, user: UserDep):
    async with db.tx(user_id=user.id) as conn:
        updated = await conn.fetchval(
            """UPDATE issues i SET tenant_rating = $3, tenant_feedback = $4,
                      status = CASE WHEN i.status = 'resolved' THEN 'closed'::issue_status ELSE i.status END
               FROM tenants t WHERE t.id = i.tenant_id AND i.id = $1 AND t.user_id = $2
                 AND i.status IN ('resolved', 'closed') RETURNING i.id""",
            issue_id, user.id, body.rating, body.feedback)
        if updated is None:
            raise HTTPException(409, "You can rate an issue once it is resolved")
    return await _issue_detail(issue_id, tenant_user=user.id)


# ------------------------------------------------------------------ landlord
@router.get("/accounts/{account_id}/issues")
async def list_issues(
    m: AnyMember,
    issue_status: IssueStatus | None = Query(default=None, alias="status"),
    open_only: bool = False,
    priority: Priority | None = None,
    category: Category | None = None,
    property_id: UUID | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    rows = await db.fetch(
        f"""SELECT {ISSUE_COLUMNS} FROM {ISSUE_FROM}
            WHERE i.account_id = $1
              AND ($2::issue_status IS NULL OR i.status = $2)
              AND (NOT $3 OR i.status = ANY($4::issue_status[]))
              AND ($5::issue_priority IS NULL OR i.priority = $5)
              AND ($6::issue_category IS NULL OR i.category = $6)
              AND ($7::uuid IS NULL OR i.property_id = $7)
            ORDER BY CASE i.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                     i.created_at DESC
            LIMIT $8 OFFSET $9""",
        m.account_id, issue_status, open_only, list(OPEN_STATUSES), priority, category, property_id, limit, offset)
    return as_dicts(rows)


@router.post("/accounts/{account_id}/issues", status_code=status.HTTP_201_CREATED)
async def staff_create_issue(body: StaffIssueIn, m: Staff, ip: IpDep):
    """Landlord-raised ticket (e.g. from an inspection). Tenant is inferred from the live lease."""
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        issue_id = await conn.fetchval(
            """INSERT INTO issues (account_id, unit_id, reported_by, category, priority, title, description)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id""",
            m.account_id, body.unit_id, m.user.id, body.category, body.priority, body.title.strip(),
            body.description.strip())
        await _attach(conn, issue_id, m.account_id, m.user.id, body.attachment_media_ids)
    return await _issue_detail(issue_id, account_id=m.account_id)


@router.get("/accounts/{account_id}/issues/{issue_id}")
async def get_issue(issue_id: UUID, m: AnyMember):
    return await _issue_detail(issue_id, account_id=m.account_id)


@router.patch("/accounts/{account_id}/issues/{issue_id}")
async def update_issue(issue_id: UUID, body: IssuePatch, m: Staff, ip: IpDep):
    """Status changes notify the tenant; `comment` becomes the message they see.
    Resolving with actual_cost records a maintenance expense automatically."""
    changes = body.model_dump(exclude_unset=True)
    comment = changes.pop("comment", None)
    async with db.tx(user_id=m.user.id, reason=comment, client_ip=ip) as conn:
        current = or_404(await conn.fetchrow(
            "SELECT status FROM issues WHERE id = $1 AND account_id = $2 FOR UPDATE", issue_id, m.account_id), "Issue")
        if changes:
            sql, args = build_update("issues", changes, {"id": issue_id}, "id")
            await conn.fetchrow(sql, *args)
        status_changed = "status" in changes and changes["status"] != current["status"]
        if comment and not status_changed:
            await conn.execute("INSERT INTO issue_updates (issue_id, author_id, comment) VALUES ($1, $2, $3)",
                               issue_id, m.user.id, comment)
    return await _issue_detail(issue_id, account_id=m.account_id)


@router.post("/accounts/{account_id}/issues/{issue_id}/comments", status_code=status.HTTP_201_CREATED)
async def staff_comment(issue_id: UUID, body: CommentIn, m: Staff):
    await _issue_detail(issue_id, account_id=m.account_id)
    await db.execute("INSERT INTO issue_updates (issue_id, author_id, comment, is_internal) VALUES ($1, $2, $3, $4)",
                     issue_id, m.user.id, body.comment.strip(), body.is_internal)
    return await _issue_detail(issue_id, account_id=m.account_id)


# ------------------------------------------------------------------ contractors & expenses
@router.get("/accounts/{account_id}/contractors")
async def list_contractors(m: AnyMember, specialty: Category | None = None, include_inactive: bool = False):
    return as_dicts(await db.fetch(
        """SELECT id, name, company_name, phone, email, specialties, rating, is_active, created_at
           FROM contractors WHERE account_id = $1 AND ($2 OR is_active)
             AND ($3::issue_category IS NULL OR $3 = ANY(specialties))
           ORDER BY rating DESC NULLS LAST, name""", m.account_id, include_inactive, specialty))


@router.post("/accounts/{account_id}/contractors", status_code=status.HTTP_201_CREATED)
async def create_contractor(body: ContractorIn, m: Staff):
    row = await db.fetchrow(
        """INSERT INTO contractors (account_id, name, company_name, phone, email, specialties)
           VALUES ($1, $2, $3, $4, $5, $6::issue_category[])
           RETURNING id, name, company_name, phone, email, specialties, rating, is_active, created_at""",
        m.account_id, body.name, body.company_name, body.phone, body.email, body.specialties)
    return dict(row)


@router.patch("/accounts/{account_id}/contractors/{contractor_id}")
async def update_contractor(contractor_id: UUID, body: ContractorPatch, m: Staff):
    sql, args = build_update("contractors", body.model_dump(exclude_unset=True),
                             {"id": contractor_id, "account_id": m.account_id},
                             "id, name, company_name, phone, email, specialties, rating, is_active, created_at")
    return or_404(await db.fetchrow(sql, *args), "Contractor")


@router.get("/accounts/{account_id}/expenses")
async def list_expenses(m: AnyMember, property_id: UUID | None = None,
                        date_from: date | None = None, date_to: date | None = None):
    return as_dicts(await db.fetch(
        """SELECT e.id, e.property_id, p.name AS property_name, e.unit_id, e.issue_id, e.contractor_id,
                  c.name AS contractor_name, e.category, e.description, e.amount, e.incurred_on,
                  e.receipt_media_id, e.created_at
           FROM maintenance_expenses e JOIN properties p ON p.id = e.property_id
           LEFT JOIN contractors c ON c.id = e.contractor_id
           WHERE e.account_id = $1 AND ($2::uuid IS NULL OR e.property_id = $2)
             AND ($3::date IS NULL OR e.incurred_on >= $3) AND ($4::date IS NULL OR e.incurred_on <= $4)
           ORDER BY e.incurred_on DESC""", m.account_id, property_id, date_from, date_to))


@router.post("/accounts/{account_id}/expenses", status_code=status.HTTP_201_CREATED)
async def create_expense(body: ExpenseIn, m: Staff, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        expense_id = await conn.fetchval(
            """INSERT INTO maintenance_expenses (account_id, property_id, unit_id, contractor_id, category,
                                                 description, amount, incurred_on, receipt_media_id, recorded_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, nairobi_today()), $9, $10) RETURNING id""",
            m.account_id, body.property_id, body.unit_id, body.contractor_id, body.category, body.description,
            body.amount, body.incurred_on, body.receipt_media_id, m.user.id)
    return {"id": expense_id}
