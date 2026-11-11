-- =============================================================================
--  End-to-end smoke test for the Phase 1 schema. Runs inside a transaction and
--  ROLLS BACK, so it is safe against a dev database.
--  Run: psql -d kodi -v ON_ERROR_STOP=1 -f database/tests/smoke_test.sql
-- =============================================================================
BEGIN;

DO $$
DECLARE
    v_landlord   uuid;
    v_tenant_usr uuid;
    v_stranger   uuid;
    v_account    uuid;
    v_property   uuid;
    v_unit       uuid;
    v_tenant     uuid;
    v_lease      uuid;
    v_contractor uuid;
    v_issue      uuid;
    v_conv       uuid;
    v_call       uuid;
    v_p1         uuid;
    v_p2         uuid;
    v_cb         bigint;
    v_payment    uuid;
    v_stk_body   jsonb;
    v_run        jsonb;
BEGIN
    -- ---------------------------------------------------------------- setup
    INSERT INTO users (full_name, phone, email, password_hash)
    VALUES ('Test Landlord', '254712345678', 'landlord@example.com', 'x') RETURNING id INTO v_landlord;
    INSERT INTO users (full_name, phone, password_hash)
    VALUES ('Jane Wanjiku', '254798765432', 'x') RETURNING id INTO v_tenant_usr;
    INSERT INTO users (full_name, phone, password_hash)
    VALUES ('Stranger', '254700000001', 'x') RETURNING id INTO v_stranger;

    PERFORM set_config('app.current_user_id', v_landlord::text, true);

    INSERT INTO accounts (business_name, contact_phone, county_id, kra_pin)
    VALUES ('Sunrise Homes Ltd', '254712345678', 47, 'P051234567X') RETURNING id INTO v_account;
    INSERT INTO account_members (account_id, user_id, role) VALUES (v_account, v_landlord, 'owner');
    INSERT INTO account_mpesa_settings (account_id, shortcode_type, business_shortcode,
                                        consumer_key_enc, consumer_secret_enc, passkey_enc)
    VALUES (v_account, 'paybill', '174379', '\x00', '\x00', '\x00');

    INSERT INTO properties (account_id, name, property_type, county_id, sub_county_id, area,
                            landmark, latitude, longitude, amenities)
    VALUES (v_account, 'Sunrise Apartments', 'apartment_flats', 47,
            (SELECT id FROM sub_counties WHERE county_id = 47 AND name = 'Roysambu'),
            'Roysambu', 'Behind TRM mall', -1.218600, 36.888900, '{borehole,cctv}')
    RETURNING id INTO v_property;

    INSERT INTO units (account_id, property_id, unit_number, payment_code, unit_type,
                       bedrooms, monthly_rent, deposit_amount, status)
    VALUES (v_account, v_property, 'A1', 'sun-a1', 'one_bedroom', 1, 15000, 15000, 'cleaning')
    RETURNING id INTO v_unit;
    ASSERT (SELECT payment_code FROM units WHERE id = v_unit) = 'SUN-A1', 'payment_code not normalised';

    -- ------------------------------------------- vacancy engine + location search
    UPDATE units SET status = 'vacant' WHERE id = v_unit;
    ASSERT (SELECT is_listed_public FROM units WHERE id = v_unit), 'vacant unit not auto-listed';
    ASSERT EXISTS (SELECT 1 FROM notifications WHERE user_id = v_landlord AND type = 'unit_vacant'), 'no vacancy alert';
    ASSERT EXISTS (SELECT 1 FROM v_public_vacancies WHERE unit_id = v_unit AND county_name = 'Nairobi'), 'not in public view';
    ASSERT EXISTS (SELECT 1 FROM properties WHERE search_vector @@ plainto_tsquery('simple', 'TRM roysambu')), 'FTS failed';
    ASSERT EXISTS (SELECT 1 FROM properties WHERE area % 'Roysambo'), 'trigram typo search failed';

    -- ------------------------------------------------- tenant onboarding
    INSERT INTO tenants (account_id, user_id, first_name, last_name, id_document_number, phone)
    VALUES (v_account, v_tenant_usr, 'Jane', 'Wanjiku', '12345678', '254798765432') RETURNING id INTO v_tenant;
    INSERT INTO next_of_kin (tenant_id, full_name, relationship, phone, is_primary)
    VALUES (v_tenant, 'Peter Kamau', 'Brother', '254711111111', true);

    -- Allocation, back-dated 35 days to exercise catch-up billing.
    INSERT INTO leases (account_id, unit_id, tenant_id, start_date, status, terms_snapshot,
                        late_fee_type, late_fee_value)
    VALUES (v_account, v_unit, v_tenant, nairobi_today() - 35, 'pending_signature',
            'Standard residential tenancy terms v1', 'flat', 500)
    RETURNING id INTO v_lease;
    ASSERT (SELECT status FROM units WHERE id = v_unit) = 'reserved', 'unit not reserved';
    ASSERT (SELECT monthly_rent FROM leases WHERE id = v_lease) = 15000, 'rent not defaulted from unit';
    ASSERT (SELECT payment_due_days FROM leases WHERE id = v_lease) = 5, 'due days not defaulted';

    BEGIN
        INSERT INTO leases (account_id, unit_id, tenant_id, start_date, status)
        VALUES (v_account, v_unit, v_tenant, nairobi_today(), 'pending_signature');
        RAISE EXCEPTION 'double allocation was NOT blocked';
    EXCEPTION WHEN exclusion_violation THEN NULL;
    END;

    -- Tenant signs -> lease active -> unit occupied -> invoices generated.
    UPDATE leases SET signed_at = now(), signed_ip = '41.90.1.1' WHERE id = v_lease;
    ASSERT (SELECT status FROM leases WHERE id = v_lease) = 'active', 'signature did not activate lease';
    ASSERT (SELECT terms_sha256 FROM leases WHERE id = v_lease) IS NOT NULL, 'terms not hashed';
    ASSERT (SELECT status FROM units WHERE id = v_unit) = 'occupied', 'unit not occupied';
    ASSERT NOT (SELECT is_listed_public FROM units WHERE id = v_unit), 'occupied unit still listed';
    ASSERT (SELECT count(*) FROM invoices WHERE lease_id = v_lease) = 2, 'catch-up billing should create 2 invoices';
    ASSERT (SELECT next_billing_date FROM leases WHERE id = v_lease) = nairobi_today() + 25, 'next_billing_date wrong';

    SELECT id INTO v_p1 FROM invoices WHERE lease_id = v_lease ORDER BY period_start LIMIT 1;
    SELECT id INTO v_p2 FROM invoices WHERE lease_id = v_lease ORDER BY period_start DESC LIMIT 1;
    ASSERT (SELECT total_amount FROM invoices WHERE id = v_p1) = 30000, 'P1 should be rent + deposit';
    ASSERT (SELECT status FROM invoices WHERE id = v_p1) = 'overdue', 'P1 should be overdue';
    ASSERT (SELECT total_amount FROM invoices WHERE id = v_p2) = 15000, 'P2 should be rent only';

    SELECT id INTO v_conv FROM conversations WHERE tenant_id = v_tenant;
    ASSERT (SELECT count(*) FROM conversation_participants WHERE conversation_id = v_conv) = 2, 'chat not bootstrapped';

    -- Nightly run applies the late fee once.
    v_run := fn_run_billing();
    ASSERT (v_run ->> 'late_fees_applied')::int = 1, format('late fee not applied: %s', v_run);
    ASSERT (SELECT total_amount FROM invoices WHERE id = v_p1) = 30500, 'late fee not in total';
    v_run := fn_run_billing();
    ASSERT (v_run ->> 'late_fees_applied')::int = 0, 'late fee applied twice';

    -- --------------------------------------------- M-Pesa STK push round trip
    INSERT INTO mpesa_stk_requests (account_id, invoice_id, tenant_id, lease_id, initiated_by, phone, amount,
                                    account_reference, transaction_desc, merchant_request_id,
                                    checkout_request_id, status)
    VALUES (v_account, v_p1, v_tenant, v_lease, v_landlord, '254798765432', 20000,
            'SUN-A1', 'Rent', '29115-34620561-1', 'ws_CO_10112026143015', 'pending');

    BEGIN
        INSERT INTO mpesa_stk_requests (account_id, invoice_id, phone, amount, account_reference,
                                        transaction_desc, status)
        VALUES (v_account, v_p1, '254798765432', 100, 'SUN-A1', 'Rent', 'initiated');
        RAISE EXCEPTION 'concurrent STK for same invoice was NOT blocked';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    v_stk_body := '{"Body":{"stkCallback":{"MerchantRequestID":"29115-34620561-1",
        "CheckoutRequestID":"ws_CO_10112026143015","ResultCode":0,
        "ResultDesc":"The service request is processed successfully.",
        "CallbackMetadata":{"Item":[{"Name":"Amount","Value":20000},
        {"Name":"MpesaReceiptNumber","Value":"QJH7A89XYZ"},{"Name":"Balance"},
        {"Name":"TransactionDate","Value":20261110143015},
        {"Name":"PhoneNumber","Value":254798765432}]}}}}';

    INSERT INTO mpesa_callbacks (account_id, callback_type, payload)
    VALUES (v_account, 'stk_callback', v_stk_body) RETURNING id INTO v_cb;
    v_payment := fn_process_stk_callback(v_cb);
    ASSERT v_payment IS NOT NULL, 'STK callback did not create payment';
    ASSERT (SELECT paid_at FROM payments WHERE id = v_payment) = timestamptz '2026-11-10 14:30:15+03', 'TransactionDate not parsed as EAT';
    ASSERT (SELECT balance FROM invoices WHERE id = v_p1) = 10500, 'STK not allocated to target invoice';
    ASSERT (SELECT status FROM invoices WHERE id = v_p1) = 'overdue', 'part-paid past-due invoice must stay overdue';
    ASSERT EXISTS (SELECT 1 FROM receipts WHERE payment_id = v_payment AND receipt_number LIKE 'RCT-%'), 'no receipt';
    ASSERT (SELECT status FROM mpesa_stk_requests WHERE checkout_request_id = 'ws_CO_10112026143015') = 'success';

    -- Safaricom retries the same callback: must be a no-op.
    INSERT INTO mpesa_callbacks (account_id, callback_type, payload)
    VALUES (v_account, 'stk_callback', v_stk_body) RETURNING id INTO v_cb;
    ASSERT fn_process_stk_callback(v_cb) IS NULL, 'duplicate callback created a payment';
    ASSERT (SELECT count(*) FROM payments WHERE tenant_id = v_tenant) = 1, 'duplicate payment row';

    -- ------------------------------------- C2B Paybill with unit account number
    INSERT INTO mpesa_callbacks (callback_type, payload)
    VALUES ('c2b_confirmation', '{"TransactionType":"Pay Bill","TransID":"QJK1B2C3D4",
        "TransTime":"20261110150000","TransAmount":"30000.00","BusinessShortCode":"174379",
        "BillRefNumber":" sun-a1 ","MSISDN":"2547 ***** 432","FirstName":"JANE"}')
    RETURNING id INTO v_cb;
    v_payment := fn_process_c2b_confirmation(v_cb);
    ASSERT (SELECT tenant_id FROM payments WHERE id = v_payment) = v_tenant, 'C2B not matched by payment_code';
    ASSERT (SELECT status FROM invoices WHERE id = v_p1) = 'paid', 'P1 not paid';
    ASSERT (SELECT status FROM invoices WHERE id = v_p2) = 'paid', 'P2 not paid';
    ASSERT (SELECT unallocated_amount FROM payments WHERE id = v_payment) = 4500, 'overpayment credit wrong';

    -- Unmatched C2B is still recorded and staff alerted.
    INSERT INTO mpesa_callbacks (callback_type, payload)
    VALUES ('c2b_confirmation', '{"TransID":"QJK9Z9Z9Z9","TransTime":"20261110160000",
        "TransAmount":"1000","BusinessShortCode":"174379","BillRefNumber":"WRONG"}')
    RETURNING id INTO v_cb;
    v_payment := fn_process_c2b_confirmation(v_cb);
    ASSERT (SELECT tenant_id FROM payments WHERE id = v_payment) IS NULL, 'unmatched payment wrongly matched';
    ASSERT EXISTS (SELECT 1 FROM notifications WHERE type = 'payment_unmatched'), 'no unmatched alert';

    -- Next cycle (simulated 30 days ahead) consumes the KES 4,500 credit.
    v_run := fn_run_billing(nairobi_today() + 30);
    ASSERT (v_run ->> 'invoices_created')::int = 1, format('expected 1 new invoice: %s', v_run);
    ASSERT (SELECT balance FROM invoices WHERE lease_id = v_lease ORDER BY period_start DESC LIMIT 1) = 10500,
        'credit not applied to new invoice';
    v_run := fn_run_billing(nairobi_today() + 30);
    ASSERT (v_run ->> 'invoices_created')::int = 0, 'billing is not idempotent';

    ASSERT (SELECT running_balance FROM v_tenant_ledger WHERE tenant_id = v_tenant
             ORDER BY entry_date DESC, entry_ts DESC, entry_type DESC LIMIT 1) = 10500, 'ledger balance wrong';
    ASSERT (SELECT outstanding_balance FROM v_unit_financials WHERE unit_id = v_unit) = 10500, 'unit financials wrong';

    -- ------------------------------------------- issue -> contractor -> expense
    PERFORM set_config('app.current_user_id', v_tenant_usr::text, true);
    INSERT INTO issues (account_id, unit_id, category, priority, title, description)
    VALUES (v_account, v_unit, 'plumbing', 'high', 'Kitchen sink leaking', 'Water pooling under the sink')
    RETURNING id INTO v_issue;
    ASSERT (SELECT tenant_id FROM issues WHERE id = v_issue) = v_tenant, 'issue tenant not derived';
    ASSERT EXISTS (SELECT 1 FROM notifications WHERE user_id = v_landlord AND type = 'issue_created'), 'landlord not alerted';

    PERFORM set_config('app.current_user_id', v_landlord::text, true);
    INSERT INTO contractors (account_id, name, phone, specialties)
    VALUES (v_account, 'Otieno Plumbing', '254722222222', '{plumbing}') RETURNING id INTO v_contractor;
    PERFORM set_config('app.change_reason', 'Plumber arriving 2pm', true);
    UPDATE issues SET status = 'dispatched_contractor', assigned_contractor_id = v_contractor WHERE id = v_issue;
    PERFORM set_config('app.change_reason', '', true);
    ASSERT (SELECT dispatched_at FROM issues WHERE id = v_issue) IS NOT NULL;
    ASSERT EXISTS (SELECT 1 FROM notifications WHERE user_id = v_tenant_usr AND type = 'issue_updated'
                   AND body = 'Plumber arriving 2pm'), 'tenant not told about dispatch';
    UPDATE issues SET status = 'resolved', actual_cost = 2500 WHERE id = v_issue;
    ASSERT (SELECT amount FROM maintenance_expenses WHERE issue_id = v_issue) = 2500, 'expense not auto-created';
    ASSERT (SELECT count(*) FROM issue_updates WHERE issue_id = v_issue) = 3, 'issue timeline incomplete';
    ASSERT EXISTS (SELECT 1 FROM v_maintenance_overhead WHERE property_id = v_property AND total_cost = 2500);

    -- ------------------------------------------------------- chat + calls
    INSERT INTO messages (conversation_id, sender_id, body, client_message_id)
    VALUES (v_conv, v_tenant_usr, 'Thanks, the sink is fixed!', '6f1c1a8e-0000-4000-8000-000000000001');
    ASSERT (SELECT last_message_preview FROM conversations WHERE id = v_conv) = 'Thanks, the sink is fixed!';
    BEGIN
        INSERT INTO messages (conversation_id, sender_id, body) VALUES (v_conv, v_stranger, 'hi');
        RAISE EXCEPTION 'non-participant was able to post';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    INSERT INTO call_sessions (conversation_id, caller_id, callee_id, call_type, issue_id)
    VALUES (v_conv, v_tenant_usr, v_landlord, 'video', v_issue) RETURNING id INTO v_call;
    UPDATE call_sessions SET status = 'missed' WHERE id = v_call;
    ASSERT EXISTS (SELECT 1 FROM messages WHERE call_id = v_call AND message_type = 'call_log'), 'no call log';
    ASSERT EXISTS (SELECT 1 FROM notifications WHERE user_id = v_landlord AND type = 'missed_call'), 'no missed-call alert';

    -- --------------------------------------------- move-out -> turnover
    UPDATE leases SET status = 'terminated', termination_reason = 'Relocating' WHERE id = v_lease;
    ASSERT (SELECT status FROM units WHERE id = v_unit) = 'cleaning', 'unit not in cleaning after move-out';
    UPDATE units SET status = 'vacant' WHERE id = v_unit;
    ASSERT (SELECT is_listed_public FROM units WHERE id = v_unit), 'unit not re-listed';

    -- ------------------------------------------------------ reports & audit
    ASSERT EXISTS (SELECT 1 FROM v_monthly_revenue WHERE account_id = v_account AND collected > 0);
    ASSERT EXISTS (SELECT 1 FROM v_property_occupancy WHERE property_id = v_property AND total_units = 1);
    ASSERT EXISTS (SELECT 1 FROM audit_logs WHERE entity_type = 'leases' AND actor_id = v_landlord), 'audit missing';
    ASSERT (SELECT count(*) FROM unit_status_history WHERE unit_id = v_unit) >= 5, 'status history incomplete';

    RAISE NOTICE 'ALL SMOKE TESTS PASSED';
END $$;

ROLLBACK;
