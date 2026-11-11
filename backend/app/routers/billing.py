"""Invoices, payments, receipts, reconciliation and financial reports (JSON;
PDF/CSV export is Phase 5)."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field, model_validator

from ..db import as_dicts, db, or_404
from ..deps import AnyMember, Finance, IpDep, Owner, UserDep
from ..services.exports import load_receipt
from ..utils import Money, PositiveMoney

router = APIRouter(tags=["billing"])

InvoiceStatus = Literal["draft", "issued", "partially_paid", "paid", "overdue", "void"]
ItemType = Literal["rent", "deposit", "water", "electricity", "garbage", "service_charge", "late_fee", "other"]

INVOICE_COLUMNS = """i.id, i.account_id, i.lease_id, i.tenant_id, t.full_name AS tenant_name, i.unit_id,
                     u.unit_number, p.name AS property_name, i.invoice_number, i.status, i.period_start,
                     i.period_end, i.issue_date, i.due_date, i.vat_rate, i.subtotal, i.tax_amount,
                     i.total_amount, i.amount_paid, i.balance, i.is_auto_generated, i.paid_at, i.voided_at,
                     i.void_reason, i.notes, i.created_at"""
INVOICE_FROM = """invoices i JOIN tenants t ON t.id = i.tenant_id JOIN units u ON u.id = i.unit_id
                  JOIN properties p ON p.id = u.property_id"""
PAYMENT_COLUMNS = """pm.id, pm.account_id, pm.tenant_id, t.full_name AS tenant_name, pm.lease_id, pm.method,
                     pm.status, pm.amount, pm.allocated_amount, pm.unallocated_amount, pm.mpesa_receipt_number,
                     pm.external_reference, pm.payer_phone, pm.payer_name, pm.bill_ref_number, pm.paid_at,
                     pm.reconciled_at, pm.notes, r.id AS receipt_id, r.receipt_number, pm.created_at"""
PAYMENT_FROM = """payments pm LEFT JOIN tenants t ON t.id = pm.tenant_id
                  LEFT JOIN receipts r ON r.payment_id = pm.id"""


class ItemIn(BaseModel):
    item_type: ItemType
    description: str = Field(min_length=2, max_length=200)
    quantity: float = Field(default=1, gt=0, le=1_000_000)
    unit_price: Money


class ManualInvoiceIn(BaseModel):
    lease_id: UUID
    period_start: date
    period_end: date
    due_date: date
    notes: str | None = Field(default=None, max_length=1000)
    items: list[ItemIn] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def check_dates(self):
        if self.period_end < self.period_start or self.due_date < self.period_start:
            raise ValueError("period_end and due_date must be on or after period_start")
        return self


class VoidIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class ManualPaymentIn(BaseModel):
    tenant_id: UUID
    lease_id: UUID | None = None
    target_invoice_id: UUID | None = None
    method: Literal["cash", "bank_transfer", "cheque", "adjustment"]
    amount: PositiveMoney
    external_reference: str | None = Field(default=None, max_length=60)
    paid_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=1000)


class AssignPaymentIn(BaseModel):
    tenant_id: UUID
    lease_id: UUID | None = None


async def _invoice_detail(invoice_id: UUID, *, account_id: UUID | None = None,
                          tenant_user: UUID | None = None) -> dict:
    row = await db.fetchrow(
        f"""SELECT {INVOICE_COLUMNS} FROM {INVOICE_FROM}
            WHERE i.id = $1 AND ($2::uuid IS NULL OR i.account_id = $2) AND ($3::uuid IS NULL OR t.user_id = $3)""",
        invoice_id, account_id, tenant_user)
    invoice = or_404(row, "Invoice")
    invoice["items"] = as_dicts(await db.fetch(
        "SELECT id, item_type, description, quantity, unit_price, amount FROM invoice_items WHERE invoice_id = $1 ORDER BY id",
        invoice_id))
    invoice["payments"] = as_dicts(await db.fetch(
        """SELECT pa.amount AS allocated, pa.allocated_at, pm.id AS payment_id, pm.method,
                  pm.mpesa_receipt_number, pm.paid_at, r.receipt_number
           FROM payment_allocations pa JOIN payments pm ON pm.id = pa.payment_id
           LEFT JOIN receipts r ON r.payment_id = pm.id
           WHERE pa.invoice_id = $1 ORDER BY pa.allocated_at""", invoice_id))
    return invoice


# ------------------------------------------------------------------ invoices (landlord)
@router.get("/accounts/{account_id}/invoices")
async def list_invoices(
    m: AnyMember,
    invoice_status: InvoiceStatus | None = Query(default=None, alias="status"),
    tenant_id: UUID | None = None,
    lease_id: UUID | None = None,
    property_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    rows = await db.fetch(
        f"""SELECT {INVOICE_COLUMNS} FROM {INVOICE_FROM}
            WHERE i.account_id = $1
              AND ($2::invoice_status IS NULL OR i.status = $2)
              AND ($3::uuid IS NULL OR i.tenant_id = $3)
              AND ($4::uuid IS NULL OR i.lease_id = $4)
              AND ($5::uuid IS NULL OR u.property_id = $5)
              AND ($6::date IS NULL OR i.issue_date >= $6)
              AND ($7::date IS NULL OR i.issue_date <= $7)
            ORDER BY i.issue_date DESC, i.created_at DESC LIMIT $8 OFFSET $9""",
        m.account_id, invoice_status, tenant_id, lease_id, property_id, date_from, date_to, limit, offset)
    return as_dicts(rows)


@router.get("/accounts/{account_id}/invoices/{invoice_id}")
async def get_invoice(invoice_id: UUID, m: AnyMember):
    invoice = await _invoice_detail(invoice_id, account_id=m.account_id)
    invoice["stk_requests"] = as_dicts(await db.fetch(
        """SELECT id, phone, amount, status, result_desc, mpesa_receipt_number, created_at
           FROM mpesa_stk_requests WHERE invoice_id = $1 ORDER BY created_at DESC""", invoice_id))
    return invoice


@router.post("/accounts/{account_id}/invoices", status_code=status.HTTP_201_CREATED)
async def create_manual_invoice(body: ManualInvoiceIn, m: Finance, ip: IpDep):
    """One-off invoice, e.g. a water bill or repair recharge."""
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        invoice_id = await conn.fetchval(
            """INSERT INTO invoices (account_id, lease_id, period_start, period_end, due_date, notes,
                                     is_auto_generated)
               VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id""",
            m.account_id, body.lease_id, body.period_start, body.period_end, body.due_date, body.notes)
        await conn.executemany(
            """INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price)
               VALUES ($1, $2, $3, $4, $5)""",
            [(invoice_id, it.item_type, it.description, it.quantity, it.unit_price) for it in body.items])
        tenant_id, total, number = await conn.fetchrow(
            "SELECT tenant_id, total_amount, invoice_number FROM invoices WHERE id = $1", invoice_id)
        await conn.execute(
            "SELECT fn_notify_tenant($1, 'invoice_issued', $2, $3, $4)", tenant_id, f"New invoice {number}",
            f"KES {total:,.2f} due by {body.due_date:%d %b %Y}.", {"invoice_id": str(invoice_id)})
    return await _invoice_detail(invoice_id, account_id=m.account_id)


@router.post("/accounts/{account_id}/invoices/{invoice_id}/items", status_code=status.HTTP_201_CREATED)
async def add_invoice_item(invoice_id: UUID, body: ItemIn, m: Finance, ip: IpDep):
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        inv_status = await conn.fetchval("SELECT status FROM invoices WHERE id = $1 AND account_id = $2",
                                         invoice_id, m.account_id)
        if inv_status is None:
            raise HTTPException(404, "Invoice not found")
        if inv_status == "void":
            raise HTTPException(409, "Cannot add items to a void invoice")
        await conn.execute(
            """INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price)
               VALUES ($1, $2, $3, $4, $5)""",
            invoice_id, body.item_type, body.description, body.quantity, body.unit_price)
    return await _invoice_detail(invoice_id, account_id=m.account_id)


@router.post("/accounts/{account_id}/invoices/{invoice_id}/void")
async def void_invoice(invoice_id: UUID, body: VoidIn, m: Finance, ip: IpDep):
    async with db.tx(user_id=m.user.id, reason=body.reason, client_ip=ip) as conn:
        inv = or_404(await conn.fetchrow(
            "SELECT status, amount_paid FROM invoices WHERE id = $1 AND account_id = $2 FOR UPDATE",
            invoice_id, m.account_id), "Invoice")
        if inv["status"] == "void":
            raise HTTPException(409, "Invoice is already void")
        if inv["amount_paid"] > 0:
            raise HTTPException(409, "This invoice has payments. Reverse or reassign them before voiding.")
        await conn.execute("UPDATE invoices SET status = 'void', void_reason = $2 WHERE id = $1",
                           invoice_id, body.reason)
    return await _invoice_detail(invoice_id, account_id=m.account_id)


# ------------------------------------------------------------------ payments (landlord)
@router.get("/accounts/{account_id}/payments")
async def list_payments(
    m: AnyMember,
    tenant_id: UUID | None = None,
    unmatched: bool = False,
    method: Literal["mpesa_stk", "mpesa_c2b", "bank_transfer", "cash", "cheque", "adjustment"] | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    rows = await db.fetch(
        f"""SELECT {PAYMENT_COLUMNS} FROM {PAYMENT_FROM}
            WHERE pm.account_id = $1
              AND ($2::uuid IS NULL OR pm.tenant_id = $2)
              AND (NOT $3 OR (pm.tenant_id IS NULL AND pm.status = 'completed'))
              AND ($4::payment_method IS NULL OR pm.method = $4)
              AND ($5::date IS NULL OR (pm.paid_at AT TIME ZONE 'Africa/Nairobi')::date >= $5)
              AND ($6::date IS NULL OR (pm.paid_at AT TIME ZONE 'Africa/Nairobi')::date <= $6)
            ORDER BY pm.paid_at DESC LIMIT $7 OFFSET $8""",
        m.account_id, tenant_id, unmatched, method, date_from, date_to, limit, offset)
    return as_dicts(rows)


async def _payment(payment_id: UUID, account_id: UUID) -> dict:
    row = await db.fetchrow(f"SELECT {PAYMENT_COLUMNS} FROM {PAYMENT_FROM} WHERE pm.id = $1 AND pm.account_id = $2",
                            payment_id, account_id)
    payment = or_404(row, "Payment")
    payment["allocations"] = as_dicts(await db.fetch(
        """SELECT pa.invoice_id, i.invoice_number, pa.amount FROM payment_allocations pa
           JOIN invoices i ON i.id = pa.invoice_id WHERE pa.payment_id = $1 ORDER BY pa.id""", payment_id))
    return payment


@router.post("/accounts/{account_id}/payments", status_code=status.HTTP_201_CREATED)
async def record_payment(body: ManualPaymentIn, m: Finance, ip: IpDep):
    """Cash / bank / cheque payments. Allocation and receipt are automatic."""
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        payment_id = await conn.fetchval(
            """INSERT INTO payments (account_id, tenant_id, lease_id, target_invoice_id, method, status, amount,
                                     external_reference, paid_at, recorded_by, notes)
               VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, coalesce($8, now()), $9, $10) RETURNING id""",
            m.account_id, body.tenant_id, body.lease_id, body.target_invoice_id, body.method, body.amount,
            body.external_reference, body.paid_at, m.user.id, body.notes)
    return await _payment(payment_id, m.account_id)


@router.get("/accounts/{account_id}/payments/{payment_id}")
async def get_payment(payment_id: UUID, m: AnyMember):
    return await _payment(payment_id, m.account_id)


@router.post("/accounts/{account_id}/payments/{payment_id}/assign")
async def assign_payment(payment_id: UUID, body: AssignPaymentIn, m: Finance, ip: IpDep):
    """Match an M-Pesa payment whose account number could not be recognised."""
    async with db.tx(user_id=m.user.id, client_ip=ip) as conn:
        updated = await conn.fetchval(
            """UPDATE payments SET tenant_id = $3, lease_id = $4
               WHERE id = $1 AND account_id = $2 AND tenant_id IS NULL AND status = 'completed' RETURNING id""",
            payment_id, m.account_id, body.tenant_id, body.lease_id)
        if updated is None:
            raise HTTPException(409, "Only unmatched payments can be assigned")
    return await _payment(payment_id, m.account_id)


@router.post("/accounts/{account_id}/payments/{payment_id}/reverse")
async def reverse_payment(payment_id: UUID, body: VoidIn, m: Owner, ip: IpDep):
    async with db.tx(user_id=m.user.id, reason=body.reason, client_ip=ip) as conn:
        updated = await conn.fetchval(
            """UPDATE payments SET status = 'reversed', notes = coalesce(notes || E'\\n', '') || $3
               WHERE id = $1 AND account_id = $2 AND status = 'completed' RETURNING id""",
            payment_id, m.account_id, f"Reversed: {body.reason}")
        if updated is None:
            raise HTTPException(409, "Only completed payments can be reversed")
    return await _payment(payment_id, m.account_id)


@router.get("/accounts/{account_id}/receipts/{receipt_id}")
async def get_receipt(receipt_id: UUID, m: AnyMember):
    """Receipt details. Download the printable version from .../receipts/{receipt_id}/pdf."""
    return or_404(await load_receipt(receipt_id, account_id=m.account_id), "Receipt")


@router.post("/accounts/{account_id}/billing/run")
async def run_billing_now(m: Owner):
    """Manually trigger the billing engine (it also runs daily by itself)."""
    async with db.tx(user_id=m.user.id) as conn:
        return await conn.fetchval("SELECT fn_run_billing()")


# ------------------------------------------------------------------ reports (JSON)
@router.get("/accounts/{account_id}/reports/defaulters")
async def report_defaulters(m: Finance, property_id: UUID | None = None):
    return as_dicts(await db.fetch(
        """SELECT * FROM v_defaulters WHERE account_id = $1 AND ($2::uuid IS NULL OR property_id = $2)
           ORDER BY amount_overdue DESC""", m.account_id, property_id))


@router.get("/accounts/{account_id}/reports/monthly-revenue")
async def report_monthly_revenue(m: Finance, month_from: date | None = None, month_to: date | None = None,
                                 property_id: UUID | None = None):
    return as_dicts(await db.fetch(
        """SELECT * FROM v_monthly_revenue
           WHERE account_id = $1 AND ($2::date IS NULL OR month >= date_trunc('month', $2::timestamp)::date)
             AND ($3::date IS NULL OR month <= $3) AND ($4::uuid IS NULL OR property_id = $4)
           ORDER BY month DESC, property_name NULLS LAST""", m.account_id, month_from, month_to, property_id))


@router.get("/accounts/{account_id}/reports/maintenance-overhead")
async def report_maintenance(m: Finance, month_from: date | None = None, month_to: date | None = None):
    return as_dicts(await db.fetch(
        """SELECT * FROM v_maintenance_overhead
           WHERE account_id = $1 AND ($2::date IS NULL OR month >= date_trunc('month', $2::timestamp)::date)
             AND ($3::date IS NULL OR month <= $3)
           ORDER BY month DESC, total_cost DESC""", m.account_id, month_from, month_to))


@router.get("/accounts/{account_id}/reports/occupancy")
async def report_occupancy(m: AnyMember):
    return as_dicts(await db.fetch("SELECT * FROM v_property_occupancy WHERE account_id = $1 ORDER BY property_name",
                                   m.account_id))


@router.get("/accounts/{account_id}/reports/unit-financials")
async def report_unit_financials(m: Finance, property_id: UUID | None = None):
    return as_dicts(await db.fetch(
        """SELECT * FROM v_unit_financials WHERE account_id = $1 AND ($2::uuid IS NULL OR property_id = $2)
           ORDER BY outstanding_balance DESC, unit_number""", m.account_id, property_id))


# ------------------------------------------------------------------ tenant self-service
@router.get("/me/invoices")
async def my_invoices(user: UserDep, open_only: bool = False):
    rows = await db.fetch(
        f"""SELECT {INVOICE_COLUMNS} FROM {INVOICE_FROM}
            WHERE t.user_id = $1 AND i.status NOT IN ('draft', 'void')
              AND (NOT $2 OR i.status IN ('issued', 'partially_paid', 'overdue'))
            ORDER BY i.due_date DESC""", user.id, open_only)
    return as_dicts(rows)


@router.get("/me/invoices/{invoice_id}")
async def my_invoice(invoice_id: UUID, user: UserDep):
    return await _invoice_detail(invoice_id, tenant_user=user.id)


@router.get("/me/payments")
async def my_payments(user: UserDep):
    rows = await db.fetch(
        f"""SELECT {PAYMENT_COLUMNS} FROM {PAYMENT_FROM}
            WHERE t.user_id = $1 AND pm.status = 'completed' ORDER BY pm.paid_at DESC""", user.id)
    return as_dicts(rows)


@router.get("/me/statement")
async def my_statement(user: UserDep, date_from: date | None = None, date_to: date | None = None):
    rows = await db.fetch(
        """SELECT l.account_id, a.business_name, l.entry_date, l.entry_type, l.reference, l.description,
                  l.debit, l.credit, l.running_balance
           FROM v_tenant_ledger l JOIN tenants t ON t.id = l.tenant_id JOIN accounts a ON a.id = l.account_id
           WHERE t.user_id = $1 AND ($2::date IS NULL OR l.entry_date >= $2) AND ($3::date IS NULL OR l.entry_date <= $3)
           ORDER BY l.account_id, l.entry_date, l.entry_ts, l.entry_type""", user.id, date_from, date_to)
    return as_dicts(rows)
