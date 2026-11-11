-- =============================================================================
--  KODI RENTAL PWA  ·  PHASE 1  ·  PostgreSQL relational schema
-- -----------------------------------------------------------------------------
--  Target   : PostgreSQL 15+ (verified on 18)
--  Run      : psql -U postgres -d kodi -v ON_ERROR_STOP=1 -f database/schema.sql
--             psql -U postgres -d kodi -v ON_ERROR_STOP=1 -f database/seeds/001_kenya_locations.sql
--  Timezone : All business dates are computed in Africa/Nairobi (EAT, UTC+3).
--             Timestamps are stored as timestamptz (UTC on disk).
--
--  Conventions
--    * uuid PKs for business entities (safe to expose in URLs / offline sync),
--      bigint identity for high-volume append-only logs (messages, history).
--    * Every tenant-scoped table carries account_id. Composite FKs
--      (x_id, account_id) make cross-account references physically impossible.
--    * Money is numeric(14,2) in KES. Never float.
--    * The API sets per-transaction context so triggers can attribute changes:
--          SET LOCAL app.current_user_id = '<uuid>';
--          SET LOCAL app.change_reason   = 'Tenant moved out';   -- optional
--          SET LOCAL app.client_ip       = '41.90.12.7';         -- optional
--    * Real-time fan-out: triggers publish JSON on the single LISTEN channel
--      'kodi_events'; the FastAPI WebSocket gateway relays them to browsers.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. EXTENSIONS
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_bytes() for secrets
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy search: estates, names, typos
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- uuid equality inside EXCLUDE constraints

-- -----------------------------------------------------------------------------
-- 1. ENUMERATED TYPES
-- -----------------------------------------------------------------------------
CREATE TYPE account_member_role AS ENUM ('owner', 'manager', 'accountant', 'viewer');

CREATE TYPE property_type AS ENUM (
    'apartment_flats', 'storey_building', 'hostel', 'commercial_plaza',
    'bungalow', 'maisonette', 'mixed_use', 'other'
);

CREATE TYPE unit_type AS ENUM (
    'single_room', 'bedsitter', 'studio', 'one_bedroom', 'two_bedroom',
    'three_bedroom', 'four_plus_bedroom', 'shared_hostel_room', 'shared_hostel_bed',
    'shop', 'office', 'warehouse', 'other'
);

CREATE TYPE unit_status AS ENUM (
    'vacant', 'reserved', 'occupied', 'under_maintenance', 'cleaning', 'inactive'
);

CREATE TYPE id_document_type AS ENUM ('national_id', 'passport', 'alien_id', 'military_id');

CREATE TYPE lease_status AS ENUM (
    'draft', 'pending_signature', 'active', 'notice_given', 'terminated', 'expired'
);

CREATE TYPE billing_cycle AS ENUM ('every_30_days', 'fixed_monthly_day');
CREATE TYPE late_fee_type AS ENUM ('none', 'flat', 'percent');

CREATE TYPE invoice_status AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void');

CREATE TYPE invoice_item_type AS ENUM (
    'rent', 'deposit', 'water', 'electricity', 'garbage', 'service_charge', 'late_fee', 'other'
);

CREATE TYPE payment_method AS ENUM (
    'mpesa_stk', 'mpesa_c2b', 'bank_transfer', 'cash', 'cheque', 'adjustment'
);
CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed', 'reversed');

CREATE TYPE mpesa_environment    AS ENUM ('sandbox', 'production');
CREATE TYPE mpesa_shortcode_type AS ENUM ('paybill', 'till');
CREATE TYPE stk_status AS ENUM ('initiated', 'pending', 'success', 'failed', 'cancelled', 'timeout');
CREATE TYPE mpesa_callback_type AS ENUM (
    'stk_callback', 'c2b_validation', 'c2b_confirmation', 'transaction_status', 'reversal'
);

CREATE TYPE issue_category AS ENUM (
    'plumbing', 'electrical', 'structural', 'security', 'pest_control',
    'appliance', 'sanitation', 'internet', 'other'
);
CREATE TYPE issue_priority AS ENUM ('low', 'medium', 'high', 'emergency');
CREATE TYPE issue_status AS ENUM (
    'received', 'under_review', 'dispatched_contractor', 'in_progress',
    'resolved', 'closed', 'rejected'
);

CREATE TYPE message_type AS ENUM ('text', 'image', 'video', 'audio_note', 'file', 'system', 'call_log');
CREATE TYPE call_type    AS ENUM ('audio', 'video');
CREATE TYPE call_status  AS ENUM ('ringing', 'ongoing', 'ended', 'missed', 'rejected', 'failed');

CREATE TYPE media_purpose AS ENUM (
    'avatar', 'unit_gallery', 'unit_condition', 'tenant_id_document', 'lease_document',
    'signature', 'issue_attachment', 'chat_attachment', 'receipt_pdf',
    'report_export', 'expense_receipt'
);

CREATE TYPE notification_type AS ENUM (
    'unit_vacant', 'lease_activated', 'invoice_issued', 'invoice_overdue',
    'payment_received', 'payment_unmatched', 'issue_created', 'issue_updated',
    'new_message', 'missed_call', 'report_ready', 'system'
);

CREATE TYPE report_type   AS ENUM ('monthly_revenue', 'defaulters', 'maintenance_overhead', 'tenant_statement', 'occupancy');
CREATE TYPE export_format AS ENUM ('pdf', 'csv');
CREATE TYPE export_status AS ENUM ('queued', 'processing', 'ready', 'failed');

-- -----------------------------------------------------------------------------
-- 2. DOMAINS (validated value types reused across tables)
-- -----------------------------------------------------------------------------
-- Safaricom/Airtel MSISDN normalised to 2547XXXXXXXX / 2541XXXXXXXX (Daraja format).
CREATE DOMAIN ke_msisdn AS varchar(12)
    CONSTRAINT ke_msisdn_format CHECK (VALUE ~ '^254(7|1)[0-9]{8}$');

CREATE DOMAIN money_kes AS numeric(14,2)
    CONSTRAINT money_kes_non_negative CHECK (VALUE >= 0);

-- M-Pesa transaction codes are 10 uppercase alphanumerics (e.g. QJH7A89XYZ);
-- 8-12 tolerated for sandbox/legacy codes.
CREATE DOMAIN mpesa_receipt AS varchar(12)
    CONSTRAINT mpesa_receipt_format CHECK (VALUE ~ '^[A-Z0-9]{8,12}$');

CREATE DOMAIN kra_pin AS varchar(11)
    CONSTRAINT kra_pin_format CHECK (VALUE ~ '^[AP][0-9]{9}[A-Z]$');

-- -----------------------------------------------------------------------------
-- 3. CONTEXT HELPERS (no table dependencies)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

CREATE FUNCTION nairobi_today() RETURNS date
LANGUAGE sql STABLE AS $$
    SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date
$$;

-- Next occurrence of day-of-month p_day strictly after p_from (p_day is 1..28).
CREATE FUNCTION fn_next_billing_day(p_from date, p_day integer) RETURNS date
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE WHEN c > p_from THEN c ELSE (c + interval '1 month')::date END
    FROM (SELECT date_trunc('month', p_from::timestamp)::date + (p_day - 1) AS c) s
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- =============================================================================
-- 4. REFERENCE DATA: KENYAN ADMINISTRATIVE GEOGRAPHY
-- =============================================================================
CREATE TABLE counties (
    id      smallint    PRIMARY KEY CHECK (id BETWEEN 1 AND 47),  -- official county code
    name    varchar(40) NOT NULL UNIQUE,
    region  varchar(20) NOT NULL                                  -- former province, for regional rollups
);

CREATE TABLE sub_counties (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    county_id  smallint    NOT NULL REFERENCES counties(id),
    name       varchar(80) NOT NULL,
    UNIQUE (county_id, name),
    UNIQUE (id, county_id)                 -- target for composite FK from properties
);
CREATE INDEX ix_sub_counties_name_trgm ON sub_counties USING gin (name gin_trgm_ops);

-- =============================================================================
-- 5. IDENTITY, ACCESS & LANDLORD ACCOUNTS
-- =============================================================================
CREATE TABLE users (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name          varchar(120) NOT NULL,
    phone              ke_msisdn    NOT NULL UNIQUE,      -- login identifier + OTP target
    email              citext       UNIQUE,
    password_hash      text         NOT NULL,             -- argon2id hash produced by the API
    avatar_media_id    uuid,                              -- FK added after media_files
    is_platform_admin  boolean      NOT NULL DEFAULT false,
    is_active          boolean      NOT NULL DEFAULT true,
    phone_verified_at  timestamptz,
    last_login_at      timestamptz,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE user_sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  char(64)    NOT NULL UNIQUE,      -- sha256 hex; raw token never stored
    user_agent          text,
    ip_address          inet,
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_user_sessions_active ON user_sessions (user_id, expires_at) WHERE revoked_at IS NULL;

-- Web Push (VAPID) subscriptions for the installed PWA.
CREATE TABLE push_subscriptions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint      text        NOT NULL UNIQUE,
    p256dh_key    text        NOT NULL,
    auth_secret   text        NOT NULL,
    user_agent    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);
CREATE INDEX ix_push_subscriptions_user ON push_subscriptions (user_id);

-- "Account" = the landlord's business (top of Account -> Property -> Unit).
CREATE TABLE accounts (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name             varchar(150) NOT NULL,
    kra_pin                   kra_pin,
    contact_phone             ke_msisdn    NOT NULL,
    contact_email             citext,
    county_id                 smallint     REFERENCES counties(id),
    default_payment_due_days  smallint     NOT NULL DEFAULT 5 CHECK (default_payment_due_days BETWEEN 0 AND 28),
    currency                  char(3)      NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
    is_active                 boolean      NOT NULL DEFAULT true,
    created_at                timestamptz  NOT NULL DEFAULT now(),
    updated_at                timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE account_members (
    account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    role        account_member_role NOT NULL DEFAULT 'manager',
    invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, user_id)
);
CREATE INDEX ix_account_members_user ON account_members (user_id);

-- Daraja credentials. Secrets are encrypted by the API (Fernet/AES-GCM) before
-- insert; the DB never sees plaintext. callback_token is embedded in the
-- callback URL path (/mpesa/callback/{token}) because Safaricom does not sign
-- callbacks — combine with Safaricom IP allow-listing at the edge.
CREATE TABLE account_mpesa_settings (
    account_id              uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    environment             mpesa_environment    NOT NULL DEFAULT 'sandbox',
    shortcode_type          mpesa_shortcode_type NOT NULL,
    business_shortcode      varchar(10)  NOT NULL CHECK (business_shortcode ~ '^[0-9]{5,7}$'),
    stk_party_b             varchar(10)  CHECK (stk_party_b ~ '^[0-9]{5,7}$'),  -- till no. for Buy Goods
    consumer_key_enc        bytea        NOT NULL,
    consumer_secret_enc     bytea        NOT NULL,
    passkey_enc             bytea        NOT NULL,
    callback_token          varchar(64)  NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
    c2b_urls_registered_at  timestamptz,
    is_active               boolean      NOT NULL DEFAULT true,
    created_at              timestamptz  NOT NULL DEFAULT now(),
    updated_at              timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (environment, business_shortcode),
    CHECK (shortcode_type = 'paybill' OR stk_party_b IS NOT NULL)
);

-- Sequential per-account, per-year document numbering (INV-2026-000001 ...).
-- Row-locked counter (not a SEQUENCE) so numbers stay contiguous on commit.
CREATE TABLE document_sequences (
    account_id  uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    doc_kind    varchar(5)  NOT NULL,      -- INV, RCT, LSE, TKT
    year        smallint    NOT NULL,
    last_value  integer     NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, doc_kind, year)
);

-- =============================================================================
-- 6. MEDIA (single registry for every uploaded / generated file)
-- =============================================================================
CREATE TABLE media_files (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id         uuid         REFERENCES accounts(id) ON DELETE CASCADE,  -- NULL for user-level (avatar)
    uploaded_by        uuid         REFERENCES users(id) ON DELETE SET NULL,
    purpose            media_purpose NOT NULL,
    storage_key        text         NOT NULL UNIQUE,   -- object-store key or relative disk path
    original_filename  varchar(255),
    mime_type          varchar(100) NOT NULL,
    size_bytes         bigint       NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 104857600),  -- 100 MB
    sha256             char(64)     NOT NULL,
    width_px           integer      CHECK (width_px > 0),
    height_px          integer      CHECK (height_px > 0),
    duration_ms        integer      CHECK (duration_ms >= 0),   -- audio notes / video
    created_at         timestamptz  NOT NULL DEFAULT now(),
    deleted_at         timestamptz
);
CREATE INDEX ix_media_account_purpose ON media_files (account_id, purpose, created_at DESC);
CREATE INDEX ix_media_sha256          ON media_files (sha256);

ALTER TABLE users
    ADD CONSTRAINT fk_users_avatar FOREIGN KEY (avatar_media_id)
        REFERENCES media_files(id) ON DELETE SET NULL;

