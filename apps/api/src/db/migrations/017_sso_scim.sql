-- Slice 6 (docs/design/07-product-review.md, G26): single sign-on through the
-- organization's identity provider (OpenID Connect) and directory provisioning (SCIM 2.0).
--
-- An organization proves it owns an email domain with a DNS TXT record. Verified domains
-- route sign-in to its identity provider and allow accounts to be created on first
-- sign-in. A domain can be verified by one organization only.

SELECT set_config('rd.org_id', '*', true);

CREATE TABLE sso_domains (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain              text NOT NULL CHECK (domain = lower(domain)),
  verification_token  text NOT NULL,
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, domain)
);
CREATE UNIQUE INDEX sso_domains_verified ON sso_domains (domain) WHERE verified_at IS NOT NULL;
ALTER TABLE sso_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sso_domains USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- One OpenID Connect connection per organization. It stays a draft until an admin has
-- signed in through it once (the test), so a typo can't lock anyone out.
CREATE TABLE sso_connections (
  organization_id    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  issuer             text NOT NULL,
  client_id          text NOT NULL,
  client_secret_enc  text NOT NULL,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
  -- Everyone signs in through the identity provider; org admins keep password + MFA as a
  -- way back in if the provider breaks.
  enforced           boolean NOT NULL DEFAULT false,
  -- Create an account (employee, tracking off) the first time someone from a verified
  -- domain signs in.
  jit_provisioning   boolean NOT NULL DEFAULT false,
  tested_at          timestamptz,
  tested_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'active' OR NOT enforced)
);
ALTER TABLE sso_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sso_connections USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- A sign-in in flight: single use, ten minutes, bound to the browser that started it.
-- Read before anyone is signed in, so it has no row-level security (like signup_requests).
CREATE TABLE sso_login_states (
  state_hash       text PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nonce            text NOT NULL,
  code_verifier    text NOT NULL,
  browser_hash     text NOT NULL,
  -- Set when an admin is testing the connection.
  test_by          uuid REFERENCES users(id) ON DELETE CASCADE,
  return_to        text,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz
);
CREATE INDEX sso_login_states_expiry ON sso_login_states (expires_at);

-- The identity provider's stable id for a person, bound at their first SSO sign-in, and
-- the directory's id for them (SCIM externalId).
ALTER TABLE users ADD COLUMN sso_subject text;
ALTER TABLE users ADD COLUMN external_id text;
CREATE UNIQUE INDEX users_sso_subject ON users (organization_id, sso_subject) WHERE sso_subject IS NOT NULL;
CREATE UNIQUE INDEX users_external_id ON users (organization_id, external_id) WHERE external_id IS NOT NULL;
ALTER TABLE teams ADD COLUMN external_id text;
CREATE UNIQUE INDEX teams_external_id ON teams (organization_id, external_id) WHERE external_id IS NOT NULL;

-- Bearer tokens for the organization's directory (SCIM). Only the hash is kept.
CREATE TABLE scim_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,
  label            text NOT NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz
);
CREATE INDEX scim_tokens_org ON scim_tokens (organization_id);
ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scim_tokens USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- Changes made by the directory are audited as the directory (actor_id = the SCIM token).
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IN ('user', 'device', 'system', 'platform', 'directory'));
