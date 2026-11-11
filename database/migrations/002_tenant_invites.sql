-- =============================================================================
--  Migration 002 · Tenant invitations (Phase 2)
--  A landlord-issued, single-use link is how a tenant record gets linked to an
--  app login. Linking by phone number alone would let anyone who registers
--  with a tenant's number see that tenant's lease, invoices and chat.
--  Run: psql -d kodi -v ON_ERROR_STOP=1 -f database/migrations/002_tenant_invites.sql
-- =============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS tenant_invites (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    token_hash   char(64)    NOT NULL UNIQUE,          -- sha256 hex; raw token only ever in the link
    created_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
    expires_at   timestamptz NOT NULL,
    accepted_at  timestamptz,
    accepted_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS ix_tenant_invites_open
    ON tenant_invites (tenant_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMIT;