-- =============================================================================
-- 7. PROPERTY & UNIT HIERARCHY
-- =============================================================================
CREATE TABLE properties (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name            varchar(150)  NOT NULL,
    property_type   property_type NOT NULL,
    county_id       smallint      NOT NULL REFERENCES counties(id),
    sub_county_id   integer,
    ward            varchar(80),
    area            varchar(120)  NOT NULL,   -- estate / neighbourhood: Kilimani, Rongai, Nyali ...
    street_address  varchar(200),
    landmark        varchar(200),             -- "Opposite Naivas, next to Total petrol station"
    latitude        numeric(9,6)  CHECK (latitude  BETWEEN -4.90 AND 5.10),   -- Kenya bounding box
    longitude       numeric(9,6)  CHECK (longitude BETWEEN 33.80 AND 42.00),
    geo_point       point GENERATED ALWAYS AS (
                        CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL
                             THEN point(longitude::float8, latitude::float8) END
                    ) STORED,
    floors_count    smallint      CHECK (floors_count >= 1),
    amenities       text[]        NOT NULL DEFAULT '{}',   -- {borehole, cctv, parking, lift, backup_generator}
    description     text,
    is_active       boolean       NOT NULL DEFAULT true,
    search_vector   tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('simple'::regconfig, coalesce(name, '')), 'A') ||
                        setweight(to_tsvector('simple'::regconfig, coalesce(area, '')), 'A') ||
                        setweight(to_tsvector('simple'::regconfig,
                                  coalesce(ward, '') || ' ' || coalesce(landmark, '') || ' ' ||
                                  coalesce(street_address, '')), 'B') ||
                        setweight(to_tsvector('simple'::regconfig, coalesce(description, '')), 'C')
                    ) STORED,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (account_id, name),
    UNIQUE (id, account_id),
    FOREIGN KEY (sub_county_id, county_id) REFERENCES sub_counties(id, county_id),
    CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX ix_properties_account     ON properties (account_id) WHERE is_active;
CREATE INDEX ix_properties_location    ON properties (county_id, sub_county_id) WHERE is_active;
CREATE INDEX ix_properties_area_trgm   ON properties USING gin (area gin_trgm_ops);
CREATE INDEX ix_properties_name_trgm   ON properties USING gin (name gin_trgm_ops);
CREATE INDEX ix_properties_search      ON properties USING gin (search_vector);
CREATE INDEX ix_properties_geo         ON properties USING gist (geo_point);   -- KNN: ORDER BY geo_point <-> point(lng,lat)
CREATE INDEX ix_properties_amenities   ON properties USING gin (amenities);

CREATE TABLE units (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id         uuid        NOT NULL,
    property_id        uuid        NOT NULL,
    parent_unit_id     uuid        REFERENCES units(id) ON DELETE CASCADE,  -- hostel bed -> hostel room
    unit_number        varchar(30) NOT NULL,                                -- door label: "A4", "Rm 12 Bed 2"
    payment_code       varchar(20) NOT NULL,     -- M-Pesa C2B "Account No." tenants type on Paybill
    unit_type          unit_type   NOT NULL,
    floor_number       smallint,                 -- 0 = ground floor
    bedrooms           smallint    CHECK (bedrooms  >= 0),
    bathrooms          smallint    CHECK (bathrooms >= 0),
    size_sqm           numeric(8,2) CHECK (size_sqm > 0),
    bed_capacity       smallint    NOT NULL DEFAULT 1 CHECK (bed_capacity >= 1),
    monthly_rent       money_kes   NOT NULL CHECK (monthly_rent > 0),
    deposit_amount     money_kes   NOT NULL DEFAULT 0,
    status             unit_status NOT NULL DEFAULT 'vacant',
    status_changed_at  timestamptz NOT NULL DEFAULT now(),
    is_listed_public   boolean     NOT NULL DEFAULT false,
    listed_at          timestamptz,
    condition_summary  text,                     -- latest condition log, denormalised for cards
    condition_tags     text[]      NOT NULL DEFAULT '{}',   -- {fresh_paint, cracked_tiles, leaking_tap}
    features           text[]      NOT NULL DEFAULT '{}',   -- {balcony, tokens_meter, dsq, wardrobe}
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (property_id, account_id) REFERENCES properties(id, account_id) ON DELETE CASCADE,
    UNIQUE (property_id, unit_number),
    UNIQUE (account_id, payment_code),
    UNIQUE (id, account_id),
    CHECK (parent_unit_id IS NULL OR parent_unit_id <> id),
    CHECK (payment_code ~ '^[A-Z0-9-]{2,20}$'),
    CHECK (NOT is_listed_public OR status = 'vacant')
);
CREATE INDEX ix_units_property_status ON units (property_id, status);
CREATE INDEX ix_units_account_status  ON units (account_id, status, status_changed_at DESC);
CREATE INDEX ix_units_public_listing  ON units (unit_type, monthly_rent) WHERE is_listed_public;
CREATE INDEX ix_units_parent          ON units (parent_unit_id) WHERE parent_unit_id IS NOT NULL;
CREATE INDEX ix_units_condition_tags  ON units USING gin (condition_tags);
CREATE INDEX ix_units_features        ON units USING gin (features);

CREATE TABLE unit_media (
    unit_id     uuid        NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    media_id    uuid        NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    caption     varchar(200),
    sort_order  smallint    NOT NULL DEFAULT 0,
    is_cover    boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (unit_id, media_id)
);
CREATE UNIQUE INDEX ux_unit_media_one_cover ON unit_media (unit_id) WHERE is_cover;
CREATE INDEX ix_unit_media_order ON unit_media (unit_id, sort_order);

CREATE TABLE unit_status_history (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    unit_id      uuid        NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    from_status  unit_status,
    to_status    unit_status NOT NULL,
    changed_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
    reason       text,
    changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_unit_status_history_unit ON unit_status_history (unit_id, changed_at DESC);

CREATE TABLE unit_condition_logs (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    unit_id    uuid        NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    logged_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    notes      text        NOT NULL,
    tags       text[]      NOT NULL DEFAULT '{}',
    logged_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_unit_condition_logs_unit ON unit_condition_logs (unit_id, logged_at DESC);

CREATE TABLE unit_condition_log_media (
    log_id    bigint NOT NULL REFERENCES unit_condition_logs(id) ON DELETE CASCADE,
    media_id  uuid   NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    PRIMARY KEY (log_id, media_id)
);

-- =============================================================================
-- 8. TENANTS & LEASES (room allocation)
-- =============================================================================
CREATE TABLE tenants (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id               uuid             NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id                  uuid             REFERENCES users(id) ON DELETE SET NULL,  -- linked once tenant logs in
    first_name               varchar(60)      NOT NULL,
    middle_name              varchar(60),
    last_name                varchar(60)      NOT NULL,
    full_name                text GENERATED ALWAYS AS (
                                 first_name || ' ' || coalesce(middle_name || ' ', '') || last_name
                             ) STORED,
    id_document_type         id_document_type NOT NULL DEFAULT 'national_id',
    id_document_number       varchar(20)      NOT NULL,
    date_of_birth            date             CHECK (date_of_birth > DATE '1900-01-01'),
    phone                    ke_msisdn        NOT NULL,   -- M-Pesa registered line (STK target)
    alt_phone                ke_msisdn,
    email                    citext,
    kra_pin                  kra_pin,
    occupation               varchar(100),
    employer                 varchar(150),
    id_front_media_id        uuid REFERENCES media_files(id) ON DELETE SET NULL,
    id_back_media_id         uuid REFERENCES media_files(id) ON DELETE SET NULL,
    passport_photo_media_id  uuid REFERENCES media_files(id) ON DELETE SET NULL,
    identity_verified_at     timestamptz,
    identity_verified_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    is_blacklisted           boolean     NOT NULL DEFAULT false,
    blacklist_reason         text,
    notes                    text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, id_document_type, id_document_number),
    UNIQUE (id, account_id),
    CHECK (id_document_type <> 'national_id' OR id_document_number ~ '^[0-9]{6,9}$'),
    CHECK (NOT is_blacklisted OR blacklist_reason IS NOT NULL)
);
CREATE INDEX ix_tenants_account_phone ON tenants (account_id, phone);
CREATE INDEX ix_tenants_user          ON tenants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ix_tenants_name_trgm     ON tenants USING gin (full_name gin_trgm_ops);

CREATE TABLE next_of_kin (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    full_name     varchar(120) NOT NULL,
    relationship  varchar(40) NOT NULL,
    phone         ke_msisdn   NOT NULL,
    alt_phone     ke_msisdn,
    id_number     varchar(20),
    is_primary    boolean     NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_next_of_kin_tenant ON next_of_kin (tenant_id);
CREATE UNIQUE INDEX ux_next_of_kin_primary ON next_of_kin (tenant_id) WHERE is_primary;

-- A lease IS the allocation: tenant -> unit. Activating it starts billing.
CREATE TABLE leases (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id               uuid          NOT NULL,
    unit_id                  uuid          NOT NULL,
    tenant_id                uuid          NOT NULL,
    lease_number             varchar(30)   NOT NULL,          -- auto: LSE-2026-000001
    status                   lease_status  NOT NULL DEFAULT 'draft',
    start_date               date          NOT NULL,
    end_date                 date,                            -- exclusive move-out date; NULL = periodic tenancy
    monthly_rent             money_kes     NOT NULL CHECK (monthly_rent > 0),  -- defaults from unit
    deposit_amount           money_kes     NOT NULL,                           -- defaults from unit
    vat_rate                 numeric(5,2)  NOT NULL DEFAULT 0 CHECK (vat_rate BETWEEN 0 AND 100),  -- 16 for commercial
    billing_cycle            billing_cycle NOT NULL DEFAULT 'every_30_days',
    billing_day              smallint      CHECK (billing_day BETWEEN 1 AND 28),
    payment_due_days         smallint      NOT NULL CHECK (payment_due_days BETWEEN 0 AND 28),  -- defaults from account
    next_billing_date        date,
    late_fee_type            late_fee_type NOT NULL DEFAULT 'none',
    late_fee_value           numeric(12,2) NOT NULL DEFAULT 0 CHECK (late_fee_value >= 0),
    notice_period_days       smallint      NOT NULL DEFAULT 30 CHECK (notice_period_days >= 0),
    terms_version            varchar(20)   NOT NULL DEFAULT 'v1',
    terms_snapshot           text,                            -- exact text the tenant agreed to
    terms_sha256             char(64),                        -- hash of snapshot = tamper evidence
    lease_document_media_id  uuid REFERENCES media_files(id) ON DELETE SET NULL,
    signature_media_id       uuid REFERENCES media_files(id) ON DELETE SET NULL,  -- drawn signature PNG
    signed_at                timestamptz,
    signed_ip                inet,
    signed_user_agent        text,
    activated_at             timestamptz,
    activated_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    notice_given_at          timestamptz,
    terminated_at            timestamptz,
    termination_reason       text,
    created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at               timestamptz   NOT NULL DEFAULT now(),
    updated_at               timestamptz   NOT NULL DEFAULT now(),
    FOREIGN KEY (unit_id, account_id)   REFERENCES units(id, account_id),
    FOREIGN KEY (tenant_id, account_id) REFERENCES tenants(id, account_id),
    UNIQUE (account_id, lease_number),
    UNIQUE (id, account_id),
    CHECK (end_date IS NULL OR end_date > start_date),
    CHECK (billing_cycle <> 'fixed_monthly_day' OR billing_day IS NOT NULL),
    CHECK (late_fee_type <> 'percent' OR late_fee_value <= 100),
    CHECK (status NOT IN ('active', 'notice_given') OR (signed_at IS NOT NULL AND terms_sha256 IS NOT NULL)),
    -- One live allocation per unit for any overlapping period (hostel beds are their own units).
    CONSTRAINT ex_leases_no_double_allocation EXCLUDE USING gist (
        unit_id WITH =,
        daterange(start_date, end_date, '[)') WITH &&
    ) WHERE (status IN ('pending_signature', 'active', 'notice_given'))
);
CREATE INDEX ix_leases_tenant       ON leases (tenant_id, status);
CREATE INDEX ix_leases_unit         ON leases (unit_id, status);
CREATE INDEX ix_leases_account      ON leases (account_id, status);
CREATE INDEX ix_leases_billing_due  ON leases (next_billing_date) WHERE status IN ('active', 'notice_given');
CREATE INDEX ix_leases_expiring     ON leases (end_date) WHERE status IN ('active', 'notice_given') AND end_date IS NOT NULL;

-- =============================================================================
-- 9. BILLING: INVOICES
-- =============================================================================
CREATE TABLE invoices (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id         uuid           NOT NULL,
    lease_id           uuid           NOT NULL,
    tenant_id          uuid           NOT NULL,   -- copied from lease by trigger (fast filtering)
    unit_id            uuid           NOT NULL,   -- copied from lease by trigger
    invoice_number     varchar(30)    NOT NULL,   -- auto: INV-2026-000001
    status             invoice_status NOT NULL DEFAULT 'issued',
    period_start       date           NOT NULL,
    period_end         date           NOT NULL,
    issue_date         date           NOT NULL DEFAULT nairobi_today(),
    due_date           date           NOT NULL,
    vat_rate           numeric(5,2)   NOT NULL CHECK (vat_rate BETWEEN 0 AND 100),  -- copied from lease
    subtotal           numeric(14,2)  NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    tax_amount         numeric(14,2)  NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    total_amount       numeric(14,2)  NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    amount_paid        numeric(14,2)  NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    balance            numeric(14,2)  GENERATED ALWAYS AS (total_amount - amount_paid) STORED,
    is_auto_generated  boolean        NOT NULL DEFAULT false,
    paid_at            timestamptz,
    voided_at          timestamptz,
    void_reason        text,
    notes              text,
    created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamptz    NOT NULL DEFAULT now(),
    updated_at         timestamptz    NOT NULL DEFAULT now(),
    FOREIGN KEY (lease_id, account_id)  REFERENCES leases(id, account_id),
    FOREIGN KEY (tenant_id, account_id) REFERENCES tenants(id, account_id),
    FOREIGN KEY (unit_id, account_id)   REFERENCES units(id, account_id),
    UNIQUE (account_id, invoice_number),
    CHECK (period_end >= period_start),
    CHECK (due_date >= period_start),
    CHECK (amount_paid <= total_amount),
    CHECK (status <> 'void' OR (amount_paid = 0 AND voided_at IS NOT NULL))
);
-- Idempotent billing engine: one auto-invoice per lease per period.
CREATE UNIQUE INDEX ux_invoices_lease_period ON invoices (lease_id, period_start)
    WHERE status <> 'void' AND is_auto_generated;
CREATE INDEX ix_invoices_account_status ON invoices (account_id, status, due_date);
CREATE INDEX ix_invoices_tenant         ON invoices (tenant_id, issue_date DESC);
CREATE INDEX ix_invoices_unit           ON invoices (unit_id, period_start DESC);
CREATE INDEX ix_invoices_open           ON invoices (account_id, due_date)
    WHERE status IN ('issued', 'partially_paid', 'overdue');

CREATE TABLE invoice_items (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id   uuid              NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    item_type    invoice_item_type NOT NULL,
    description  varchar(200)      NOT NULL,
    quantity     numeric(10,3)     NOT NULL DEFAULT 1 CHECK (quantity > 0),   -- e.g. water units (m³)
    unit_price   numeric(14,2)     NOT NULL CHECK (unit_price >= 0),
    amount       numeric(14,2)     GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
    created_at   timestamptz       NOT NULL DEFAULT now()
);
CREATE INDEX ix_invoice_items_invoice ON invoice_items (invoice_id);
CREATE UNIQUE INDEX ux_invoice_items_one_late_fee ON invoice_items (invoice_id) WHERE item_type = 'late_fee';

-- =============================================================================
-- 10. M-PESA DARAJA: STK REQUESTS, RAW CALLBACKS, PAYMENTS, RECEIPTS
-- =============================================================================
CREATE TABLE mpesa_stk_requests (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id            uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    invoice_id            uuid          REFERENCES invoices(id) ON DELETE SET NULL,
    lease_id              uuid,
    tenant_id             uuid,
    initiated_by          uuid          REFERENCES users(id) ON DELETE SET NULL,  -- landlord or tenant self-pay
    phone                 ke_msisdn     NOT NULL,
    amount                numeric(14,2) NOT NULL CHECK (amount >= 1 AND amount = trunc(amount)),  -- Daraja: whole KES only
    account_reference     varchar(12)   NOT NULL,   -- Daraja limit 12 chars (we send unit payment_code)
    transaction_desc      varchar(13)   NOT NULL,   -- Daraja limit 13 chars
    merchant_request_id   varchar(64)   UNIQUE,
    checkout_request_id   varchar(64)   UNIQUE,
    status                stk_status    NOT NULL DEFAULT 'initiated',
    response_code         varchar(10),
    response_description  text,
    customer_message      text,
    result_code           integer,
    result_desc           text,
    mpesa_receipt_number  mpesa_receipt,
    request_payload       jsonb,        -- sanitised: Password field stripped by API
    response_payload      jsonb,
    completed_at          timestamptz,
    created_at            timestamptz   NOT NULL DEFAULT now(),
    updated_at            timestamptz   NOT NULL DEFAULT now(),
    FOREIGN KEY (lease_id, account_id)  REFERENCES leases(id, account_id),
    FOREIGN KEY (tenant_id, account_id) REFERENCES tenants(id, account_id)
);
-- Never fire two concurrent prompts at a tenant for the same invoice.
CREATE UNIQUE INDEX ux_stk_inflight_per_invoice ON mpesa_stk_requests (invoice_id)
    WHERE status IN ('initiated', 'pending') AND invoice_id IS NOT NULL;
CREATE INDEX ix_stk_pending  ON mpesa_stk_requests (created_at) WHERE status IN ('initiated', 'pending');
CREATE INDEX ix_stk_account  ON mpesa_stk_requests (account_id, created_at DESC);
CREATE INDEX ix_stk_tenant   ON mpesa_stk_requests (tenant_id, created_at DESC);

-- Immutable raw log of EVERY webhook hit, written before any processing.
CREATE TABLE mpesa_callbacks (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id           uuid REFERENCES accounts(id) ON DELETE SET NULL,  -- resolved from URL callback_token
    callback_type        mpesa_callback_type NOT NULL,
    source_ip            inet,
    http_headers         jsonb,
    payload              jsonb       NOT NULL,
    merchant_request_id  varchar(64),
    checkout_request_id  varchar(64),
    trans_id             varchar(20),
    result_code          integer,
    processed_at         timestamptz,
    processing_error     text,
    received_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mpesa_callbacks_checkout    ON mpesa_callbacks (checkout_request_id) WHERE checkout_request_id IS NOT NULL;
CREATE INDEX ix_mpesa_callbacks_trans       ON mpesa_callbacks (trans_id) WHERE trans_id IS NOT NULL;
CREATE INDEX ix_mpesa_callbacks_unprocessed ON mpesa_callbacks (received_at) WHERE processed_at IS NULL;
CREATE INDEX ix_mpesa_callbacks_received    ON mpesa_callbacks USING brin (received_at);

CREATE TABLE payments (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id            uuid           NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    tenant_id             uuid,          -- NULL = unmatched C2B payment awaiting manual match
    lease_id              uuid,
    target_invoice_id     uuid           REFERENCES invoices(id) ON DELETE SET NULL,  -- allocation hint
    method                payment_method NOT NULL,
    status                payment_status NOT NULL DEFAULT 'completed',
    amount                money_kes      NOT NULL CHECK (amount > 0),
    allocated_amount      numeric(14,2)  NOT NULL DEFAULT 0,
    unallocated_amount    numeric(14,2)  GENERATED ALWAYS AS (amount - allocated_amount) STORED,  -- tenant credit
    mpesa_receipt_number  mpesa_receipt  UNIQUE,      -- idempotency key for Safaricom retries
    external_reference    varchar(60),                -- bank ref / cheque no.
    payer_phone           varchar(64),                -- C2B now returns a masked/hashed MSISDN
    payer_name            varchar(150),
    bill_ref_number       varchar(30),                -- what the payer typed as "Account No."
    stk_request_id        uuid   REFERENCES mpesa_stk_requests(id) ON DELETE SET NULL,
    callback_id           bigint REFERENCES mpesa_callbacks(id) ON DELETE SET NULL,
    paid_at               timestamptz    NOT NULL,     -- Safaricom TransTime, converted from EAT
    recorded_by           uuid   REFERENCES users(id) ON DELETE SET NULL,
    reconciled_at         timestamptz,
    notes                 text,
    created_at            timestamptz    NOT NULL DEFAULT now(),
    updated_at            timestamptz    NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, account_id) REFERENCES tenants(id, account_id),
    FOREIGN KEY (lease_id, account_id)  REFERENCES leases(id, account_id),
    CHECK (allocated_amount >= 0 AND allocated_amount <= amount),
    CHECK (method NOT IN ('mpesa_stk', 'mpesa_c2b') OR status <> 'completed' OR mpesa_receipt_number IS NOT NULL),
    CHECK (method IN ('mpesa_stk', 'mpesa_c2b') OR recorded_by IS NOT NULL)   -- manual entries are attributable
);
CREATE INDEX ix_payments_account_paid ON payments (account_id, paid_at DESC);
CREATE INDEX ix_payments_tenant_paid  ON payments (tenant_id, paid_at DESC);
CREATE INDEX ix_payments_lease        ON payments (lease_id);
CREATE INDEX ix_payments_unmatched    ON payments (account_id, paid_at DESC) WHERE tenant_id IS NULL AND status = 'completed';
CREATE INDEX ix_payments_credit       ON payments (tenant_id) WHERE status = 'completed' AND unallocated_amount > 0;
CREATE INDEX ix_payments_bill_ref     ON payments (account_id, bill_ref_number);

CREATE TABLE payment_allocations (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payment_id    uuid          NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    invoice_id    uuid          NOT NULL REFERENCES invoices(id),
    amount        numeric(14,2) NOT NULL CHECK (amount > 0),
    allocated_by  uuid          REFERENCES users(id) ON DELETE SET NULL,
    allocated_at  timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (payment_id, invoice_id)
);
CREATE INDEX ix_payment_allocations_invoice ON payment_allocations (invoice_id);

CREATE TABLE receipts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    payment_id      uuid        NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
    receipt_number  varchar(30) NOT NULL,          -- auto: RCT-2026-000001
    pdf_media_id    uuid        REFERENCES media_files(id) ON DELETE SET NULL,  -- rendered by API worker
    issued_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, receipt_number)
);
CREATE INDEX ix_receipts_pending_pdf ON receipts (issued_at) WHERE pdf_media_id IS NULL;

