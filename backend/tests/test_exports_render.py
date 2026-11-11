"""Renderer tests that need no database."""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from app.services.exports import Column, Report, _latin1, render_csv, render_receipt_pdf, render_report_pdf

HEADER = {"business_name": "Wanjirũ Properties", "kra_pin": "P051234567X", "contact_phone": "254712345678",
          "contact_email": "info@example.co.ke", "county": "Nairobi"}


def _report(rows):
    return Report("Defaulters List", [
        Column("tenant_name", "Tenant"), Column("amount", "Overdue (KES)", "money", total=True),
        Column("due", "Oldest due", "date"),
    ], rows, ["As at today"])


def test_latin1_transliterates_names_and_punctuation():
    assert _latin1("Wanjirũ – “Kĩambu”") == 'Wanjiru - "Kiambu"'
    assert _latin1("Plain ASCII") == "Plain ASCII"


def test_report_pdf_handles_many_rows_unicode_and_empty():
    rows = [{"tenant_name": f"Muthonĩ {i}", "amount": Decimal("1500.50"), "due": date(2026, 1, 5)} for i in range(120)]
    pdf = render_report_pdf(_report(rows), HEADER)
    assert pdf.startswith(b"%PDF-") and pdf.count(b"/Type /Page\n") >= 3   # repeats headings across pages
    assert render_report_pdf(_report([]), HEADER).startswith(b"%PDF-")


def test_csv_is_excel_friendly_and_machine_readable():
    rows = [{"tenant_name": "Achieng', \"Jr\"", "amount": Decimal("20000"), "due": date(2026, 2, 1)}]
    text = render_csv(_report(rows)).decode("utf-8")
    assert text.startswith("﻿Tenant,Overdue (KES),Oldest due")
    assert '"Achieng\', ""Jr""",20000.00,2026-02-01' in text


def test_receipt_pdf():
    receipt = {"receipt_number": "RCT-2026-000001", "paid_at": datetime(2026, 3, 1, 9, 30, tzinfo=timezone.utc),
               "tenant_name": "Jane Wambũi", "tenant_phone": "254798765432", "unit_number": "A1",
               "property_name": "Sunrise Apartments", "method": "mpesa_stk", "mpesa_receipt_number": "TKA1B2C3D4",
               "amount": Decimal("20000"), "credit_carried_forward": Decimal("500"),
               "allocations": [{"invoice_number": "INV-2026-000001", "period_start": date(2026, 3, 1),
                                "period_end": date(2026, 3, 31), "amount": Decimal("19500")}]}
    assert render_receipt_pdf(receipt, HEADER).startswith(b"%PDF-")
