"""Financial statement exports (PDF + CSV) and receipt PDFs.

Reports read the same SQL views as the JSON endpoints, so a downloaded file
always matches what the dashboard shows. Rendering is CPU-bound, so it runs in
a worker thread. PDFs use fpdf2's built-in Helvetica (no font files to ship);
text outside Latin-1 is transliterated or replaced.
"""
from __future__ import annotations

import csv
import io
import logging
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

import anyio
import asyncpg
from fastapi import HTTPException
from fpdf import FPDF, FontFace
from fpdf.enums import TableCellFillMode

from ..db import as_dicts, db
from ..utils import EAT
from .storage import MediaStorage

log = logging.getLogger("kodi.exports")

ReportType = Literal["monthly_revenue", "defaulters", "maintenance_overhead", "tenant_statement", "occupancy"]
ExportFormat = Literal["pdf", "csv"]
Kind = Literal["text", "money", "int", "pct", "date", "datetime", "month"]

BRAND = (13, 110, 253)       # Bootstrap primary, matches the PWA theme
MUTED = (108, 117, 125)
ZEBRA = (244, 247, 252)


@dataclass(frozen=True, slots=True)
class Column:
    key: str
    header: str
    kind: Kind = "text"
    width: float = 1.0        # relative width in the PDF table
    total: bool = False       # sum this column in the PDF footer row


@dataclass(slots=True)
class Report:
    title: str
    columns: list[Column]
    rows: list[dict[str, Any]]
    subtitle_lines: list[str] = field(default_factory=list)
    landscape: bool = True


@dataclass(frozen=True, slots=True)
class ReportParams:
    date_from: date | None = None
    date_to: date | None = None
    property_id: UUID | None = None
    tenant_id: UUID | None = None

    def as_json(self) -> dict[str, str]:
        return {k: str(v) for k, v in (("date_from", self.date_from), ("date_to", self.date_to),
                                       ("property_id", self.property_id), ("tenant_id", self.tenant_id)) if v}


# --------------------------------------------------------------------------- formatting
def _money(value: Any) -> str:
    return f"{Decimal(value or 0):,.2f}"


def _fmt(value: Any, kind: Kind) -> str:
    if value is None:
        return ""
    if kind == "money":
        return _money(value)
    if kind == "pct":
        return f"{Decimal(value):.1f}%"
    if kind == "int":
        return f"{int(value):,}"
    if kind == "month":
        return value.strftime("%b %Y")
    if kind == "date":
        return value.strftime("%d %b %Y")
    if kind == "datetime":
        return value.astimezone(EAT).strftime("%d %b %Y %H:%M")
    return str(value).replace("_", " ") if isinstance(value, str) and value.islower() else str(value)


def _csv_value(value: Any, kind: Kind) -> Any:
    """CSV keeps raw, machine-readable values (no thousands separators)."""
    if value is None:
        return ""
    if kind in ("date", "month"):
        return value.isoformat()
    if kind == "datetime":
        return value.astimezone(EAT).isoformat(timespec="seconds")
    if kind == "money":
        return f"{Decimal(value):.2f}"
    return value


_PUNCTUATION = str.maketrans({"–": "-", "—": "-", "‘": "'", "’": "'", "“": '"',
                              "”": '"', "…": "...", " ": " ", "•": "-"})


def _latin1(text: str) -> str:
    """Core PDF fonts are Latin-1 only: map smart punctuation, strip accents
    where possible, and replace whatever is left."""
    text = text.translate(_PUNCTUATION)
    try:
        text.encode("latin-1")
        return text
    except UnicodeEncodeError:
        decomposed = unicodedata.normalize("NFKD", text)
        return "".join(ch if ord(ch) < 256 else ("" if unicodedata.combining(ch) else "?") for ch in decomposed)