-- =============================================================================
-- 11. CARETAKER ELIMINATION ENGINE: ISSUES, CONTRACTORS, EXPENSES
-- =============================================================================
CREATE TABLE contractors (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    uuid             NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id       uuid             REFERENCES users(id) ON DELETE SET NULL,
    name          varchar(120)     NOT NULL,
    company_name  varchar(150),
    phone         ke_msisdn        NOT NULL,
    email         citext,
    specialties   issue_category[] NOT NULL DEFAULT '{}',
    rating        numeric(2,1)     CHECK (rating BETWEEN 0 AND 5),
    is_active     boolean          NOT NULL DEFAULT true,
    created_at    timestamptz      NOT NULL DEFAULT now(),
    updated_at    timestamptz      NOT NULL DEFAULT now(),
    UNIQUE (account_id, phone),
    UNIQUE (id, account_id)
);
CREATE INDEX ix_contractors_specialties ON contractors USING gin (specialties) WHERE is_active;

CREATE TABLE issues (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id              uuid           NOT NULL,
    ticket_number           varchar(30)    NOT NULL,     -- auto: TKT-2026-000001
    property_id             uuid           NOT NULL,     -- derived from unit by trigger
    unit_id                 uuid           NOT NULL,
    tenant_id               uuid,                        -- derived from live lease if omitted
    lease_id                uuid,
    reported_by             uuid           NOT NULL REFERENCES users(id),
    category                issue_category NOT NULL,
    priority                issue_priority NOT NULL DEFAULT 'medium',
    title                   varchar(150)   NOT NULL,
    description             text           NOT NULL,
    status                  issue_status   NOT NULL DEFAULT 'received',
    assigned_contractor_id  uuid,
    scheduled_for           timestamptz,
    estimated_cost          money_kes,
    actual_cost             money_kes,
    acknowledged_at         timestamptz,
    dispatched_at           timestamptz,
    resolved_at             timestamptz,
    closed_at               timestamptz,
    resolution_notes        text,
    tenant_rating           smallint       CHECK (tenant_rating BETWEEN 1 AND 5),
    tenant_feedback         text,
    created_at              timestamptz    NOT NULL DEFAULT now(),
    updated_at              timestamptz    NOT NULL DEFAULT now(),
    FOREIGN KEY (unit_id, account_id)                REFERENCES units(id, account_id),
    FOREIGN KEY (property_id, account_id)            REFERENCES properties(id, account_id),
    FOREIGN KEY (tenant_id, account_id)              REFERENCES tenants(id, account_id),
    FOREIGN KEY (lease_id, account_id)               REFERENCES leases(id, account_id),
    FOREIGN KEY (assigned_contractor_id, account_id) REFERENCES contractors(id, account_id),
    UNIQUE (account_id, ticket_number),
    CHECK (status <> 'dispatched_contractor' OR assigned_contractor_id IS NOT NULL),
    CHECK (tenant_rating IS NULL OR status IN ('resolved', 'closed'))
);
CREATE INDEX ix_issues_open         ON issues (account_id, priority, created_at)
    WHERE status NOT IN ('resolved', 'closed', 'rejected');
CREATE INDEX ix_issues_account      ON issues (account_id, status, created_at DESC);
CREATE INDEX ix_issues_unit         ON issues (unit_id, created_at DESC);
CREATE INDEX ix_issues_tenant       ON issues (tenant_id, created_at DESC);
CREATE INDEX ix_issues_property_cat ON issues (property_id, category, created_at DESC);
CREATE INDEX ix_issues_contractor   ON issues (assigned_contractor_id) WHERE assigned_contractor_id IS NOT NULL;

CREATE TABLE issue_attachments (
    issue_id     uuid        NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    media_id     uuid        NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    uploaded_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (issue_id, media_id)
);

-- Timeline of every status change / comment on a ticket.
CREATE TABLE issue_updates (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id     uuid         NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_id    uuid         REFERENCES users(id) ON DELETE SET NULL,
    from_status  issue_status,
    to_status    issue_status,
    comment      text,
    is_internal  boolean      NOT NULL DEFAULT false,   -- hidden from tenant
    created_at   timestamptz  NOT NULL DEFAULT now(),
    CHECK (comment IS NOT NULL OR to_status IS NOT NULL)
);
CREATE INDEX ix_issue_updates_issue ON issue_updates (issue_id, created_at);

CREATE TABLE maintenance_expenses (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id        uuid           NOT NULL,
    property_id       uuid           NOT NULL,
    unit_id           uuid,
    issue_id          uuid           REFERENCES issues(id) ON DELETE SET NULL,
    contractor_id     uuid,
    category          issue_category NOT NULL,
    description       varchar(250)   NOT NULL,
    amount            money_kes      NOT NULL CHECK (amount > 0),
    incurred_on       date           NOT NULL DEFAULT nairobi_today(),
    receipt_media_id  uuid           REFERENCES media_files(id) ON DELETE SET NULL,
    recorded_by       uuid           REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz    NOT NULL DEFAULT now(),
    updated_at        timestamptz    NOT NULL DEFAULT now(),
    FOREIGN KEY (property_id, account_id)   REFERENCES properties(id, account_id),
    FOREIGN KEY (unit_id, account_id)       REFERENCES units(id, account_id),
    FOREIGN KEY (contractor_id, account_id) REFERENCES contractors(id, account_id)
);
CREATE INDEX ix_maint_exp_account  ON maintenance_expenses (account_id, incurred_on DESC);
CREATE INDEX ix_maint_exp_property ON maintenance_expenses (property_id, incurred_on DESC);
CREATE UNIQUE INDEX ux_maint_exp_issue ON maintenance_expenses (issue_id) WHERE issue_id IS NOT NULL;

