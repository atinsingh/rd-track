-- Stage 4 F9: a read-only portal for an agency's clients. Client contacts are not users:
-- they have their own sign-in and sessions, never hold a seat or a role, and can only read
-- their own projects' hours, budgets and issued invoices.

-- Whether the client sees who worked on their projects (names and hours each), or totals only.
ALTER TABLE clients ADD COLUMN portal_show_people boolean NOT NULL DEFAULT false;

CREATE TABLE client_contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id          uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email              text NOT NULL,
  display_name       text NOT NULL,
  password_hash      text,
  -- A sign-in link (the invite, or a new one to reset the password): single use, 7 days.
  link_token_hash    text UNIQUE,
  link_expires_at    timestamptz,
  invited_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  invited_at         timestamptz,
  last_sign_in_at    timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- Sign-in is by email alone, so an address has one live portal login across the service.
CREATE UNIQUE INDEX client_contacts_email ON client_contacts (lower(email)) WHERE revoked_at IS NULL;
CREATE INDEX client_contacts_client ON client_contacts (client_id);

CREATE TABLE client_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES client_contacts(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz
);
CREATE INDEX client_sessions_contact ON client_sessions (contact_id);

ALTER TABLE client_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_contacts USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
ALTER TABLE client_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_sessions USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check
  CHECK (actor_type IN ('user', 'device', 'system', 'platform', 'directory', 'api_token', 'client'));