# --------------------------------------------------------------------------- data
async def _account_header(account_id: UUID) -> dict[str, Any]:
    row = await db.fetchrow(
        """SELECT a.business_name, a.kra_pin, a.contact_phone, a.contact_email, c.name AS county
           FROM accounts a LEFT JOIN counties c ON c.id = a.county_id WHERE a.id = $1""", account_id)
    if row is None:
        raise HTTPException(404, "Account not found")
    return dict(row)


def _period_line(p: ReportParams) -> str | None:
    if p.date_from and p.date_to:
        return f"Period: {p.date_from:%d %b %Y} to {p.date_to:%d %b %Y}"
    if p.date_from:
        return f"From {p.date_from:%d %b %Y}"
    if p.date_to:
        return f"Up to {p.date_to:%d %b %Y}"
    return None


async def _property_line(account_id: UUID, property_id: UUID | None) -> str | None:
    if property_id is None:
        return None
    name = await db.fetchval("SELECT name FROM properties WHERE id = $1 AND account_id = $2", property_id, account_id)
    if name is None:
        raise HTTPException(404, "Property not found")
    return f"Property: {name}"


async def build_report(account_id: UUID, report_type: ReportType, p: ReportParams) -> Report:
    lines = [line for line in (_period_line(p), await _property_line(account_id, p.property_id)) if line]

    if report_type == "monthly_revenue":
        rows = await db.fetch(
            """SELECT month, coalesce(property_name, 'Unmatched payments') AS property_name, invoiced, collected,
                      mpesa_collected, payment_count, maintenance_cost, net_operating_income, collection_rate_pct
               FROM v_monthly_revenue
               WHERE account_id = $1 AND ($2::date IS NULL OR month >= date_trunc('month', $2::timestamp)::date)
                 AND ($3::date IS NULL OR month <= $3) AND ($4::uuid IS NULL OR property_id = $4)
               ORDER BY month DESC, property_name NULLS LAST""",
            account_id, p.date_from, p.date_to, p.property_id)
        return Report("Monthly Revenue Statement", [
            Column("month", "Month", "month", 0.9),
            Column("property_name", "Property", "text", 1.8),
            Column("invoiced", "Invoiced (KES)", "money", 1.2, total=True),
            Column("collected", "Collected (KES)", "money", 1.2, total=True),
            Column("mpesa_collected", "Via M-Pesa (KES)", "money", 1.2, total=True),
            Column("payment_count", "Payments", "int", 0.8, total=True),
            Column("maintenance_cost", "Maintenance (KES)", "money", 1.2, total=True),
            Column("net_operating_income", "Net income (KES)", "money", 1.2, total=True),
            Column("collection_rate_pct", "Collected %", "pct", 0.9),
        ], as_dicts(rows), lines)

    if report_type == "defaulters":
        rows = await db.fetch(
            """SELECT tenant_name, tenant_phone, property_name, unit_number, overdue_invoices, amount_overdue,
                      oldest_due_date, max_days_overdue, aging_bucket, last_payment_at
               FROM v_defaulters WHERE account_id = $1 AND ($2::uuid IS NULL OR property_id = $2)
               ORDER BY amount_overdue DESC""", account_id, p.property_id)
        rows = as_dicts(rows)
        lines.append(f"As at {datetime.now(EAT):%d %b %Y} - {len(rows)} tenant(s) in arrears")
        return Report("Defaulters List", [
            Column("tenant_name", "Tenant", "text", 1.6),
            Column("tenant_phone", "Phone", "text", 1.1),
            Column("property_name", "Property", "text", 1.5),
            Column("unit_number", "Unit", "text", 0.6),
            Column("overdue_invoices", "Invoices", "int", 0.7, total=True),
            Column("amount_overdue", "Overdue (KES)", "money", 1.1, total=True),
            Column("oldest_due_date", "Oldest due", "date", 1.0),
            Column("max_days_overdue", "Days", "int", 0.5),
            Column("aging_bucket", "Aging", "text", 0.6),
            Column("last_payment_at", "Last payment", "datetime", 1.2),
        ], rows, lines)

    if report_type == "maintenance_overhead":
        rows = await db.fetch(
            """SELECT month, property_name, category, expense_count, linked_issues, total_cost
               FROM v_maintenance_overhead
               WHERE account_id = $1 AND ($2::date IS NULL OR month >= date_trunc('month', $2::timestamp)::date)
                 AND ($3::date IS NULL OR month <= $3) AND ($4::uuid IS NULL OR property_id = $4)
               ORDER BY month DESC, total_cost DESC""", account_id, p.date_from, p.date_to, p.property_id)
        return Report("Maintenance Overhead", [
            Column("month", "Month", "month", 0.9),
            Column("property_name", "Property", "text", 1.8),
            Column("category", "Category", "text", 1.2),
            Column("expense_count", "Expenses", "int", 0.8, total=True),
            Column("linked_issues", "Tickets", "int", 0.8, total=True),
            Column("total_cost", "Cost (KES)", "money", 1.2, total=True),
        ], as_dicts(rows), lines, landscape=False)

    if report_type == "occupancy":
        rows = await db.fetch(
            """SELECT property_name, area, total_units, occupied, vacant, under_maintenance, cleaning,
                      occupancy_rate_pct, actual_rent_roll, potential_rent_roll
               FROM v_property_occupancy WHERE account_id = $1 AND ($2::uuid IS NULL OR property_id = $2)
               ORDER BY property_name""", account_id, p.property_id)
        lines.append(f"As at {datetime.now(EAT):%d %b %Y}")
        return Report("Occupancy & Rent Roll", [
            Column("property_name", "Property", "text", 1.8),
            Column("area", "Area", "text", 1.1),
            Column("total_units", "Units", "int", 0.6, total=True),
            Column("occupied", "Occupied", "int", 0.7, total=True),
            Column("vacant", "Vacant", "int", 0.6, total=True),
            Column("under_maintenance", "Repairs", "int", 0.7, total=True),
            Column("cleaning", "Cleaning", "int", 0.7, total=True),
            Column("occupancy_rate_pct", "Occupied %", "pct", 0.8),
            Column("actual_rent_roll", "Rent roll (KES)", "money", 1.2, total=True),
            Column("potential_rent_roll", "Potential (KES)", "money", 1.2, total=True),
        ], as_dicts(rows), lines)

    if report_type == "tenant_statement":
        if p.tenant_id is None:
            raise HTTPException(422, "tenant_id is required for a tenant statement")
        tenant = await db.fetchrow(
            """SELECT t.full_name, t.phone, u.unit_number, pr.name AS property_name
               FROM tenants t
               LEFT JOIN LATERAL (SELECT unit_id FROM leases WHERE tenant_id = t.id
                                  ORDER BY (status IN ('active', 'notice_given')) DESC, start_date DESC LIMIT 1) l ON true
               LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN properties pr ON pr.id = u.property_id
               WHERE t.id = $1 AND t.account_id = $2""", p.tenant_id, account_id)
        if tenant is None:
            raise HTTPException(404, "Tenant not found")
        rows = as_dicts(await db.fetch(
            """SELECT entry_date, reference, description, debit, credit, running_balance
               FROM v_tenant_ledger
               WHERE account_id = $1 AND tenant_id = $2
                 AND ($3::date IS NULL OR entry_date >= $3) AND ($4::date IS NULL OR entry_date <= $4)
               ORDER BY entry_date, entry_ts, entry_type""", account_id, p.tenant_id, p.date_from, p.date_to))
        unit = f" - {tenant['property_name']}, unit {tenant['unit_number']}" if tenant["unit_number"] else ""
        lines.insert(0, f"Tenant: {tenant['full_name']} (+{tenant['phone']}){unit}")
        closing = rows[-1]["running_balance"] if rows else Decimal(0)
        label = "Balance due" if closing > 0 else ("Credit in your favour" if closing < 0 else "Balance")
        lines.append(f"{label}: KES {_money(abs(closing))}")
        return Report("Tenant Statement", [
            Column("entry_date", "Date", "date", 0.9),
            Column("reference", "Reference", "text", 1.1),
            Column("description", "Description", "text", 2.8),
            Column("debit", "Charged", "money", 1.0, total=True),
            Column("credit", "Paid", "money", 1.0, total=True),
            Column("running_balance", "Balance", "money", 1.0),
        ], rows, lines, landscape=False)

    raise HTTPException(422, f"Unknown report type '{report_type}'")