-- =============================================================================
-- 12. REAL-TIME COMMUNICATION: CHAT + WEBRTC CALL LOGS
--     (SDP offers / ICE candidates are relayed over WebSocket, never stored.)
-- =============================================================================
CREATE TABLE conversations (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id            uuid        NOT NULL,
    tenant_id             uuid        NOT NULL,
    last_message_at       timestamptz,
    last_message_preview  varchar(140),
    created_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, account_id) REFERENCES tenants(id, account_id) ON DELETE CASCADE,
    UNIQUE (account_id, tenant_id)          -- exactly one landlord<->tenant thread
);
CREATE INDEX ix_conversations_inbox ON conversations (account_id, last_message_at DESC NULLS LAST);

CREATE TABLE conversation_participants (
    conversation_id       uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id               uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_tenant             boolean     NOT NULL,
    last_read_message_id  bigint,
    last_read_at          timestamptz,
    muted_until           timestamptz,
    joined_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX ix_conv_participants_user ON conversation_participants (user_id);

CREATE TABLE call_sessions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id       uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    caller_id             uuid        NOT NULL REFERENCES users(id),
    callee_id             uuid        NOT NULL REFERENCES users(id),
    call_type             call_type   NOT NULL,
    status                call_status NOT NULL DEFAULT 'ringing',
    issue_id              uuid        REFERENCES issues(id) ON DELETE SET NULL,  -- live damage walkthrough
    started_at            timestamptz NOT NULL DEFAULT now(),
    answered_at           timestamptz,
    ended_at              timestamptz,
    duration_seconds      integer GENERATED ALWAYS AS (
                              CASE WHEN answered_at IS NOT NULL AND ended_at IS NOT NULL
                                   THEN extract(epoch FROM (ended_at - answered_at))::integer END
                          ) STORED,
    end_reason            varchar(40),
    ice_candidate_type    varchar(10) CHECK (ice_candidate_type IN ('host', 'srflx', 'prflx', 'relay')),  -- TURN usage
    CHECK (caller_id <> callee_id),
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX ix_calls_conversation ON call_sessions (conversation_id, started_at DESC);
CREATE INDEX ix_calls_ringing      ON call_sessions (callee_id) WHERE status = 'ringing';

CREATE TABLE messages (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- monotonic cursor for pagination
    conversation_id    uuid         NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id          uuid         REFERENCES users(id) ON DELETE SET NULL,
    message_type       message_type NOT NULL DEFAULT 'text',
    body               text         CHECK (char_length(body) <= 4000),
    media_id           uuid         REFERENCES media_files(id) ON DELETE SET NULL,
    reply_to_id        bigint       REFERENCES messages(id) ON DELETE SET NULL,
    call_id            uuid         REFERENCES call_sessions(id) ON DELETE SET NULL,
    client_message_id  uuid,        -- generated in browser; makes offline-queue retries idempotent
    delivered_at       timestamptz,
    edited_at          timestamptz,
    deleted_at         timestamptz,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    CHECK (message_type <> 'text' OR (body IS NOT NULL AND btrim(body) <> '')),
    CHECK (message_type NOT IN ('image', 'video', 'audio_note', 'file') OR media_id IS NOT NULL OR deleted_at IS NOT NULL),
    CHECK (message_type <> 'call_log' OR call_id IS NOT NULL),
    CHECK (sender_id IS NOT NULL OR message_type IN ('system', 'call_log'))
);
CREATE INDEX ix_messages_conversation ON messages (conversation_id, id DESC);
CREATE UNIQUE INDEX ux_messages_client_id ON messages (sender_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX ix_messages_body_trgm ON messages USING gin (body gin_trgm_ops) WHERE deleted_at IS NULL;

-- =============================================================================
-- 13. NOTIFICATIONS, REPORTS, BILLING RUNS, AUDIT
-- =============================================================================
CREATE TABLE notifications (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     uuid              NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id  uuid              REFERENCES accounts(id) ON DELETE CASCADE,
    type        notification_type NOT NULL,
    title       varchar(150)      NOT NULL,
    body        text,
    data        jsonb             NOT NULL DEFAULT '{}',
    read_at     timestamptz,
    pushed_at   timestamptz,      -- Web Push delivered
    created_at  timestamptz       NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX ix_notifications_user   ON notifications (user_id, id DESC);
CREATE INDEX ix_notifications_unpushed ON notifications (created_at) WHERE pushed_at IS NULL;

CREATE TABLE report_exports (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    requested_by  uuid          REFERENCES users(id) ON DELETE SET NULL,
    report_type   report_type   NOT NULL,
    format        export_format NOT NULL,
    parameters    jsonb         NOT NULL DEFAULT '{}',   -- {"from":"2026-01-01","to":"2026-01-31","property_id":...}
    status        export_status NOT NULL DEFAULT 'queued',
    media_id      uuid          REFERENCES media_files(id) ON DELETE SET NULL,
    error         text,
    requested_at  timestamptz   NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    CHECK (status <> 'ready' OR media_id IS NOT NULL)
);
CREATE INDEX ix_report_exports_account ON report_exports (account_id, requested_at DESC);
CREATE INDEX ix_report_exports_queue   ON report_exports (requested_at) WHERE status = 'queued';

CREATE TABLE billing_runs (
    id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_date                 date        NOT NULL,
    started_at               timestamptz NOT NULL DEFAULT now(),
    finished_at              timestamptz,
    invoices_created         integer     NOT NULL DEFAULT 0,
    leases_expired           integer     NOT NULL DEFAULT 0,
    invoices_marked_overdue  integer     NOT NULL DEFAULT 0,
    late_fees_applied        integer     NOT NULL DEFAULT 0
);

CREATE TABLE audit_logs (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id   uuid,
    actor_id     uuid,
    action       varchar(10)  NOT NULL,    -- insert / update / delete
    entity_type  varchar(40)  NOT NULL,
    entity_id    text,
    changes      jsonb        NOT NULL,
    ip_address   inet,
    created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity  ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX ix_audit_account ON audit_logs (account_id, created_at DESC);
CREATE INDEX ix_audit_created ON audit_logs USING brin (created_at);

-- =============================================================================
-- 14. CORE FUNCTIONS
-- =============================================================================

-- 14.1 Event bus: single LISTEN channel for the WebSocket gateway -------------
CREATE FUNCTION fn_emit_event(p_event text, p_account_id uuid, p_data jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql AS $$
    SELECT pg_notify(
        'kodi_events',
        (jsonb_build_object('event', p_event, 'account_id', p_account_id, 'at', now())
            || coalesce(p_data, '{}'::jsonb))::text
    )
$$;

-- 14.2 Document numbering -----------------------------------------------------
CREATE FUNCTION next_document_number(p_account_id uuid, p_kind text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    v_year smallint := extract(year FROM now() AT TIME ZONE 'Africa/Nairobi');
    v_next integer;
BEGIN
    INSERT INTO document_sequences (account_id, doc_kind, year, last_value)
    VALUES (p_account_id, p_kind, v_year, 1)
    ON CONFLICT (account_id, doc_kind, year)
        DO UPDATE SET last_value = document_sequences.last_value + 1
    RETURNING last_value INTO v_next;
    RETURN format('%s-%s-%s', p_kind, v_year, lpad(v_next::text, 6, '0'));
END $$;

-- 14.3 Notification helpers ---------------------------------------------------
CREATE FUNCTION fn_notify_tenant(p_tenant_id uuid, p_type notification_type,
                                 p_title text, p_body text, p_data jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql AS $$
    INSERT INTO notifications (user_id, account_id, type, title, body, data)
    SELECT t.user_id, t.account_id, p_type, left(p_title, 150), p_body, coalesce(p_data, '{}')
    FROM tenants t
    WHERE t.id = p_tenant_id AND t.user_id IS NOT NULL
$$;

CREATE FUNCTION fn_notify_account_staff(p_account_id uuid, p_type notification_type,
                                        p_title text, p_body text, p_data jsonb DEFAULT '{}',
                                        p_roles account_member_role[] DEFAULT '{owner,manager}')
RETURNS void LANGUAGE sql AS $$
    INSERT INTO notifications (user_id, account_id, type, title, body, data)
    SELECT am.user_id, p_account_id, p_type, left(p_title, 150), p_body, coalesce(p_data, '{}')
    FROM account_members am
    JOIN users u ON u.id = am.user_id AND u.is_active
    WHERE am.account_id = p_account_id AND am.role = ANY (p_roles)
$$;

-- 14.4 Conversation bootstrap (landlord staff + tenant user) -----------------
CREATE FUNCTION fn_ensure_conversation(p_account_id uuid, p_tenant_id uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    v_id   uuid;
    v_user uuid;
BEGIN
    SELECT id INTO v_id FROM conversations WHERE account_id = p_account_id AND tenant_id = p_tenant_id;
    IF v_id IS NULL THEN
        INSERT INTO conversations (account_id, tenant_id) VALUES (p_account_id, p_tenant_id)
        ON CONFLICT (account_id, tenant_id) DO NOTHING
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN   -- lost a race to a concurrent insert
            SELECT id INTO v_id FROM conversations WHERE account_id = p_account_id AND tenant_id = p_tenant_id;
        END IF;
    END IF;

    SELECT user_id INTO v_user FROM tenants WHERE id = p_tenant_id;
    IF v_user IS NOT NULL THEN
        INSERT INTO conversation_participants (conversation_id, user_id, is_tenant)
        VALUES (v_id, v_user, true) ON CONFLICT DO NOTHING;
    END IF;

    INSERT INTO conversation_participants (conversation_id, user_id, is_tenant)
    SELECT v_id, am.user_id, false
    FROM account_members am
    WHERE am.account_id = p_account_id AND am.role IN ('owner', 'manager')
    ON CONFLICT DO NOTHING;

    RETURN v_id;
END $$;

-- 14.5 Invoice recalculation: single source of truth for totals & status -----
CREATE FUNCTION fn_refresh_invoice(p_invoice_id uuid, p_as_of date DEFAULT nairobi_today())
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_inv    invoices%ROWTYPE;
    v_sub    numeric(14,2);
    v_tax    numeric(14,2);
    v_total  numeric(14,2);
    v_paid   numeric(14,2);
    v_status invoice_status;
BEGIN
    SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT coalesce(sum(amount), 0) INTO v_sub  FROM invoice_items       WHERE invoice_id = p_invoice_id;
    SELECT coalesce(sum(amount), 0) INTO v_paid FROM payment_allocations WHERE invoice_id = p_invoice_id;
    v_tax   := round(v_sub * v_inv.vat_rate / 100, 2);
    v_total := v_sub + v_tax;

    v_status := CASE
        WHEN v_inv.status IN ('draft', 'void')   THEN v_inv.status
        WHEN v_total > 0 AND v_paid >= v_total    THEN 'paid'
        WHEN v_inv.due_date < p_as_of             THEN 'overdue'
        WHEN v_paid > 0                           THEN 'partially_paid'
        ELSE 'issued'
    END::invoice_status;

    UPDATE invoices
       SET subtotal     = v_sub,
           tax_amount   = v_tax,
           total_amount = v_total,
           amount_paid  = v_paid,
           status       = v_status,
           paid_at      = CASE WHEN v_status = 'paid' THEN coalesce(paid_at, now()) END
     WHERE id = p_invoice_id
       AND (subtotal, tax_amount, total_amount, amount_paid, status)
           IS DISTINCT FROM (v_sub, v_tax, v_total, v_paid, v_status);
END $$;

-- 14.6 Payment reconciliation: FIFO allocation + receipt ---------------------
-- Allocates a payment's unallocated amount to the tenant's open invoices
-- (STK target invoice first, then oldest due). Leftover stays as credit and is
-- auto-applied when the next invoice is generated. Returns remaining credit.
CREATE FUNCTION fn_allocate_payment(p_payment_id uuid)
RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE
    v_pay       payments%ROWTYPE;
    v_remaining numeric(14,2);
    v_apply     numeric(14,2);
    r           record;
BEGIN
    SELECT * INTO v_pay FROM payments WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment % not found', p_payment_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_pay.status <> 'completed' OR v_pay.tenant_id IS NULL THEN
        RETURN 0;
    END IF;

    v_remaining := v_pay.amount - v_pay.allocated_amount;

    FOR r IN
        SELECT i.id, i.balance
        FROM invoices i
        WHERE i.account_id = v_pay.account_id
          AND i.tenant_id  = v_pay.tenant_id
          AND (v_pay.lease_id IS NULL OR i.lease_id = v_pay.lease_id)
          AND i.status IN ('issued', 'partially_paid', 'overdue')
          AND i.balance > 0
        ORDER BY (i.id = v_pay.target_invoice_id) DESC NULLS LAST, i.due_date, i.created_at
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;
        v_apply := least(v_remaining, r.balance);
        INSERT INTO payment_allocations (payment_id, invoice_id, amount, allocated_by)
        VALUES (p_payment_id, r.id, v_apply, app_current_user_id())
        ON CONFLICT (payment_id, invoice_id)
            DO UPDATE SET amount = payment_allocations.amount + EXCLUDED.amount;
        v_remaining := v_remaining - v_apply;
    END LOOP;

    UPDATE payments SET reconciled_at = coalesce(reconciled_at, now()) WHERE id = p_payment_id;

    IF NOT EXISTS (SELECT 1 FROM receipts WHERE payment_id = p_payment_id) THEN
        INSERT INTO receipts (account_id, payment_id) VALUES (v_pay.account_id, p_payment_id);
    END IF;

    RETURN v_remaining;
END $$;

-- 14.7 Billing engine ----------------------------------------------------------
-- Generates every due invoice for one lease up to p_as_of (catches up missed
-- cycles), pro-rates stub periods, bills the deposit once, then applies any
-- tenant credit. Idempotent thanks to ux_invoices_lease_period.
CREATE FUNCTION fn_generate_lease_invoices(p_lease_id uuid, p_as_of date DEFAULT nairobi_today())
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
    l             leases%ROWTYPE;
    v_unit_number text;
    v_start       date;
    v_next        date;
    v_end         date;
    v_cycle_days  integer;
    v_days        integer;
    v_rent        numeric(14,2);
    v_invoice_id  uuid;
    v_created     integer := 0;
    v_total       numeric(14,2);
    v_number      text;
    r             record;
BEGIN
    SELECT * INTO l FROM leases WHERE id = p_lease_id FOR UPDATE;
    IF NOT FOUND OR l.status NOT IN ('active', 'notice_given') THEN
        RETURN 0;
    END IF;
    SELECT unit_number INTO v_unit_number FROM units WHERE id = l.unit_id;

    v_start := coalesce(l.next_billing_date, l.start_date);

    WHILE v_start <= p_as_of AND (l.end_date IS NULL OR v_start < l.end_date) LOOP
        IF l.billing_cycle = 'every_30_days' THEN
            v_next       := v_start + 30;
            v_cycle_days := 30;
        ELSE
            v_next       := fn_next_billing_day(v_start, l.billing_day);
            v_cycle_days := v_next - (v_next - interval '1 month')::date;
        END IF;

        v_end := v_next - 1;
        IF l.end_date IS NOT NULL AND v_end >= l.end_date THEN
            v_end := l.end_date - 1;
        END IF;
        v_days := v_end - v_start + 1;
        v_rent := CASE WHEN v_days >= v_cycle_days THEN l.monthly_rent
                       ELSE round(l.monthly_rent * v_days / v_cycle_days, 2) END;

        v_invoice_id := NULL;
        INSERT INTO invoices (account_id, lease_id, period_start, period_end,
                              issue_date, due_date, is_auto_generated)
        VALUES (l.account_id, l.id, v_start, v_end,
                v_start, v_start + l.payment_due_days, true)
        ON CONFLICT (lease_id, period_start) WHERE (status <> 'void' AND is_auto_generated)
            DO NOTHING
        RETURNING id INTO v_invoice_id;

        IF v_invoice_id IS NOT NULL THEN
            INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price)
            VALUES (v_invoice_id, 'rent',
                    format('Rent - Unit %s (%s to %s)%s', v_unit_number,
                           to_char(v_start, 'DD Mon YYYY'), to_char(v_end, 'DD Mon YYYY'),
                           CASE WHEN v_days < v_cycle_days
                                THEN format(', pro-rated %s/%s days', v_days, v_cycle_days)
                                ELSE '' END),
                    1, v_rent);

            IF l.deposit_amount > 0 AND NOT EXISTS (
                SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                WHERE i.lease_id = l.id AND i.status <> 'void' AND ii.item_type = 'deposit'
            ) THEN
                INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price)
                VALUES (v_invoice_id, 'deposit', 'Security deposit (refundable)', 1, l.deposit_amount);
            END IF;

            SELECT total_amount, invoice_number INTO v_total, v_number FROM invoices WHERE id = v_invoice_id;
            PERFORM fn_notify_tenant(l.tenant_id, 'invoice_issued',
                format('New invoice %s', v_number),
                format('KES %s due by %s.', to_char(v_total, 'FM999,999,990.00'),
                       to_char(v_start + l.payment_due_days, 'DD Mon YYYY')),
                jsonb_build_object('invoice_id', v_invoice_id));
            v_created := v_created + 1;
        END IF;

        v_start := v_next;
    END LOOP;

    IF v_start IS DISTINCT FROM l.next_billing_date THEN
        UPDATE leases SET next_billing_date = v_start WHERE id = l.id;
    END IF;

    -- Auto-apply prepayments / overpayments to the fresh invoices.
    FOR r IN
        SELECT id FROM payments
        WHERE account_id = l.account_id AND tenant_id = l.tenant_id
          AND status = 'completed' AND unallocated_amount > 0
          AND (lease_id IS NULL OR lease_id = l.id)
        ORDER BY paid_at
    LOOP
        PERFORM fn_allocate_payment(r.id);
    END LOOP;

    RETURN v_created;
END $$;

-- Nightly job (APScheduler in FastAPI, or pg_cron):  SELECT fn_run_billing();
CREATE FUNCTION fn_run_billing(p_as_of date DEFAULT nairobi_today())
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_run_id  bigint;
    v_created integer := 0;
    v_expired integer := 0;
    v_overdue integer := 0;
    v_fees    integer := 0;
    r         record;
BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtext('kodi.fn_run_billing')) THEN
        RETURN jsonb_build_object('skipped', true, 'reason', 'another billing run holds the lock');
    END IF;

    INSERT INTO billing_runs (run_date) VALUES (p_as_of) RETURNING id INTO v_run_id;

    -- 1. Generate due invoices (before expiry so final stub periods are billed).
    FOR r IN
        SELECT id FROM leases
        WHERE status IN ('active', 'notice_given') AND next_billing_date <= p_as_of
        ORDER BY next_billing_date
    LOOP
        v_created := v_created + fn_generate_lease_invoices(r.id, p_as_of);
    END LOOP;

    -- 2. Expire leases that reached their end date (unit flips to 'cleaning').
    WITH x AS (
        UPDATE leases SET status = 'expired'
        WHERE status IN ('active', 'notice_given') AND end_date IS NOT NULL AND end_date <= p_as_of
        RETURNING 1
    ) SELECT count(*) INTO v_expired FROM x;

    -- 3. Flag overdue invoices.
    FOR r IN
        SELECT id FROM invoices
        WHERE status IN ('issued', 'partially_paid') AND due_date < p_as_of
    LOOP
        PERFORM fn_refresh_invoice(r.id, p_as_of);
        v_overdue := v_overdue + 1;
    END LOOP;

    -- 4. One late fee per overdue auto-invoice, per lease policy.
    FOR r IN
        SELECT i.id, l.late_fee_type, l.late_fee_value,
               (SELECT coalesce(sum(ii.amount), 0) FROM invoice_items ii
                 WHERE ii.invoice_id = i.id AND ii.item_type = 'rent') AS rent_amount
        FROM invoices i
        JOIN leases l ON l.id = i.lease_id
        WHERE i.status = 'overdue' AND i.is_auto_generated
          AND l.late_fee_type <> 'none' AND l.late_fee_value > 0
          AND NOT EXISTS (SELECT 1 FROM invoice_items x
                          WHERE x.invoice_id = i.id AND x.item_type = 'late_fee')
    LOOP
        CONTINUE WHEN r.late_fee_type = 'percent' AND r.rent_amount = 0;
        INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price)
        VALUES (r.id, 'late_fee',
                CASE WHEN r.late_fee_type = 'flat' THEN 'Late payment penalty'
                     ELSE format('Late payment penalty (%s%% of rent)', r.late_fee_value) END,
                1,
                CASE WHEN r.late_fee_type = 'flat' THEN r.late_fee_value
                     ELSE round(r.rent_amount * r.late_fee_value / 100, 2) END);
        v_fees := v_fees + 1;
    END LOOP;

    UPDATE billing_runs
       SET finished_at = now(), invoices_created = v_created, leases_expired = v_expired,
           invoices_marked_overdue = v_overdue, late_fees_applied = v_fees
     WHERE id = v_run_id;

    RETURN jsonb_build_object('run_id', v_run_id, 'as_of', p_as_of,
                              'invoices_created', v_created, 'leases_expired', v_expired,
                              'invoices_marked_overdue', v_overdue, 'late_fees_applied', v_fees);
END $$;

-- 14.8 M-Pesa STK callback ingestion (call in the same txn that stored the raw row)
CREATE FUNCTION fn_process_stk_callback(p_callback_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    v_cb         mpesa_callbacks%ROWTYPE;
    v_body       jsonb;
    v_meta       jsonb;
    v_req        mpesa_stk_requests%ROWTYPE;
    v_result     integer;
    v_receipt    text;
    v_amount     numeric(14,2);
    v_paid_at    timestamptz;
    v_payment_id uuid;
    v_note       text;
BEGIN
    SELECT * INTO v_cb FROM mpesa_callbacks WHERE id = p_callback_id FOR UPDATE;
    IF NOT FOUND OR v_cb.processed_at IS NOT NULL THEN
        RETURN NULL;
    END IF;

    v_body := v_cb.payload -> 'Body' -> 'stkCallback';
    IF v_body IS NULL OR v_body ->> 'CheckoutRequestID' IS NULL THEN
        UPDATE mpesa_callbacks SET processed_at = now(), processing_error = 'Malformed STK payload'
         WHERE id = p_callback_id;
        RETURN NULL;
    END IF;

    v_result := (v_body ->> 'ResultCode')::integer;

    SELECT * INTO v_req FROM mpesa_stk_requests
     WHERE checkout_request_id = v_body ->> 'CheckoutRequestID' FOR UPDATE;
    IF NOT FOUND THEN
        UPDATE mpesa_callbacks
           SET processed_at = now(), result_code = v_result,
               merchant_request_id = v_body ->> 'MerchantRequestID',
               checkout_request_id = v_body ->> 'CheckoutRequestID',
               processing_error = 'Unknown CheckoutRequestID'
         WHERE id = p_callback_id;
        RETURN NULL;
    END IF;

    IF v_req.status = 'success' THEN
        v_note := 'Duplicate callback ignored';
    ELSIF v_result = 0 THEN
        SELECT jsonb_object_agg(item ->> 'Name', item -> 'Value') INTO v_meta
        FROM jsonb_array_elements(coalesce(v_body -> 'CallbackMetadata' -> 'Item', '[]'::jsonb)) AS item;

        v_receipt := upper(v_meta ->> 'MpesaReceiptNumber');
        v_amount  := (v_meta ->> 'Amount')::numeric;
        v_paid_at := coalesce(
            to_timestamp(v_meta ->> 'TransactionDate', 'YYYYMMDDHH24MISS')::timestamp
                AT TIME ZONE 'Africa/Nairobi',
            now());

        IF v_amount IS DISTINCT FROM v_req.amount THEN
            v_note := format('Amount mismatch: requested %s, received %s', v_req.amount, v_amount);
        END IF;

        INSERT INTO payments (account_id, tenant_id, lease_id, target_invoice_id, method, status,
                              amount, mpesa_receipt_number, payer_phone, stk_request_id,
                              callback_id, paid_at)
        VALUES (v_req.account_id, v_req.tenant_id, v_req.lease_id, v_req.invoice_id, 'mpesa_stk',
                'completed', v_amount, v_receipt, v_meta ->> 'PhoneNumber', v_req.id,
                p_callback_id, v_paid_at)
        ON CONFLICT (mpesa_receipt_number) DO NOTHING
        RETURNING id INTO v_payment_id;

        UPDATE mpesa_stk_requests
           SET status = 'success', result_code = v_result, result_desc = v_body ->> 'ResultDesc',
               mpesa_receipt_number = v_receipt, completed_at = now()
         WHERE id = v_req.id;
    ELSE
        -- 1032 cancelled by user · 1037/1019 unreachable/expired · 1 insufficient funds · 2001 wrong PIN
        UPDATE mpesa_stk_requests
           SET status = (CASE WHEN v_result = 1032 THEN 'cancelled'
                              WHEN v_result IN (1037, 1019) THEN 'timeout'
                              ELSE 'failed' END)::stk_status,
               result_code = v_result, result_desc = v_body ->> 'ResultDesc', completed_at = now()
         WHERE id = v_req.id;
    END IF;

    UPDATE mpesa_callbacks
       SET processed_at = now(),
           account_id = coalesce(account_id, v_req.account_id),
           merchant_request_id = v_body ->> 'MerchantRequestID',
           checkout_request_id = v_body ->> 'CheckoutRequestID',
           trans_id = v_receipt,
           result_code = v_result,
           processing_error = v_note
     WHERE id = p_callback_id;

    RETURN v_payment_id;
END $$;

-- 14.9 M-Pesa C2B confirmation ingestion (tenant paid via Paybill directly) ---
-- Matching order for BillRefNumber: unit payment_code -> invoice number -> tenant ID number.
-- Unmatched money is still recorded (tenant_id NULL) and staff are alerted.
CREATE FUNCTION fn_process_c2b_confirmation(p_callback_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    v_cb         mpesa_callbacks%ROWTYPE;
    v_p          jsonb;
    v_account    uuid;
    v_ref        text;
    v_lease_id   uuid;
    v_tenant_id  uuid;
    v_invoice_id uuid;
    v_payment_id uuid;
BEGIN
    SELECT * INTO v_cb FROM mpesa_callbacks WHERE id = p_callback_id FOR UPDATE;
    IF NOT FOUND OR v_cb.processed_at IS NOT NULL THEN
        RETURN NULL;
    END IF;
    v_p := v_cb.payload;

    v_account := coalesce(v_cb.account_id,
        (SELECT account_id FROM account_mpesa_settings
          WHERE business_shortcode = v_p ->> 'BusinessShortCode' AND is_active
          ORDER BY environment DESC LIMIT 1));
    IF v_account IS NULL OR v_p ->> 'TransID' IS NULL THEN
        UPDATE mpesa_callbacks SET processed_at = now(),
               processing_error = 'Cannot resolve account or missing TransID'
         WHERE id = p_callback_id;
        RETURN NULL;
    END IF;

    v_ref := upper(regexp_replace(coalesce(v_p ->> 'BillRefNumber', ''), '\s', '', 'g'));

    SELECT l.id, l.tenant_id INTO v_lease_id, v_tenant_id
    FROM units u
    JOIN leases l ON l.unit_id = u.id AND l.status IN ('active', 'notice_given')
    WHERE u.account_id = v_account AND u.payment_code = v_ref
    LIMIT 1;

    IF v_tenant_id IS NULL THEN
        SELECT i.lease_id, i.tenant_id, i.id INTO v_lease_id, v_tenant_id, v_invoice_id
        FROM invoices i WHERE i.account_id = v_account AND i.invoice_number = v_ref;
    END IF;

    IF v_tenant_id IS NULL THEN
        SELECT l.id, l.tenant_id INTO v_lease_id, v_tenant_id
        FROM tenants t
        JOIN leases l ON l.tenant_id = t.id AND l.status IN ('active', 'notice_given')
        WHERE t.account_id = v_account AND t.id_document_number = v_ref
        ORDER BY l.start_date DESC LIMIT 1;
    END IF;

    INSERT INTO payments (account_id, tenant_id, lease_id, target_invoice_id, method, status, amount,
                          mpesa_receipt_number, payer_phone, payer_name, bill_ref_number,
                          callback_id, paid_at)
    VALUES (v_account, v_tenant_id, v_lease_id, v_invoice_id, 'mpesa_c2b', 'completed',
            (v_p ->> 'TransAmount')::numeric,
            upper(v_p ->> 'TransID'),
            v_p ->> 'MSISDN',
            nullif(btrim(coalesce(v_p ->> 'FirstName', '') || ' ' || coalesce(v_p ->> 'MiddleName', '')
                         || ' ' || coalesce(v_p ->> 'LastName', '')), ''),
            left(v_p ->> 'BillRefNumber', 30),
            p_callback_id,
            coalesce(to_timestamp(v_p ->> 'TransTime', 'YYYYMMDDHH24MISS')::timestamp
                        AT TIME ZONE 'Africa/Nairobi', now()))
    ON CONFLICT (mpesa_receipt_number) DO NOTHING
    RETURNING id INTO v_payment_id;

    UPDATE mpesa_callbacks
       SET processed_at = now(), account_id = v_account, trans_id = upper(v_p ->> 'TransID'),
           processing_error = CASE
               WHEN v_payment_id IS NULL THEN 'Duplicate TransID ignored'
               WHEN v_tenant_id IS NULL THEN format('Unmatched BillRefNumber "%s"', v_ref) END
     WHERE id = p_callback_id;

    RETURN v_payment_id;
END $$;

-- 14.10 Sweep STK prompts that never got a callback (run every minute) -------
CREATE FUNCTION fn_expire_stale_stk_requests(p_older_than interval DEFAULT interval '3 minutes')
RETURNS integer LANGUAGE sql AS $$
    WITH x AS (
        UPDATE mpesa_stk_requests
           SET status = 'timeout', result_desc = 'No callback received within window', completed_at = now()
         WHERE status IN ('initiated', 'pending') AND created_at < now() - p_older_than
        RETURNING 1
    ) SELECT count(*)::integer FROM x
$$;

-- =============================================================================
-- 15. TRIGGER FUNCTIONS
-- =============================================================================

-- 15.1 Units: auto-listing + guards -------------------------------------------
CREATE FUNCTION fn_units_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.payment_code := upper(btrim(coalesce(NEW.payment_code,
                              substr(replace(NEW.id::text, '-', ''), 1, 8))));

    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status = 'vacant' AND TG_OP = 'UPDATE' AND EXISTS (
            SELECT 1 FROM leases
            WHERE unit_id = NEW.id AND status IN ('active', 'notice_given', 'pending_signature')
        ) THEN
            RAISE EXCEPTION 'Unit % has a live lease; terminate it before marking vacant', NEW.unit_number
                USING ERRCODE = 'check_violation';
        END IF;

        NEW.status_changed_at := now();
        IF NEW.status = 'vacant' THEN
            NEW.is_listed_public := true;
            NEW.listed_at        := now();
        ELSE
            NEW.is_listed_public := false;
            NEW.listed_at        := NULL;
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION fn_units_after_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_property_name text;
    v_from          unit_status := CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NULL;
    END IF;

    INSERT INTO unit_status_history (unit_id, from_status, to_status, changed_by, reason)
    VALUES (NEW.id, v_from, NEW.status, app_current_user_id(),
            nullif(current_setting('app.change_reason', true), ''));

    IF TG_OP = 'UPDATE' AND NEW.status = 'vacant' THEN
        SELECT name INTO v_property_name FROM properties WHERE id = NEW.property_id;
        PERFORM fn_notify_account_staff(NEW.account_id, 'unit_vacant',
            format('Unit %s is now vacant', NEW.unit_number),
            format('%s, unit %s is vacant and listed publicly for onboarding (KES %s/month).',
                   v_property_name, NEW.unit_number, to_char(NEW.monthly_rent, 'FM999,999,990')),
            jsonb_build_object('unit_id', NEW.id, 'property_id', NEW.property_id));
    END IF;

    PERFORM fn_emit_event('unit_status_changed', NEW.account_id,
        jsonb_build_object('unit_id', NEW.id, 'property_id', NEW.property_id,
                           'from', v_from, 'to', NEW.status));
    RETURN NULL;
END $$;

CREATE FUNCTION fn_unit_condition_logs_after() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE units SET condition_summary = NEW.notes, condition_tags = NEW.tags WHERE id = NEW.unit_id;
    RETURN NULL;
END $$;

-- 15.2 Tenants: open chat once a tenant links an app login --------------------
CREATE FUNCTION fn_tenants_after_user_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id AND EXISTS (
        SELECT 1 FROM leases WHERE tenant_id = NEW.id AND status IN ('pending_signature', 'active', 'notice_given')
    ) THEN
        PERFORM fn_ensure_conversation(NEW.account_id, NEW.id);
    END IF;
    RETURN NULL;
END $$;

-- 15.3 Account members: keep staff in every tenant thread --------------------
CREATE FUNCTION fn_account_members_sync_chat() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        DELETE FROM conversation_participants cp
        USING conversations c
        WHERE cp.conversation_id = c.id AND c.account_id = OLD.account_id
          AND cp.user_id = OLD.user_id AND NOT cp.is_tenant;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.role IN ('owner', 'manager') THEN
        INSERT INTO conversation_participants (conversation_id, user_id, is_tenant)
        SELECT c.id, NEW.user_id, false FROM conversations c WHERE c.account_id = NEW.account_id
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NULL;
END $$;

-- 15.4 Leases: allocation lifecycle -------------------------------------------
CREATE FUNCTION fn_leases_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_unit_status unit_status;
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.lease_number := coalesce(NEW.lease_number, next_document_number(NEW.account_id, 'LSE'));
        NEW.created_by   := coalesce(NEW.created_by, app_current_user_id());
        SELECT coalesce(NEW.monthly_rent, u.monthly_rent), coalesce(NEW.deposit_amount, u.deposit_amount)
          INTO NEW.monthly_rent, NEW.deposit_amount
          FROM units u WHERE u.id = NEW.unit_id;
        SELECT coalesce(NEW.payment_due_days, a.default_payment_due_days)
          INTO NEW.payment_due_days
          FROM accounts a WHERE a.id = NEW.account_id;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.status IN ('terminated', 'expired') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'Lease % is closed and cannot be reopened', OLD.lease_number
            USING ERRCODE = 'check_violation';
    END IF;

    -- Tenant signature confirmation activates the lease (and billing) instantly.
    IF NEW.status = 'pending_signature' AND NEW.signed_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR OLD.signed_at IS NULL) THEN
        NEW.terms_sha256 := coalesce(NEW.terms_sha256,
                                     encode(digest(coalesce(NEW.terms_snapshot, ''), 'sha256'), 'hex'));
        NEW.status := 'active';
    END IF;

    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status IN ('pending_signature', 'active')
           AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('pending_signature', 'active', 'notice_given')) THEN
            SELECT status INTO v_unit_status FROM units WHERE id = NEW.unit_id FOR UPDATE;
            IF v_unit_status NOT IN ('vacant', 'reserved', 'cleaning') THEN
                RAISE EXCEPTION 'Unit is % and cannot be allocated', v_unit_status
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        CASE NEW.status
            WHEN 'active' THEN
                NEW.activated_at      := coalesce(NEW.activated_at, now());
                NEW.activated_by      := coalesce(NEW.activated_by, app_current_user_id());
                NEW.next_billing_date := coalesce(NEW.next_billing_date, NEW.start_date);
            WHEN 'notice_given' THEN
                NEW.notice_given_at := coalesce(NEW.notice_given_at, now());
            WHEN 'terminated', 'expired' THEN
                NEW.terminated_at := coalesce(NEW.terminated_at, now());
                IF NEW.end_date IS NULL OR NEW.end_date > nairobi_today() THEN
                    NEW.end_date := greatest(nairobi_today(), NEW.start_date + 1);
                END IF;
            ELSE
                NULL;
        END CASE;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION fn_leases_after_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_unit_number text;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NULL;
    END IF;

    CASE NEW.status
        WHEN 'pending_signature' THEN
            UPDATE units SET status = 'reserved'
             WHERE id = NEW.unit_id AND status IN ('vacant', 'cleaning');
            PERFORM fn_ensure_conversation(NEW.account_id, NEW.tenant_id);

        WHEN 'active' THEN
            UPDATE units SET status = 'occupied' WHERE id = NEW.unit_id AND status <> 'occupied';
            PERFORM fn_ensure_conversation(NEW.account_id, NEW.tenant_id);
            PERFORM fn_generate_lease_invoices(NEW.id);
            SELECT unit_number INTO v_unit_number FROM units WHERE id = NEW.unit_id;
            PERFORM fn_notify_account_staff(NEW.account_id, 'lease_activated',
                format('Lease %s is active', NEW.lease_number),
                format('Unit %s is now occupied; billing has started.', v_unit_number),
                jsonb_build_object('lease_id', NEW.id, 'unit_id', NEW.unit_id));

        WHEN 'draft' THEN
            IF TG_OP = 'UPDATE' AND OLD.status = 'pending_signature' THEN
                UPDATE units SET status = 'vacant' WHERE id = NEW.unit_id AND status = 'reserved';
            END IF;

        WHEN 'terminated', 'expired' THEN
            IF NOT EXISTS (
                SELECT 1 FROM leases
                WHERE unit_id = NEW.unit_id AND id <> NEW.id
                  AND status IN ('pending_signature', 'active', 'notice_given')
            ) THEN
                UPDATE units SET status = 'cleaning'
                 WHERE id = NEW.unit_id AND status IN ('occupied', 'reserved');
            END IF;

        ELSE
            NULL;
    END CASE;

    PERFORM fn_emit_event('lease_status_changed', NEW.account_id,
        jsonb_build_object('lease_id', NEW.id, 'unit_id', NEW.unit_id, 'tenant_id', NEW.tenant_id,
                           'from', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, 'to', NEW.status));
    RETURN NULL;
END $$;

-- 15.5 Invoices ----------------------------------------------------------------
CREATE FUNCTION fn_invoices_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    SELECT l.tenant_id, l.unit_id, coalesce(NEW.vat_rate, l.vat_rate)
      INTO NEW.tenant_id, NEW.unit_id, NEW.vat_rate
      FROM leases l WHERE l.id = NEW.lease_id AND l.account_id = NEW.account_id;
    IF NEW.tenant_id IS NULL THEN
        RAISE EXCEPTION 'Lease % not found for account %', NEW.lease_id, NEW.account_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.invoice_number := coalesce(NEW.invoice_number, next_document_number(NEW.account_id, 'INV'));
    NEW.created_by     := coalesce(NEW.created_by, app_current_user_id());
    IF NEW.status = 'void' THEN
        RAISE EXCEPTION 'Cannot create a void invoice' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION fn_invoices_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'void' AND NEW.status <> 'void' THEN
        RAISE EXCEPTION 'Invoice % is void', OLD.invoice_number USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'void' AND OLD.status <> 'void' THEN
        NEW.voided_at := coalesce(NEW.voided_at, now());
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION fn_invoices_after_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NULL;
    END IF;
    IF NEW.status = 'overdue' THEN
        PERFORM fn_notify_tenant(NEW.tenant_id, 'invoice_overdue',
            format('Invoice %s is overdue', NEW.invoice_number),
            format('Outstanding balance KES %s was due on %s.',
                   to_char(NEW.balance, 'FM999,999,990.00'), to_char(NEW.due_date, 'DD Mon YYYY')),
            jsonb_build_object('invoice_id', NEW.id));
    END IF;
    PERFORM fn_emit_event('invoice_status_changed', NEW.account_id,
        jsonb_build_object('invoice_id', NEW.id, 'unit_id', NEW.unit_id, 'tenant_id', NEW.tenant_id,
                           'from', OLD.status, 'to', NEW.status, 'balance', NEW.balance));
    RETURN NULL;
END $$;

CREATE FUNCTION fn_invoice_items_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM invoices
               WHERE id = coalesce(NEW.invoice_id, OLD.invoice_id) AND status = 'void') THEN
        RAISE EXCEPTION 'Cannot modify items on a void invoice' USING ERRCODE = 'check_violation';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$;

CREATE FUNCTION fn_invoice_items_after() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM fn_refresh_invoice(coalesce(NEW.invoice_id, OLD.invoice_id));
    IF TG_OP = 'UPDATE' AND NEW.invoice_id <> OLD.invoice_id THEN
        PERFORM fn_refresh_invoice(OLD.invoice_id);
    END IF;
    RETURN NULL;
END $$;

-- 15.6 Payments & allocations --------------------------------------------------
CREATE FUNCTION fn_payments_after_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_ref text := coalesce(NEW.mpesa_receipt_number, NEW.external_reference, '-');
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status = 'reversed' AND OLD.status <> 'reversed' THEN
        DELETE FROM payment_allocations WHERE payment_id = NEW.id;
    END IF;

    IF NEW.status = 'completed' AND NEW.tenant_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR OLD.status <> 'completed' OR OLD.tenant_id IS NULL) THEN
        PERFORM fn_allocate_payment(NEW.id);
        PERFORM fn_notify_tenant(NEW.tenant_id, 'payment_received', 'Payment received',
            format('We received KES %s (ref %s). Thank you.', to_char(NEW.amount, 'FM999,999,990.00'), v_ref),
            jsonb_build_object('payment_id', NEW.id));
        PERFORM fn_notify_account_staff(NEW.account_id, 'payment_received',
            format('KES %s received', to_char(NEW.amount, 'FM999,999,990.00')),
            format('%s payment, ref %s.', replace(NEW.method::text, '_', ' '), v_ref),
            jsonb_build_object('payment_id', NEW.id, 'tenant_id', NEW.tenant_id),
            '{owner,manager,accountant}');
    ELSIF TG_OP = 'INSERT' AND NEW.status = 'completed' AND NEW.tenant_id IS NULL THEN
        PERFORM fn_notify_account_staff(NEW.account_id, 'payment_unmatched',
            format('Unmatched payment KES %s', to_char(NEW.amount, 'FM999,999,990.00')),
            format('Ref %s, account no. "%s". Assign it to a tenant.', v_ref, coalesce(NEW.bill_ref_number, '')),
            jsonb_build_object('payment_id', NEW.id),
            '{owner,manager,accountant}');
    END IF;

    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
        PERFORM fn_emit_event('payment_recorded', NEW.account_id,
            jsonb_build_object('payment_id', NEW.id, 'tenant_id', NEW.tenant_id,
                               'status', NEW.status, 'amount', NEW.amount));
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION fn_payment_allocations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM payments p JOIN invoices i ON i.id = NEW.invoice_id
        WHERE p.id = NEW.payment_id AND p.status = 'completed'
          AND p.account_id = i.account_id AND p.tenant_id = i.tenant_id AND i.status <> 'void'
    ) THEN
        RAISE EXCEPTION 'Payment % cannot be allocated to invoice %', NEW.payment_id, NEW.invoice_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION fn_payment_allocations_after() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_payment uuid := coalesce(NEW.payment_id, OLD.payment_id);
    v_invoice uuid := coalesce(NEW.invoice_id, OLD.invoice_id);
BEGIN
    UPDATE payments
       SET allocated_amount = (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = v_payment)
     WHERE id = v_payment;
    PERFORM fn_refresh_invoice(v_invoice);
    RETURN NULL;
END $$;

CREATE FUNCTION fn_receipts_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.receipt_number := coalesce(NEW.receipt_number, next_document_number(NEW.account_id, 'RCT'));
    RETURN NEW;
END $$;

-- 15.7 Issues (caretaker elimination) -----------------------------------------
CREATE FUNCTION fn_issues_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.property_id := (SELECT property_id FROM units WHERE id = NEW.unit_id AND account_id = NEW.account_id);
        IF NEW.property_id IS NULL THEN
            RAISE EXCEPTION 'Unit % does not belong to account %', NEW.unit_id, NEW.account_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        NEW.ticket_number := coalesce(NEW.ticket_number, next_document_number(NEW.account_id, 'TKT'));
        NEW.reported_by   := coalesce(NEW.reported_by, app_current_user_id());
        IF NEW.tenant_id IS NULL THEN
            SELECT l.tenant_id, l.id INTO NEW.tenant_id, NEW.lease_id
            FROM leases l
            WHERE l.unit_id = NEW.unit_id AND l.status IN ('active', 'notice_given')
            LIMIT 1;
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
        CASE NEW.status
            WHEN 'received' THEN
                NEW.resolved_at := NULL; NEW.closed_at := NULL;
            WHEN 'under_review', 'in_progress' THEN
                NEW.acknowledged_at := coalesce(NEW.acknowledged_at, now());
                NEW.resolved_at := NULL; NEW.closed_at := NULL;
            WHEN 'dispatched_contractor' THEN
                NEW.acknowledged_at := coalesce(NEW.acknowledged_at, now());
                NEW.dispatched_at   := coalesce(NEW.dispatched_at, now());
                NEW.resolved_at := NULL; NEW.closed_at := NULL;
            WHEN 'resolved' THEN
                NEW.acknowledged_at := coalesce(NEW.acknowledged_at, now());
                NEW.resolved_at     := coalesce(NEW.resolved_at, now());
            WHEN 'closed' THEN
                NEW.resolved_at := coalesce(NEW.resolved_at, now());
                NEW.closed_at   := coalesce(NEW.closed_at, now());
            WHEN 'rejected' THEN
                NEW.closed_at := coalesce(NEW.closed_at, now());
        END CASE;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION fn_issues_after_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_reason text := nullif(current_setting('app.change_reason', true), '');
    v_label  text := initcap(replace(NEW.status::text, '_', ' '));
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO issue_updates (issue_id, author_id, from_status, to_status, comment)
        VALUES (NEW.id, NEW.reported_by, NULL, NEW.status, 'Issue reported');
        PERFORM fn_notify_account_staff(NEW.account_id, 'issue_created',
            format('%s issue %s (%s)', initcap(replace(NEW.category::text, '_', ' ')),
                   NEW.ticket_number, NEW.priority),
            NEW.title,
            jsonb_build_object('issue_id', NEW.id, 'unit_id', NEW.unit_id, 'priority', NEW.priority));
        PERFORM fn_emit_event('issue_created', NEW.account_id,
            jsonb_build_object('issue_id', NEW.id, 'unit_id', NEW.unit_id, 'priority', NEW.priority));
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO issue_updates (issue_id, author_id, from_status, to_status, comment)
        VALUES (NEW.id, app_current_user_id(), OLD.status, NEW.status, v_reason);
        IF NEW.tenant_id IS NOT NULL THEN
            PERFORM fn_notify_tenant(NEW.tenant_id, 'issue_updated',
                format('Ticket %s: %s', NEW.ticket_number, v_label),
                coalesce(v_reason, format('Your %s issue "%s" is now %s.',
                         replace(NEW.category::text, '_', ' '), NEW.title, lower(v_label))),
                jsonb_build_object('issue_id', NEW.id, 'status', NEW.status));
        END IF;
        PERFORM fn_emit_event('issue_status_changed', NEW.account_id,
            jsonb_build_object('issue_id', NEW.id, 'tenant_id', NEW.tenant_id,
                               'contractor_id', NEW.assigned_contractor_id,
                               'from', OLD.status, 'to', NEW.status));
    END IF;

    -- Resolved work with a cost becomes a maintenance expense automatically.
    IF NEW.status IN ('resolved', 'closed') AND coalesce(NEW.actual_cost, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM maintenance_expenses WHERE issue_id = NEW.id) THEN
        INSERT INTO maintenance_expenses (account_id, property_id, unit_id, issue_id, contractor_id,
                                          category, description, amount, incurred_on, recorded_by)
        VALUES (NEW.account_id, NEW.property_id, NEW.unit_id, NEW.id, NEW.assigned_contractor_id,
                NEW.category, left(format('%s: %s', NEW.ticket_number, NEW.title), 250),
                NEW.actual_cost, (coalesce(NEW.resolved_at, now()) AT TIME ZONE 'Africa/Nairobi')::date,
                app_current_user_id());
    END IF;
    RETURN NULL;
END $$;

-- 15.8 Chat & calls -------------------------------------------------------------
CREATE FUNCTION fn_messages_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.sender_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_participants
        WHERE conversation_id = NEW.conversation_id AND user_id = NEW.sender_id
    ) THEN
        RAISE EXCEPTION 'User % is not a participant in conversation %', NEW.sender_id, NEW.conversation_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION fn_messages_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_account uuid;
