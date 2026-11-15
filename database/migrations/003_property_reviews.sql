-- =============================================================================
--  Migration 003 · Verified tenant reviews
--  Only someone who actually rented in a building can rate it: the tenant
--  record must belong to the reviewer's login and have a signed lease on a unit
--  in that property that has run for at least 30 days. One review per tenant
--  per property (editable); the landlord can post one public reply.
--  Run: psql -d kodi -v ON_ERROR_STOP=1 -f database/migrations/003_property_reviews.sql
-- =============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS property_reviews (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    property_id     uuid          NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    tenant_id       uuid          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    author_user_id  uuid          REFERENCES users(id) ON DELETE SET NULL,
    rating          smallint      NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         varchar(1000),
    landlord_reply  varchar(1000),
    replied_at      timestamptz,
    replied_by      uuid          REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (property_id, tenant_id),
    CHECK ((landlord_reply IS NULL) = (replied_at IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_property_reviews_property ON property_reviews (property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_property_reviews_account  ON property_reviews (account_id, created_at DESC);

COMMIT;
