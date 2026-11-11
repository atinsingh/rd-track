-- G26 (P2): the organization's own logo, and deploying the desktop app with MDM.

-- A logo shown next to the product mark (rail, client portal, invoices). PNG, JPEG or WebP.
ALTER TABLE organizations ADD COLUMN logo_key text, ADD COLUMN logo_content_type text, ADD COLUMN logo_updated_at timestamptz;

-- Deployment keys (Pro): IT puts one in the deployment file on managed computers, so a
-- person connects with their work email and an emailed code instead of a code from an admin.
CREATE TABLE deployment_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  key_hash         text NOT NULL UNIQUE,
  -- Last four characters, to tell keys apart.
  hint             text NOT NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz
);
CREATE INDEX deployment_keys_org ON deployment_keys (organization_id);
ALTER TABLE deployment_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deployment_keys USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