BEGIN
    UPDATE conversations
       SET last_message_at = NEW.created_at,
           last_message_preview = left(CASE NEW.message_type
                WHEN 'text'       THEN NEW.body
                WHEN 'image'      THEN 'Photo'
                WHEN 'video'      THEN 'Video'
                WHEN 'audio_note' THEN 'Voice note'
                WHEN 'file'       THEN 'Attachment'
                ELSE coalesce(NEW.body, 'Update') END, 140)
     WHERE id = NEW.conversation_id
    RETURNING account_id INTO v_account;

    UPDATE conversation_participants
       SET last_read_message_id = NEW.id, last_read_at = NEW.created_at
     WHERE conversation_id = NEW.conversation_id AND user_id = NEW.sender_id;

    PERFORM fn_emit_event('chat_message', v_account,
        jsonb_build_object('conversation_id', NEW.conversation_id, 'message_id', NEW.id,
                           'sender_id', NEW.sender_id, 'type', NEW.message_type));
    RETURN NULL;
END $$;

CREATE FUNCTION fn_calls_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF (SELECT count(*) FROM conversation_participants
             WHERE conversation_id = NEW.conversation_id AND user_id IN (NEW.caller_id, NEW.callee_id)) < 2 THEN
            RAISE EXCEPTION 'Caller and callee must both be participants of the conversation'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status IN ('ended', 'missed', 'rejected', 'failed') THEN
            RAISE EXCEPTION 'Call % already finished', OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status = 'ongoing' THEN
            NEW.answered_at := coalesce(NEW.answered_at, now());
        ELSIF NEW.status IN ('ended', 'missed', 'rejected', 'failed') THEN
            NEW.ended_at := coalesce(NEW.ended_at, now());
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION fn_calls_after_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_account uuid;
    v_label   text := CASE NEW.call_type WHEN 'video' THEN 'Video call' ELSE 'Voice call' END;
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       OR NEW.status NOT IN ('ended', 'missed', 'rejected', 'failed') THEN
        RETURN NULL;
    END IF;

    INSERT INTO messages (conversation_id, sender_id, message_type, body, call_id)
    VALUES (NEW.conversation_id, NEW.caller_id, 'call_log',
            CASE NEW.status
                WHEN 'ended'    THEN format('%s · %s', v_label,
                                     to_char(make_interval(secs => coalesce(NEW.duration_seconds, 0)), 'MI:SS'))
                WHEN 'missed'   THEN format('Missed %s', lower(v_label))
                WHEN 'rejected' THEN format('%s declined', v_label)
                ELSE format('%s failed to connect', v_label) END,
            NEW.id);

    IF NEW.status = 'missed' THEN
        SELECT account_id INTO v_account FROM conversations WHERE id = NEW.conversation_id;
        INSERT INTO notifications (user_id, account_id, type, title, body, data)
        SELECT NEW.callee_id, v_account, 'missed_call', format('Missed %s', lower(v_label)),
               format('From %s', u.full_name),
               jsonb_build_object('call_id', NEW.id, 'conversation_id', NEW.conversation_id)
        FROM users u WHERE u.id = NEW.caller_id;
    END IF;
    RETURN NULL;
