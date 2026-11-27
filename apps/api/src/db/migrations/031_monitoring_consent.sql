-- Monitoring agreement (EULA) shown by the desktop app before it tracks anything.
--
-- consent_agreements: the organization's agreement versions. No row means version 1 with
-- the generated text. A new version is added when a published policy collects more
-- (policy/service.ts, collectionExpansions) or an admin edits or resets the text; each
-- person must accept the newest version before their computers may track again.
--
-- consent_records: every accept and decline, append-only, with the version, a hash of the
-- exact text shown (and the text itself), the IP the server saw, the user and the device.
-- Like audit_logs, rows are only removed when the whole organization is deleted.

SELECT set_config('rd.org_id', '*', true);

CREATE TABLE consent_agreements (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version          integer NOT NULL CHECK (version >= 2),
  -- The admin's own text; NULL = generated from the effective policy.
  custom_text      text CHECK (custom_text IS NULL OR length(custom_text) BETWEEN 1 AND 20000),
  reason           text NOT NULL CHECK (reason IN ('policy_expansion', 'text_edited', 'text_reset')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, version)
);
ALTER TABLE consent_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_agreements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consent_agreements USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

CREATE TABLE consent_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Order of arrival: the newest answer wins, even within the same instant.
  seq              bigserial NOT NULL,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id),
  device_id        uuid NOT NULL REFERENCES devices(id),
  version          integer NOT NULL CHECK (version >= 1),
  decision         text NOT NULL CHECK (decision IN ('accepted', 'declined')),
  text_sha256      text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  text             text NOT NULL,
  ip               text NOT NULL,
  decided_at       timestamptz NOT NULL
);
CREATE INDEX consent_records_user ON consent_records (organization_id, user_id, seq DESC);
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consent_records USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

CREATE FUNCTION consent_records_append_only() RETURNS trigger AS $$
BEGIN
  -- Deleting the whole organization (lifecycle/service.ts) sets this flag, as for audit_logs.
  IF TG_OP = 'DELETE' AND current_setting('rd.allow_audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'consent_records is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER consent_records_no_update BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION consent_records_append_only();
