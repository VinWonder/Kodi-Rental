"""End-to-end: landlord onboarding -> unit -> tenant invite -> allocation ->
signature -> billing -> M-Pesa STK + C2B -> issue -> chat -> WebRTC call ->
reports -> move-out. Runs against the real schema and triggers."""
from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import datetime

import asyncpg

from app.utils import EAT
from conftest import PNG_BYTES, TEST_DSN, wait_for, ws_connect

WEBM_BYTES = b"\x1a\x45\xdf\xa3" + b"\x00" * 512


def _sql(query: str, *args):
    async def run():
        conn = await asyncpg.connect(TEST_DSN)
        try:
            return await conn.execute(query, *args)
        finally:
            await conn.close()
    return asyncio.run(run())


def h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def is_notification(kind: str):
    return lambda m: m["type"] == "notification" and m["notification"]["type"] == kind


def is_event(name: str, **data):
    return lambda m: (m["type"] == "event" and m["event"] == name
                      and all(m["data"].get(k) == v for k, v in data.items()))


def test_full_rental_lifecycle(client, fake_daraja):
    now = datetime.now(EAT)
    today = now.date().isoformat()
    mpesa_time = now.strftime("%Y%m%d%H%M%S")

    # ------------------------------------------------------------ landlord onboarding
    r = client.post("/api/v1/auth/register",
                    json={"full_name": "Grace Akinyi", "phone": "0712 345 678", "password": "S3cure-pass!"})
    assert r.status_code == 201, r.text
    assert r.json()["user"]["phone"] == "254712345678"
    L = r.json()["access_token"]

    r = client.post("/api/v1/accounts", json={"business_name": "Akinyi Homes", "county_id": 47}, headers=h(L))
    assert r.status_code == 201, r.text
    account_id = r.json()["id"]
    A = f"/api/v1/accounts/{account_id}"

    r = client.put(f"{A}/mpesa", headers=h(L), json={
        "shortcode_type": "paybill", "business_shortcode": "174379", "consumer_key": "ck_test_1234567",
        "consumer_secret": "cs_test_1234567", "passkey": "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"})
    assert r.status_code == 200, r.text
    stk_url = r.json()["stk_callback_url"]
    assert stk_url.startswith("https://api.example.test/hooks/")
    assert "mpesa" not in r.json()["c2b_confirmation_url"].lower()
    hook_token = stk_url.split("/hooks/")[1].split("/")[0]
    assert client.post(f"{A}/mpesa/register-c2b", headers=h(L)).status_code == 200

    # ------------------------------------------------------------ property, unit, gallery
    subs = client.get("/api/v1/locations/counties/47/sub-counties").json()
    roysambu = next(s["id"] for s in subs if s["name"] == "Roysambu")
    r = client.post(f"{A}/properties", headers=h(L), json={
        "name": "Sunrise Apartments", "property_type": "apartment_flats", "county_id": 47,
        "sub_county_id": roysambu, "area": "Roysambu", "landmark": "Behind TRM",
        "latitude": -1.2186, "longitude": 36.8889, "amenities": ["Borehole", "CCTV"]})
    assert r.status_code == 201, r.text
    property_id = r.json()["id"]
    assert r.json()["amenities"] == ["borehole", "cctv"]

    r = client.post(f"{A}/properties/{property_id}/units", headers=h(L), json={
        "unit_number": "A1", "unit_type": "one_bedroom", "monthly_rent": 15000, "deposit_amount": 15000,
        "status": "cleaning"})
    assert r.status_code == 201, r.text
    unit_id = r.json()["id"]
    assert r.json()["payment_code"] == "SUNR-A1"

    r = client.post(f"{A}/units/{unit_id}/media", headers=h(L),
                    files=[("files", ("front.png", PNG_BYTES, "image/png"))])
    assert r.status_code == 201, r.text
    assert r.json()[0]["is_cover"] is True
    r = client.post(f"{A}/units/{unit_id}/media", headers=h(L),
                    files=[("files", ("evil.png", b"<?php system($_GET['c']); ?>", "image/png"))])
    assert r.status_code == 415, "spoofed image must be rejected"

    # Vacancy engine: vacant -> listed publicly -> searchable by typo'd estate + distance.
    r = client.post(f"{A}/units/{unit_id}/status", headers=h(L), json={"status": "vacant", "reason": "Cleaned"})
    assert r.status_code == 200 and r.json()["is_listed_public"] is True
    r = client.get("/api/v1/public/vacancies",
                   params={"county_id": 47, "q": "roysambo", "lat": -1.22, "lng": 36.89, "sort": "nearest"})
    assert r.status_code == 200, r.text
    listing = r.json()[0]
    assert listing["unit_id"] == unit_id and listing["distance_km"] < 1
    assert client.get(listing["cover_url"]).status_code == 200
    assert listing["photos"][0] == listing["cover_url"] and len(listing["photos"]) <= 5
    assert client.get(f"/api/v1/public/vacancies/{unit_id}").json()["landlord_name"] == "Akinyi Homes"

    # ------------------------------------------------------------ tenant onboarding via invite
    r = client.post(f"{A}/tenants", headers=h(L), json={
        "first_name": "Jane", "last_name": "Wanjiku", "id_document_number": "12345678",
        "phone": "+254 798 765 432",
        "next_of_kin": [{"full_name": "Peter Kamau", "relationship": "Brother", "phone": "0711111111"}]})
    assert r.status_code == 201, r.text
    tenant_id = r.json()["id"]
    assert r.json()["next_of_kin"][0]["is_primary"] is True
    assert client.get(f"{A}/tenants", params={"q": "Wanjiku"}, headers=h(L)).json()[0]["id"] == tenant_id

    r = client.post(f"{A}/tenants/{tenant_id}/invite", headers=h(L))
    assert r.status_code == 201, r.text
    invite_token = r.json()["invite_url"].split("token=")[1]
    r = client.post("/api/v1/auth/accept-invite", json={"token": invite_token, "password": "Tenant-pass-1"})
    assert r.status_code == 200, r.text
    T = r.json()["access_token"]
    assert client.post("/api/v1/auth/accept-invite",
                       json={"token": invite_token, "password": "Tenant-pass-1"}).status_code == 400

    landlord_ws, lsock, _ = ws_connect(client, L)
    tenant_ws, tsock, tready = ws_connect(client, T)
    assert any("turn:" in url for s in tready["ice_servers"] for url in s["urls"])

    # ------------------------------------------------------------ allocation + signature
    terms = "Standard residential tenancy agreement. Rent is payable monthly via M-Pesa Paybill."
    lease_body = {"unit_id": unit_id, "tenant_id": tenant_id, "start_date": today, "terms_snapshot": terms}
    r = client.post(f"{A}/leases", headers=h(L), json=lease_body)
    assert r.status_code == 201, r.text
    lease_id = r.json()["id"]
    assert r.json()["status"] == "pending_signature"
    wait_for(tsock, lambda m: m["type"] == "notification"
             and m["notification"]["title"] == "Your lease is ready to sign")

    r = client.post(f"{A}/leases", headers=h(L), json=lease_body)
    assert r.status_code == 409 and "live allocation" in r.json()["detail"]

    lease = client.get(f"/api/v1/me/leases/{lease_id}", headers=h(T)).json()
    terms_hash = hashlib.sha256(lease["terms_snapshot"].encode()).hexdigest()
    r = client.post("/api/v1/media", headers=h(T), data={"purpose": "signature", "account_id": account_id},
                    files={"file": ("signature.png", PNG_BYTES, "image/png")})
    assert r.status_code == 201, r.text
    signature_id = r.json()["id"]

    r = client.post(f"/api/v1/me/leases/{lease_id}/sign", headers=h(T),
                    json={"accept_terms": True, "terms_sha256": "0" * 64, "signature_media_id": signature_id})
    assert r.status_code == 409, "a hash mismatch means the tenant saw different terms"
    r = client.post(f"/api/v1/me/leases/{lease_id}/sign", headers=h(T),
                    json={"accept_terms": True, "terms_sha256": terms_hash, "signature_media_id": signature_id})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"
    wait_for(lsock, is_event("lease_status_changed", to="active"))

    invoices = client.get("/api/v1/me/invoices", headers=h(T)).json()
    assert len(invoices) == 1 and invoices[0]["total_amount"] == 30000  # rent + deposit
    invoice_id = invoices[0]["id"]
    assert client.get(f"{A}/units/{unit_id}", headers=h(L)).json()["status"] == "occupied"

    # ------------------------------------------------------------ M-Pesa STK push
    r = client.post(f"{A}/invoices/{invoice_id}/stk-push", headers=h(L), json={"amount": 20000})
    assert r.status_code == 202, r.text
    stk = r.json()
    assert stk["status"] == "pending"
    push = fake_daraja.pushes[-1]
    assert (push["phone"], push["amount"], push["account_reference"], push["callback_url"]) == \
           ("254798765432", 20000, "SUNR-A1", stk_url)
    r = client.post(f"{A}/invoices/{invoice_id}/stk-push", headers=h(L), json={})
    assert r.status_code == 409, "second prompt while one is pending must be refused"

    callback = {"Body": {"stkCallback": {
        "MerchantRequestID": stk["merchant_request_id"], "CheckoutRequestID": stk["checkout_request_id"],
        "ResultCode": 0, "ResultDesc": "The service request is processed successfully.",
        "CallbackMetadata": {"Item": [
            {"Name": "Amount", "Value": 20000}, {"Name": "MpesaReceiptNumber", "Value": "TKA1B2C3D4"},
            {"Name": "TransactionDate", "Value": int(mpesa_time)}, {"Name": "PhoneNumber", "Value": 254798765432}]}}}}
    hook_path = stk_url.replace("https://api.example.test", "")
    for _ in range(2):  # Safaricom retries: second delivery must be harmless
        r = client.post(hook_path, json=callback)
        assert r.status_code == 200 and r.json() == {"ResultCode": 0, "ResultDesc": "Accepted"}

    wait_for(tsock, is_notification("payment_received"))
    wait_for(lsock, is_event("invoice_status_changed", to="partially_paid"))
    invoice = client.get(f"{A}/invoices/{invoice_id}", headers=h(L)).json()
    assert invoice["balance"] == 10000 and len(invoice["payments"]) == 1
    assert invoice["payments"][0]["receipt_number"].startswith("RCT-")
    assert client.get(f"/api/v1/me/stk-requests/{stk['id']}", headers=h(T)).json()["status"] == "success"

    # ------------------------------------------------------------ M-Pesa C2B (Paybill, typed account no.)
    r = client.post(f"/hooks/{hook_token}/c2b/validate", json={"TransID": "TKB2C3D4E5", "BillRefNumber": "nope"})
    assert r.json()["ResultCode"] == "0"
    r = client.post(f"/hooks/{hook_token}/c2b/confirm", json={
        "TransactionType": "Pay Bill", "TransID": "TKB2C3D4E5", "TransTime": mpesa_time, "TransAmount": "10000.00",
        "BusinessShortCode": "174379", "BillRefNumber": " sunr-a1 ", "MSISDN": "2547 ***** 432", "FirstName": "JANE"})
    assert r.status_code == 200
    assert client.get(f"{A}/invoices/{invoice_id}", headers=h(L)).json()["status"] == "paid"
    assert client.post("/hooks/not-a-real-token/stk", json=callback).status_code == 404
    statement = client.get("/api/v1/me/statement", headers=h(T)).json()
    assert statement[-1]["running_balance"] == 0

    # ------------------------------------------------------------ issue -> contractor -> expense
    r = client.post("/api/v1/media", headers=h(T), data={"purpose": "issue_attachment", "account_id": account_id},
                    files={"file": ("leak.png", PNG_BYTES, "image/png")})
    attachment_id = r.json()["id"]
    r = client.post("/api/v1/me/issues", headers=h(T), json={
        "category": "plumbing", "priority": "high", "title": "Kitchen sink leaking",
        "description": "Water pooling under the sink", "attachment_media_ids": [attachment_id]})
    assert r.status_code == 201, r.text
    issue_id = r.json()["id"]
    assert r.json()["ticket_number"].startswith("TKT-") and len(r.json()["attachments"]) == 1
    wait_for(lsock, is_notification("issue_created"))
    assert client.get(f"/api/v1/media/{attachment_id}", headers=h(L)).status_code == 200

    r = client.post(f"{A}/contractors", headers=h(L),
                    json={"name": "Otieno Plumbing", "phone": "0722222222", "specialties": ["plumbing"]})
    contractor_id = r.json()["id"]
    r = client.patch(f"{A}/issues/{issue_id}", headers=h(L), json={
        "status": "dispatched_contractor", "assigned_contractor_id": contractor_id, "comment": "Plumber arriving 2pm"})
    assert r.status_code == 200, r.text
    note = wait_for(tsock, is_notification("issue_updated"))
    assert note["notification"]["body"] == "Plumber arriving 2pm"
    r = client.patch(f"{A}/issues/{issue_id}", headers=h(L), json={"status": "resolved", "actual_cost": 2500})
    assert r.json()["resolved_at"] is not None
    assert client.get(f"{A}/expenses", headers=h(L)).json()[0]["amount"] == 2500
    r = client.post(f"/api/v1/me/issues/{issue_id}/rate", headers=h(T), json={"rating": 5, "feedback": "Fast!"})
    assert r.json()["status"] == "closed"

    # ------------------------------------------------------------ chat over WebSocket
    conversation_id = client.get("/api/v1/conversations", headers=h(T)).json()[0]["id"]
    client_message_id = str(uuid.uuid4())
    tsock.send_json({"type": "chat.send", "ref": "c1", "conversation_id": conversation_id,
                     "body": "Thanks, the sink is fixed!", "client_message_id": client_message_id})
    ack = wait_for(tsock, lambda m: m["type"] == "chat.ack")
    assert ack["ref"] == "c1"
    message_id = ack["message"]["id"]
    got = wait_for(lsock, lambda m: m["type"] == "chat.message")
    assert got["message"]["body"] == "Thanks, the sink is fixed!"

    r = client.post(f"/api/v1/conversations/{conversation_id}/messages", headers=h(T),
                    json={"body": "Thanks, the sink is fixed!", "client_message_id": client_message_id})
    assert r.json()["id"] == message_id, "offline-queue retry must not duplicate"
    landlord_inbox = client.get("/api/v1/conversations", headers=h(L)).json()
    assert landlord_inbox[0]["unread_count"] == 1
    lsock.send_json({"type": "chat.read", "conversation_id": conversation_id, "last_read_message_id": message_id})
    wait_for(tsock, lambda m: m["type"] == "chat.read")

    r = client.post("/api/v1/media", headers=h(T),
                    data={"purpose": "chat_attachment", "account_id": account_id, "duration_ms": "4200"},
                    files={"file": ("note.webm", WEBM_BYTES, "audio/webm;codecs=opus")})
    assert r.status_code == 201, r.text
    r = client.post(f"/api/v1/conversations/{conversation_id}/messages", headers=h(T),
                    json={"message_type": "audio_note", "media_id": r.json()["id"]})
    assert r.json()["media_mime_type"] == "audio/webm" and r.json()["media_duration_ms"] == 4200

    # ------------------------------------------------------------ WebRTC video call signalling
    tsock.send_json({"type": "call.invite", "ref": "k1", "conversation_id": conversation_id,
                     "call_type": "video", "issue_id": issue_id})
    created = wait_for(tsock, lambda m: m["type"] == "call.created")
    call_id = created["call"]["id"]
    assert created["callee_online"] is True
    incoming = wait_for(lsock, lambda m: m["type"] == "call.incoming")
    assert incoming["caller_name"] == "Jane Wanjiku" and incoming["call"]["call_type"] == "video"

    offer = {"type": "offer", "sdp": "v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\n"}
    tsock.send_json({"type": "rtc.offer", "call_id": call_id, "sdp": offer})
    assert wait_for(lsock, lambda m: m["type"] == "rtc.offer")["sdp"] == offer
    lsock.send_json({"type": "call.accept", "call_id": call_id})
    wait_for(tsock, lambda m: m["type"] == "call.accepted")
    lsock.send_json({"type": "rtc.answer", "call_id": call_id, "sdp": {"type": "answer", "sdp": "v=0"}})
    wait_for(tsock, lambda m: m["type"] == "rtc.answer")
    candidate = {"candidate": "candidate:1 1 udp 2122260223 10.0.0.2 54400 typ relay", "sdpMid": "0",
                 "sdpMLineIndex": 0}
    tsock.send_json({"type": "rtc.ice", "call_id": call_id, "candidate": candidate})
    assert wait_for(lsock, lambda m: m["type"] == "rtc.ice")["candidate"] == candidate
    tsock.send_json({"type": "call.stats", "call_id": call_id, "ice_candidate_type": "relay"})
    lsock.send_json({"type": "call.end", "call_id": call_id})
    ended = wait_for(tsock, lambda m: m["type"] == "call.ended")
    assert ended["call"]["status"] == "ended"
    log_msg = wait_for(lsock, lambda m: m["type"] == "chat.message" and m["message"]["message_type"] == "call_log")
    assert log_msg["message"]["body"].startswith("Video call")
    history = client.get(f"/api/v1/conversations/{conversation_id}/calls", headers=h(L)).json()
    assert history[0]["status"] == "ended" and history[0]["issue_id"] == issue_id

    # ------------------------------------------------------------ reports & dashboard
    dash = client.get(f"{A}/dashboard", headers=h(L)).json()
    assert dash["occupancy"]["occupied"] == 1 and dash["occupancy"]["occupancy_rate_pct"] == 100
    assert dash["this_month"]["collected"] == 30000
    for report in ("defaulters", "monthly-revenue", "maintenance-overhead", "occupancy", "unit-financials"):
        assert client.get(f"{A}/reports/{report}", headers=h(L)).status_code == 200, report
    assert client.get(f"{A}/tenants/{tenant_id}/statement", headers=h(L)).json()[-1]["running_balance"] == 0

    # ------------------------------------------------------------ verified tenant reviews
    R = f"/api/v1/me/reviews/{property_id}"
    r = client.put(R, headers=h(T), json={"rating": 5, "comment": "Great water supply"})
    assert r.status_code == 403 and "30 days" in r.json()["detail"], "too soon after moving in"
    assert client.put(R, headers=h(L), json={"rating": 1}).status_code == 403, "only tenants who rented here"
    homes = client.get("/api/v1/me/reviews", headers=h(T)).json()
    assert homes[0]["property_id"] == property_id and homes[0]["eligible"] is False
    _sql("UPDATE leases SET activated_at = now() - interval '45 days' WHERE id = $1::uuid", lease_id)
    assert client.put(R, headers=h(T), json={"rating": 6}).status_code == 422
    r = client.put(R, headers=h(T), json={"rating": 4, "comment": "  Great water supply  "})
    assert r.status_code == 200 and r.json()["comment"] == "Great water supply", r.text
    r = client.put(R, headers=h(T), json={"rating": 5, "comment": "Great water, quiet caretaker-free building"})
    review_id = r.json()["id"]
    wait_for(lsock, is_notification("system"))
    mine = client.get(f"{A}/reviews", headers=h(L)).json()
    assert len(mine) == 1 and mine[0]["rating"] == 5 and mine[0]["author"] == "Jane W."
    r = client.post(f"{A}/reviews/{review_id}/reply", headers=h(L), json={"reply": "Thank you, Jane!"})
    assert r.status_code == 200, r.text
    public = client.get(f"/api/v1/public/properties/{property_id}/reviews").json()
    assert (public["count"], public["average"], public["distribution"]["5"]) == (1, 5.0, 1)
    shown = public["reviews"][0]
    assert shown["author"] == "Jane W." and shown["current_tenant"] is True
    assert shown["landlord_reply"] == "Thank you, Jane!" and "Wanjiku" not in str(public)
    assert client.get("/api/v1/me/reviews", headers=h(T)).json()[0]["landlord_reply"] == "Thank you, Jane!"

    # ------------------------------------------------------------ downloadable receipts & statements
    receipt_id = client.get("/api/v1/me/payments", headers=h(T)).json()[0]["receipt_id"]
    r = client.get(f"/api/v1/me/receipts/{receipt_id}/pdf", headers=h(T))
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf" and r.content.startswith(b"%PDF-")
    assert client.get(f"/api/v1/me/receipts/{receipt_id}", headers=h(T)).json()["pdf_url"]
    assert client.get(f"{A}/receipts/{receipt_id}/pdf", headers=h(L)).content == r.content  # rendered once
    assert client.get(f"{A}/receipts/{receipt_id}", headers=h(L)).json()["allocations"]

    for report in ("monthly_revenue", "defaulters", "maintenance_overhead", "occupancy"):
        for fmt in ("pdf", "csv"):
            r = client.post(f"{A}/reports/exports", headers=h(L), json={"report_type": report, "format": fmt})
            assert r.status_code == 201 and r.json()["status"] == "ready", r.text
            body = client.get(r.json()["url"], headers=h(L)).content
            assert body.startswith(b"%PDF-" if fmt == "pdf" else b"\xef\xbb\xbf"), (report, fmt)
    r = client.post(f"{A}/reports/exports", headers=h(L),
                    json={"report_type": "tenant_statement", "format": "csv", "tenant_id": tenant_id})
    assert r.status_code == 201, r.text
    export = r.json()
    csv_text = client.get(f"{A}/reports/exports/{export['id']}/download", headers=h(L)).content.decode("utf-8-sig")
    assert csv_text.splitlines()[0] == "Date,Reference,Description,Charged,Paid,Balance"
    assert csv_text.strip().splitlines()[-1].endswith(",0.00")
    assert client.post(f"{A}/reports/exports", headers=h(L),
                       json={"report_type": "tenant_statement"}).status_code == 422
    assert client.post(f"{A}/reports/exports", headers=h(L),
                       json={"report_type": "occupancy", "property_id": str(uuid.uuid4())}).status_code == 404
    assert len(client.get(f"{A}/reports/exports", headers=h(L)).json()) == 9
    # Tenants cannot see or create landlord exports.
    assert client.get(export["url"], headers=h(T)).status_code == 404
    assert client.post(f"{A}/reports/exports", headers=h(T), json={"report_type": "occupancy"}).status_code == 404
    r = client.get("/api/v1/me/statement/export?format=pdf", headers=h(T))
    assert r.status_code == 200 and r.content.startswith(b"%PDF-")
    assert "my-statement" in r.headers["content-disposition"]

    # ------------------------------------------------------------ move-out
    r = client.post(f"{A}/leases/{lease_id}/terminate", headers=h(L), json={"reason": "Relocating to Kisumu"})
    assert r.status_code == 200 and r.json()["status"] == "terminated"
    assert client.get(f"{A}/units/{unit_id}", headers=h(L)).json()["status"] == "cleaning"
    history = client.get(f"{A}/units/{unit_id}/history", headers=h(L)).json()
    assert [row["to_status"] for row in history][:2] == ["cleaning", "occupied"]

    tenant_ws.__exit__(None, None, None)
    landlord_ws.__exit__(None, None, None)