END $$;

-- 15.9 Notifications -> realtime ----------------------------------------------
CREATE FUNCTION fn_notifications_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM fn_emit_event('notification', NEW.account_id,
        jsonb_build_object('notification_id', NEW.id, 'user_id', NEW.user_id, 'type', NEW.type));
    RETURN NULL;
END $$;

-- 15.10 Generic row audit -------------------------------------------------------
CREATE FUNCTION fn_audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_old     jsonb;
    v_new     jsonb;
    v_changes jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW); v_changes := v_new;
    ELSIF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD); v_changes := v_old;
    ELSE
        v_new := to_jsonb(NEW); v_old := to_jsonb(OLD);
        SELECT jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
          INTO v_changes
          FROM jsonb_each(v_new) n
          JOIN jsonb_each(v_old) o ON o.key = n.key
         WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('updated_at', 'search_vector');
        IF v_changes IS NULL THEN
            RETURN NULL;
        END IF;
    END IF;

    INSERT INTO audit_logs (account_id, actor_id, action, entity_type, entity_id, changes, ip_address)
    VALUES ((coalesce(v_new, v_old) ->> 'account_id')::uuid, app_current_user_id(), lower(TG_OP),
            TG_TABLE_NAME, coalesce(v_new, v_old) ->> 'id', v_changes,
            nullif(current_setting('app.client_ip', true), '')::inet);
    RETURN NULL;