# --------------------------------------------------------------------------- renderers
def render_csv(report: Report) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([c.header for c in report.columns])
    for row in report.rows:
        writer.writerow([_csv_value(row.get(c.key), c.kind) for c in report.columns])
    # UTF-8 BOM so Excel opens names with accents correctly.
    return ("﻿" + buffer.getvalue()).encode("utf-8")


class _KodiPDF(FPDF):
    footer_text = ""

    def footer(self) -> None:
        self.set_y(-12)
        self.set_font("Helvetica", size=7)
        self.set_text_color(*MUTED)
        self.cell(0, 5, _latin1(self.footer_text), align="L")
        self.set_x(self.l_margin)
        self.cell(0, 5, f"Page {self.page_no()} of {{nb}}", align="R")


def _new_pdf(landscape: bool, header: dict[str, Any]) -> _KodiPDF:
    pdf = _KodiPDF(orientation="L" if landscape else "P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=16)
    pdf.set_margins(12, 12, 12)
    pdf.footer_text = (f"{header['business_name']} - generated {datetime.now(EAT):%d %b %Y %H:%M} EAT by Kodi Rentals")
    pdf.set_title(header["business_name"])
    pdf.set_creator("Kodi Rentals")
    pdf.add_page()
    return pdf


def _letterhead(pdf: _KodiPDF, header: dict[str, Any], title: str) -> None:
    pdf.set_font("Helvetica", "B", 15)
    pdf.set_text_color(*BRAND)
    pdf.cell(0, 8, _latin1(header["business_name"]), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", size=8)
    pdf.set_text_color(*MUTED)
    contact = [f"Tel +{header['contact_phone']}"]
    if header.get("contact_email"):
        contact.append(str(header["contact_email"]))
    if header.get("county"):
        contact.append(f"{header['county']} County")
    if header.get("kra_pin"):
        contact.append(f"KRA PIN {header['kra_pin']}")
    pdf.cell(0, 4.5, _latin1("  |  ".join(contact)), new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(*BRAND)
    pdf.set_line_width(0.6)
    pdf.line(pdf.l_margin, pdf.get_y() + 2, pdf.w - pdf.r_margin, pdf.get_y() + 2)
    pdf.ln(5)
    pdf.set_font("Helvetica", "B", 13)
    pdf.set_text_color(33, 37, 41)
    pdf.cell(0, 7, _latin1(title), new_x="LMARGIN", new_y="NEXT")


def render_report_pdf(report: Report, header: dict[str, Any]) -> bytes:
    pdf = _new_pdf(report.landscape, header)
    _letterhead(pdf, header, report.title)
    pdf.set_font("Helvetica", size=9)
    pdf.set_text_color(*MUTED)
    for line in report.subtitle_lines:
        pdf.cell(0, 5, _latin1(line), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    if not report.rows:
        pdf.set_font("Helvetica", "I", 10)
        pdf.cell(0, 10, "No records for the selected filters.", new_x="LMARGIN", new_y="NEXT")
        return bytes(pdf.output())

    numeric = {"money", "int", "pct"}
    align = tuple("RIGHT" if c.kind in numeric else "LEFT" for c in report.columns)
    pdf.set_font("Helvetica", size=8)
    pdf.set_text_color(33, 37, 41)
    pdf.set_draw_color(222, 226, 230)
    pdf.set_line_width(0.2)
    with pdf.table(
        col_widths=tuple(c.width for c in report.columns),
        text_align=align,
        headings_style=FontFace(emphasis="BOLD", color=(255, 255, 255), fill_color=BRAND),
        cell_fill_color=ZEBRA,
        cell_fill_mode=TableCellFillMode.ROWS,
        line_height=5.5,
        padding=1.2,
        repeat_headings=1,
    ) as table:
        heading = table.row()
        for c in report.columns:
            heading.cell(_latin1(c.header))
        for row in report.rows:
            line = table.row()
            for c in report.columns:
                line.cell(_latin1(_fmt(row.get(c.key), c.kind)))
        if any(c.total for c in report.columns):
            totals = table.row(style=FontFace(emphasis="BOLD", fill_color=(233, 236, 239)))
            for i, c in enumerate(report.columns):
                if c.total:
                    total = sum((Decimal(r.get(c.key) or 0) for r in report.rows), Decimal(0))
                    totals.cell(_fmt(total, c.kind))
                else:
                    totals.cell("TOTAL" if i == 0 else "")
    return bytes(pdf.output())


def render_receipt_pdf(receipt: dict[str, Any], header: dict[str, Any]) -> bytes:
    pdf = _new_pdf(False, header)
    _letterhead(pdf, header, "OFFICIAL RECEIPT")

    def pair(label: str, value: Any) -> None:
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*MUTED)
        pdf.cell(45, 6.5, _latin1(label))
        pdf.set_font("Helvetica", size=10)
        pdf.set_text_color(33, 37, 41)
        pdf.cell(0, 6.5, _latin1(str(value)), new_x="LMARGIN", new_y="NEXT")

    pdf.ln(2)
    pair("Receipt number", receipt["receipt_number"])
    pair("Date paid", _fmt(receipt["paid_at"], "datetime") + " EAT")
    pair("Received from", receipt.get("tenant_name") or receipt.get("payer_name") or "-")
    if receipt.get("tenant_phone"):
        pair("Phone", f"+{receipt['tenant_phone']}")
    if receipt.get("unit_number"):
        pair("Premises", f"{receipt['property_name']}, unit {receipt['unit_number']}")
    pair("Payment method", {"mpesa_stk": "M-Pesa (STK prompt)", "mpesa_c2b": "M-Pesa Paybill / Till"}
         .get(receipt["method"], str(receipt["method"]).replace("_", " ").title()))
    if receipt.get("mpesa_receipt_number"):
        pair("M-Pesa code", receipt["mpesa_receipt_number"])
    elif receipt.get("external_reference"):
        pair("Reference", receipt["external_reference"])

    pdf.ln(4)
    pdf.set_fill_color(*BRAND)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 12, f"  AMOUNT RECEIVED:  KES {_money(receipt['amount'])}", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.set_fill_color(255, 255, 255)
    pdf.ln(5)

    allocations = receipt.get("allocations") or []
    if allocations:
        pdf.set_text_color(33, 37, 41)
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(0, 6, "Applied to", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", size=9)
        pdf.set_draw_color(222, 226, 230)
        with pdf.table(col_widths=(1.2, 2.2, 1.0), text_align=("LEFT", "LEFT", "RIGHT"), line_height=6,
                       headings_style=FontFace(emphasis="BOLD", fill_color=(233, 236, 239)), padding=1.2) as table:
            head = table.row()
            for text in ("Invoice", "Rent period", "Amount (KES)"):
                head.cell(text)
            for a in allocations:
                line = table.row()
                line.cell(_latin1(a["invoice_number"]))
                line.cell(f"{a['period_start']:%d %b %Y} - {a['period_end']:%d %b %Y}")
                line.cell(_money(a["amount"]))
    credit = Decimal(receipt.get("credit_carried_forward") or 0)
    if credit > 0:
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(25, 135, 84)
        pdf.cell(0, 6, f"KES {_money(credit)} held as credit towards your next invoice.", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(10)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(*MUTED)
    pdf.multi_cell(0, 4.5, "This receipt was generated automatically when the payment was confirmed. "
                           "Verify the M-Pesa code against the SMS from Safaricom. Thank you for paying on time.")
    return bytes(pdf.output())


# --------------------------------------------------------------------------- receipts
async def load_receipt(receipt_id: UUID, *, account_id: UUID | None = None,
                       tenant_user_id: UUID | None = None) -> dict[str, Any] | None:
    """Receipt with everything needed to print it. Scoped to an account
    (staff) or to the tenant's own login."""
    row = await db.fetchrow(
        """SELECT r.id, r.account_id, r.receipt_number, r.issued_at, r.pdf_media_id, a.business_name, a.kra_pin,
                  a.contact_phone, pm.id AS payment_id, pm.amount, pm.method, pm.mpesa_receipt_number,
                  pm.external_reference, pm.payer_name, pm.paid_at, pm.unallocated_amount AS credit_carried_forward,
                  t.full_name AS tenant_name, t.phone AS tenant_phone, u.unit_number, p.name AS property_name
           FROM receipts r JOIN payments pm ON pm.id = r.payment_id JOIN accounts a ON a.id = r.account_id
           LEFT JOIN tenants t ON t.id = pm.tenant_id LEFT JOIN leases l ON l.id = pm.lease_id
           LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN properties p ON p.id = u.property_id
           WHERE r.id = $1 AND ($2::uuid IS NULL OR r.account_id = $2) AND ($3::uuid IS NULL OR t.user_id = $3)""",
        receipt_id, account_id, tenant_user_id)
    if row is None:
        return None
    receipt = dict(row)
    receipt["allocations"] = as_dicts(await db.fetch(
        """SELECT i.invoice_number, i.period_start, i.period_end, pa.amount FROM payment_allocations pa
           JOIN invoices i ON i.id = pa.invoice_id WHERE pa.payment_id = $1 ORDER BY i.period_start""",
        receipt["payment_id"]))
    receipt["pdf_url"] = f"/api/v1/media/{receipt['pdf_media_id']}" if receipt["pdf_media_id"] else None
    return receipt


async def ensure_receipt_pdf(storage: MediaStorage, receipt_id: UUID) -> dict[str, Any]:
    """Return the receipt's PDF media row, rendering and storing it first if
    needed. A row lock makes concurrent requests render it only once."""
    async with db.tx(reason="receipt pdf") as conn:
        locked = await conn.fetchrow(
            "SELECT account_id, pdf_media_id FROM receipts WHERE id = $1 FOR UPDATE", receipt_id)
        if locked is None:
            raise HTTPException(404, "Receipt not found")
        if locked["pdf_media_id"] is not None:
            existing = await conn.fetchrow(
                "SELECT id, storage_key, mime_type, original_filename FROM media_files WHERE id = $1 AND deleted_at IS NULL",
                locked["pdf_media_id"])
            if existing is not None and storage.path_for(existing["storage_key"]).exists():
                return dict(existing)

        receipt = await load_receipt(receipt_id)
        header = await _account_header(locked["account_id"])
        data = await anyio.to_thread.run_sync(render_receipt_pdf, receipt, header)
        media = await storage.save_bytes(
            conn, data, purpose="receipt_pdf", account_id=locked["account_id"], uploaded_by=None,
            filename=f"{receipt['receipt_number']}.pdf", mime="application/pdf", extension=".pdf")
        try:
            await conn.execute("UPDATE receipts SET pdf_media_id = $2 WHERE id = $1", receipt_id, media["id"])
        except BaseException:
            storage.delete_file(media["storage_key"])
            raise
        return media


async def render_pending_receipts(storage: MediaStorage, limit: int = 25) -> int:
    """Background pre-rendering so receipts are ready (and cacheable offline)
    before anyone opens them."""
    ids = await db.fetch("SELECT id FROM receipts WHERE pdf_media_id IS NULL ORDER BY issued_at LIMIT $1", limit)
    done = 0
    for row in ids:
        try:
            await ensure_receipt_pdf(storage, row["id"])
            done += 1
        except Exception:  # noqa: BLE001 - one bad receipt must not block the rest
            log.exception("Could not render receipt %s", row["id"])
    return done


# --------------------------------------------------------------------------- report exports
EXPORT_COLUMNS = """e.id, e.report_type, e.format, e.parameters, e.status, e.error, e.requested_at, e.completed_at,
                    e.media_id, mf.original_filename AS filename, mf.size_bytes,
                    CASE WHEN e.media_id IS NOT NULL THEN '/api/v1/media/' || e.media_id END AS url"""


async def render_report_file(account_id: UUID, report_type: ReportType, fmt: ExportFormat,
                             params: ReportParams) -> tuple[bytes, str, str]:
    """Build a report and return (bytes, filename, mime) without storing it."""
    report = await build_report(account_id, report_type, params)
    stamp = datetime.now(EAT).strftime("%Y%m%d-%H%M")
    filename = f"{report_type.replace('_', '-')}-{stamp}.{fmt}"
    if fmt == "csv":
        return render_csv(report), filename, "text/csv"
    header = await _account_header(account_id)
    data = await anyio.to_thread.run_sync(render_report_pdf, report, header)
    return data, filename, "application/pdf"


async def create_export(storage: MediaStorage, *, account_id: UUID, user_id: UUID, report_type: ReportType,
                        fmt: ExportFormat, params: ReportParams) -> dict[str, Any]:
    """Generate a report file now and record it in report_exports. Failures
    are recorded too, so the export history shows what went wrong."""
    # Validate filters up front so bad requests do not leave failed rows behind.
    await _property_line(account_id, params.property_id)
    if report_type == "tenant_statement":
        if params.tenant_id is None:
            raise HTTPException(422, "tenant_id is required for a tenant statement")
        if not await db.fetchval("SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1 AND account_id = $2)",
                                 params.tenant_id, account_id):
            raise HTTPException(404, "Tenant not found")

    export_id = await db.fetchval(
        """INSERT INTO report_exports (account_id, requested_by, report_type, format, parameters, status)
           VALUES ($1, $2, $3, $4, $5, 'processing') RETURNING id""",
        account_id, user_id, report_type, fmt, params.as_json())
    try:
        data, filename, mime = await render_report_file(account_id, report_type, fmt, params)
        async with db.tx(user_id=user_id, reason="report export") as conn:
            media = await storage.save_bytes(conn, data, purpose="report_export", account_id=account_id,
                                             uploaded_by=user_id, filename=filename, mime=mime, extension=f".{fmt}")
            try:
                await conn.execute(
                    """UPDATE report_exports SET status = 'ready', media_id = $2, completed_at = now()
                       WHERE id = $1""", export_id, media["id"])
            except BaseException:
                storage.delete_file(media["storage_key"])
                raise
    except Exception as exc:
        log.exception("Report export %s failed", export_id)
        await db.execute(
            "UPDATE report_exports SET status = 'failed', error = $2, completed_at = now() WHERE id = $1",
            export_id, str(getattr(exc, "detail", exc))[:500])
        if isinstance(exc, (HTTPException, asyncpg.PostgresError)):
            raise
        raise HTTPException(500, "Could not generate the report. Please try again.") from exc
    return await get_export(account_id, export_id)


async def get_export(account_id: UUID, export_id: UUID) -> dict[str, Any] | None:
    row = await db.fetchrow(
        f"""SELECT {EXPORT_COLUMNS} FROM report_exports e LEFT JOIN media_files mf ON mf.id = e.media_id
            WHERE e.id = $1 AND e.account_id = $2""", export_id, account_id)
    return dict(row) if row else None
