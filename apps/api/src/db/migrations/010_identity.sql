-- Engine slice 2 (docs/design/07-product-review.md §5): invites, password reset, email
-- change and MFA recovery. Nobody is ever shown someone else's password.

SELECT set_config('rd.org_id', '*', true);

-- Single-use links sent by email. Only the hash is stored; issuing a new one for the same
-- person and purpose cancels the old one.
CREATE TABLE auth_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose          text NOT NULL CHECK (purpose IN ('invite', 'password_reset', 'email_change')),
  token_hash       text NOT NULL UNIQUE,
  data             jsonb NOT NULL DEFAULT '{}',
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz
);
CREATE INDEX auth_tokens_user ON auth_tokens (user_id, purpose) WHERE used_at IS NULL;
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_tokens USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- One-time recovery codes for multi-factor authentication, stored hashed.
CREATE TABLE mfa_recovery_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash        text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  used_at          timestamptz
);
CREATE INDEX mfa_recovery_codes_user ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mfa_recovery_codes USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- When the person was last invited; a NULL password_hash means they haven't accepted yet.
ALTER TABLE users ADD COLUMN invited_at timestamptz;