END $$;

-- =============================================================================
-- 16. TRIGGER WIRING
-- =============================================================================
CREATE TRIGGER trg_units_before_write     BEFORE INSERT OR UPDATE ON units
    FOR EACH ROW EXECUTE FUNCTION fn_units_before_write();
CREATE TRIGGER trg_units_after_status     AFTER INSERT OR UPDATE OF status ON units
    FOR EACH ROW EXECUTE FUNCTION fn_units_after_status();
CREATE TRIGGER trg_unit_condition_logs    AFTER INSERT ON unit_condition_logs
    FOR EACH ROW EXECUTE FUNCTION fn_unit_condition_logs_after();

CREATE TRIGGER trg_tenants_user_link      AFTER UPDATE OF user_id ON tenants
    FOR EACH ROW EXECUTE FUNCTION fn_tenants_after_user_link();
CREATE TRIGGER trg_account_members_chat   AFTER INSERT OR UPDATE OR DELETE ON account_members
    FOR EACH ROW EXECUTE FUNCTION fn_account_members_sync_chat();

CREATE TRIGGER trg_leases_before_write    BEFORE INSERT OR UPDATE ON leases
    FOR EACH ROW EXECUTE FUNCTION fn_leases_before_write();
-- Plain UPDATE (not UPDATE OF status): signing flips status inside the BEFORE
-- trigger, and column-specific triggers only see columns named in the SET list.
CREATE TRIGGER trg_leases_after_status    AFTER INSERT OR UPDATE ON leases
    FOR EACH ROW EXECUTE FUNCTION fn_leases_after_status();

