-- Stage 4 F5 (docs/design/06-stage-4-scope.md): API tokens. An organization token is
-- created by an org admin (read, optionally write and payroll; up to a year); a personal
-- token by anyone, read-only and limited to their own data (up to 90 days). A token acts
-- as its creator, so it never sees more than they could. Only a hash is kept.

SELECT set_config('rd.org_id', '*', true);

CREATE TABLE api_tokens (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('organization', 'personal')),
  name                text NOT NULL,
  -- The creator, whose access the token carries.
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes              text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'write', 'payroll'] AND 'read' = ANY(scopes)),
  token_hash          text NOT NULL UNIQUE,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  expiry_notified_at  timestamptz,
  revoked_at          timestamptz,
  revoked_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (kind = 'organization' OR scopes = ARRAY['read'])
);
CREATE INDEX api_tokens_org ON api_tokens (organization_id, created_at DESC);
ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_tokens USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- Calls made with a token are audited as the token (actor_id = the token), on behalf of its creator.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IN ('user', 'device', 'system', 'platform', 'directory', 'api_token'));