CREATE TRIGGER trg_invoices_before_insert BEFORE INSERT ON invoices
    FOR EACH ROW EXECUTE FUNCTION fn_invoices_before_insert();
CREATE TRIGGER trg_invoices_before_update BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION fn_invoices_before_update();
CREATE TRIGGER trg_invoices_after_update  AFTER UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION fn_invoices_after_update();
CREATE TRIGGER trg_invoice_items_guard    BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
    FOR EACH ROW EXECUTE FUNCTION fn_invoice_items_guard();
CREATE TRIGGER trg_invoice_items_after    AFTER INSERT OR UPDATE OR DELETE ON invoice_items
    FOR EACH ROW EXECUTE FUNCTION fn_invoice_items_after();

CREATE TRIGGER trg_payments_after_write   AFTER INSERT OR UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION fn_payments_after_write();
CREATE TRIGGER trg_payment_alloc_guard    BEFORE INSERT ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION fn_payment_allocations_guard();
CREATE TRIGGER trg_payment_alloc_after    AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION fn_payment_allocations_after();
CREATE TRIGGER trg_receipts_before_insert BEFORE INSERT ON receipts
    FOR EACH ROW EXECUTE FUNCTION fn_receipts_before_insert();

CREATE TRIGGER trg_issues_before_write    BEFORE INSERT OR UPDATE ON issues
    FOR EACH ROW EXECUTE FUNCTION fn_issues_before_write();
CREATE TRIGGER trg_issues_after_write     AFTER INSERT OR UPDATE ON issues
    FOR EACH ROW EXECUTE FUNCTION fn_issues_after_write();

CREATE TRIGGER trg_messages_before_insert BEFORE INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION fn_messages_before_insert();
CREATE TRIGGER trg_messages_after_insert  AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION fn_messages_after_insert();
CREATE TRIGGER trg_calls_before_write     BEFORE INSERT OR UPDATE ON call_sessions
    FOR EACH ROW EXECUTE FUNCTION fn_calls_before_write();
CREATE TRIGGER trg_calls_after_update     AFTER UPDATE OF status ON call_sessions
    FOR EACH ROW EXECUTE FUNCTION fn_calls_after_update();

CREATE TRIGGER trg_notifications_realtime AFTER INSERT ON notifications
    FOR EACH ROW EXECUTE FUNCTION fn_notifications_after_insert();

-- Audit trail on financially / legally sensitive tables.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tenants', 'leases', 'units', 'invoices', 'payments',
                             'payment_allocations', 'maintenance_expenses', 'account_members']
    LOOP
        EXECUTE format('CREATE TRIGGER trg_zz_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                        FOR EACH ROW EXECUTE FUNCTION fn_audit_row()', t);
    END LOOP;
END $$;

-- updated_at maintenance on every table that has the column.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.relname
        FROM pg_attribute a
        JOIN pg_class c     ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r'
          AND a.attname = 'updated_at' AND NOT a.attisdropped
    LOOP
        EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I
                        FOR EACH ROW EXECUTE FUNCTION set_updated_at()', r.relname, r.relname);
    END LOOP;
END $$;

-- =============================================================================
-- 17. REPORTING & READ-MODEL VIEWS
-- =============================================================================

-- Public marketplace: vacant units, searchable by county / area / type / price.
CREATE VIEW v_public_vacancies AS
SELECT u.id              AS unit_id,
       u.unit_number,
       u.unit_type,
       u.bedrooms,
       u.bathrooms,
       u.size_sqm,
       u.monthly_rent,
       u.deposit_amount,
       u.features,
       u.condition_tags,
       u.listed_at,
       p.id              AS property_id,
       p.account_id,
       p.name            AS property_name,
       p.property_type,
       p.area,
       p.ward,
       p.landmark,
       p.latitude,
       p.longitude,
       p.amenities,
       c.id              AS county_id,
       c.name            AS county_name,
       sc.name           AS sub_county_name,
       cover.storage_key AS cover_image_key
FROM units u
JOIN properties p        ON p.id = u.property_id AND p.is_active
JOIN counties c          ON c.id = p.county_id
LEFT JOIN sub_counties sc ON sc.id = p.sub_county_id
LEFT JOIN LATERAL (
    SELECT m.storage_key
    FROM unit_media um
    JOIN media_files m ON m.id = um.media_id AND m.deleted_at IS NULL
    WHERE um.unit_id = u.id
    ORDER BY um.is_cover DESC, um.sort_order
    LIMIT 1
) cover ON true
WHERE u.is_listed_public AND u.status = 'vacant';

-- Live financial state of every unit (arrears, current tenant).
CREATE VIEW v_unit_financials AS
SELECT u.id                                   AS unit_id,
       u.account_id,
       u.property_id,
       u.unit_number,
       u.status                               AS unit_status,
       u.monthly_rent,
       l.id                                   AS lease_id,
       l.tenant_id,
       t.full_name                            AS tenant_name,
       t.phone                                AS tenant_phone,
       coalesce(f.total_invoiced, 0)          AS total_invoiced,
       coalesce(f.total_paid, 0)              AS total_paid,
       coalesce(f.outstanding, 0)             AS outstanding_balance,
       f.oldest_unpaid_due_date,
       greatest(nairobi_today() - f.oldest_unpaid_due_date, 0) AS days_in_arrears,
       CASE WHEN coalesce(f.outstanding, 0) = 0             THEN 'clear'
            WHEN f.oldest_unpaid_due_date < nairobi_today() THEN 'in_arrears'
            ELSE 'due' END                    AS financial_state,
       coalesce(cr.credit, 0)                 AS tenant_credit
FROM units u
LEFT JOIN leases l  ON l.unit_id = u.id AND l.status IN ('active', 'notice_given')
LEFT JOIN tenants t ON t.id = l.tenant_id
LEFT JOIN LATERAL (
    SELECT sum(i.total_amount) AS total_invoiced,
           sum(i.amount_paid)  AS total_paid,
           sum(i.balance)      AS outstanding,
           min(i.due_date) FILTER (WHERE i.balance > 0) AS oldest_unpaid_due_date
    FROM invoices i
    WHERE i.lease_id = l.id AND i.status NOT IN ('draft', 'void')
) f ON true
LEFT JOIN LATERAL (
    SELECT sum(p.unallocated_amount) AS credit
    FROM payments p
    WHERE p.tenant_id = l.tenant_id AND p.status = 'completed' AND p.unallocated_amount > 0
) cr ON true;

-- Tenant statement with running balance (source for PDF/CSV statements).
CREATE VIEW v_tenant_ledger AS
WITH entries AS (
    SELECT i.account_id, i.tenant_id, i.lease_id,
           i.issue_date        AS entry_date,
           i.created_at        AS entry_ts,
           'invoice'::text     AS entry_type,
           i.id                AS ref_id,
           i.invoice_number::text AS reference,
           format('Invoice %s (%s to %s)', i.invoice_number,
                  to_char(i.period_start, 'DD Mon YYYY'), to_char(i.period_end, 'DD Mon YYYY')) AS description,
           i.total_amount      AS debit,
           0::numeric(14,2)    AS credit
    FROM invoices i
    WHERE i.status NOT IN ('draft', 'void')
    UNION ALL
    SELECT p.account_id, p.tenant_id, p.lease_id,
           (p.paid_at AT TIME ZONE 'Africa/Nairobi')::date,
           p.paid_at,
           'payment',
           p.id,
           coalesce(p.mpesa_receipt_number, p.external_reference, r.receipt_number)::text,
           format('Payment via %s%s', replace(p.method::text, '_', ' '),
                  CASE WHEN r.receipt_number IS NOT NULL THEN ' - receipt ' || r.receipt_number ELSE '' END),
           0::numeric(14,2),
           p.amount
    FROM payments p
    LEFT JOIN receipts r ON r.payment_id = p.id
    WHERE p.status = 'completed' AND p.tenant_id IS NOT NULL
)
SELECT e.*,
       sum(e.debit - e.credit) OVER (
           PARTITION BY e.account_id, e.tenant_id
           ORDER BY e.entry_date, e.entry_ts, e.entry_type
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS running_balance
FROM entries e;

-- Defaulters list with aging buckets.
CREATE VIEW v_defaulters AS
SELECT i.account_id,
       t.id                 AS tenant_id,
       t.full_name          AS tenant_name,
       t.phone              AS tenant_phone,
       l.id                 AS lease_id,
       l.status             AS lease_status,
       p.id                 AS property_id,
       p.name               AS property_name,
       u.unit_number,
       count(*)             AS overdue_invoices,
       sum(i.balance)       AS amount_overdue,
       min(i.due_date)      AS oldest_due_date,
       nairobi_today() - min(i.due_date) AS max_days_overdue,
       CASE WHEN nairobi_today() - min(i.due_date) > 90 THEN '90+'
            WHEN nairobi_today() - min(i.due_date) > 60 THEN '61-90'
            WHEN nairobi_today() - min(i.due_date) > 30 THEN '31-60'
            ELSE '1-30' END AS aging_bucket,
       (SELECT max(pm.paid_at) FROM payments pm
         WHERE pm.tenant_id = t.id AND pm.status = 'completed') AS last_payment_at
FROM invoices i
JOIN tenants t    ON t.id = i.tenant_id
JOIN leases l     ON l.id = i.lease_id
JOIN units u      ON u.id = i.unit_id
JOIN properties p ON p.id = u.property_id
WHERE i.status IN ('issued', 'partially_paid', 'overdue')
  AND i.balance > 0
  AND i.due_date < nairobi_today()
GROUP BY i.account_id, t.id, t.full_name, t.phone, l.id, l.status, p.id, p.name, u.unit_number;

-- Monthly revenue: billed vs collected vs maintenance, per property.
CREATE VIEW v_monthly_revenue AS
WITH facts AS (
    SELECT i.account_id, u.property_id,
           date_trunc('month', i.period_start::timestamp)::date AS month,
           i.total_amount AS invoiced, 0::numeric AS collected, 0::numeric AS mpesa_collected,
           0 AS payment_count, 0::numeric AS maintenance_cost
    FROM invoices i JOIN units u ON u.id = i.unit_id
    WHERE i.status NOT IN ('draft', 'void')
    UNION ALL
    SELECT p.account_id, u.property_id,
           date_trunc('month', p.paid_at AT TIME ZONE 'Africa/Nairobi')::date,
           0, p.amount,
           CASE WHEN p.method IN ('mpesa_stk', 'mpesa_c2b') THEN p.amount ELSE 0 END,
           1, 0
    FROM payments p
    LEFT JOIN leases l ON l.id = p.lease_id
    LEFT JOIN units u  ON u.id = l.unit_id
    WHERE p.status = 'completed'
    UNION ALL
    SELECT e.account_id, e.property_id,
           date_trunc('month', e.incurred_on::timestamp)::date,
           0, 0, 0, 0, e.amount
    FROM maintenance_expenses e
)
SELECT f.account_id,
       f.property_id,
       pr.name                         AS property_name,     -- NULL = unmatched payments
       f.month,
       sum(f.invoiced)                 AS invoiced,
       sum(f.collected)                AS collected,
       sum(f.mpesa_collected)          AS mpesa_collected,
       sum(f.payment_count)::integer   AS payment_count,
       sum(f.maintenance_cost)         AS maintenance_cost,
       sum(f.collected) - sum(f.maintenance_cost) AS net_operating_income,
       round(100 * sum(f.collected) / nullif(sum(f.invoiced), 0), 1) AS collection_rate_pct
FROM facts f
LEFT JOIN properties pr ON pr.id = f.property_id
GROUP BY f.account_id, f.property_id, pr.name, f.month;

-- Maintenance overhead by property / month / category.
CREATE VIEW v_maintenance_overhead AS
SELECT e.account_id,
       e.property_id,
       p.name                     AS property_name,
       date_trunc('month', e.incurred_on::timestamp)::date AS month,
       e.category,
       count(*)                   AS expense_count,
       count(DISTINCT e.issue_id) AS linked_issues,
       sum(e.amount)              AS total_cost
FROM maintenance_expenses e
JOIN properties p ON p.id = e.property_id
GROUP BY e.account_id, e.property_id, p.name, date_trunc('month', e.incurred_on::timestamp)::date, e.category;

-- Occupancy & rent roll per property (dashboard cards).
CREATE VIEW v_property_occupancy AS
SELECT p.account_id,
       p.id    AS property_id,
       p.name  AS property_name,
       p.county_id,
       p.area,
       count(u.id)                                              AS total_units,
       count(u.id) FILTER (WHERE u.status = 'occupied')          AS occupied,
       count(u.id) FILTER (WHERE u.status = 'vacant')            AS vacant,
       count(u.id) FILTER (WHERE u.status = 'reserved')          AS reserved,
       count(u.id) FILTER (WHERE u.status = 'under_maintenance') AS under_maintenance,
       count(u.id) FILTER (WHERE u.status = 'cleaning')          AS cleaning,
       round(100.0 * count(u.id) FILTER (WHERE u.status = 'occupied') / nullif(count(u.id), 0), 1)
                                                                AS occupancy_rate_pct,
       coalesce(sum(u.monthly_rent) FILTER (WHERE u.status = 'occupied'), 0) AS actual_rent_roll,
       coalesce(sum(u.monthly_rent), 0)                          AS potential_rent_roll
FROM properties p
LEFT JOIN units u ON u.property_id = p.id AND u.status <> 'inactive'
                 AND NOT EXISTS (SELECT 1 FROM units b WHERE b.parent_unit_id = u.id)  -- count hostel beds, not rooms
WHERE p.is_active
GROUP BY p.account_id, p.id, p.name, p.county_id, p.area;

COMMIT;
