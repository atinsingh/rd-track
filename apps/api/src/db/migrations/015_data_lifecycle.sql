-- Slice 5b/5c (docs/design/07-product-review.md, G17–G18): data lifecycle.
--
-- data_exports: a ZIP of an organization's records (org admins, at any time and before
-- closing) or of one person's own data (5c). Files live in object storage for 24 hours.
--
-- Closing an organization schedules its deletion CLOSE_GRACE_DAYS ahead; an org admin
-- can cancel until then. At that time everything the organization owns is deleted
-- (rows and stored files) and a deletion certificate is kept outside the tenant, since
-- the tenant no longer exists to hold it.

SELECT set_config('rd.org_id', '*', true);

CREATE TABLE data_exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('organization', 'person')),
  -- 'person' exports: whose data. Always the requester for self-service exports.
  subject_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  requested_by     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  object_key       text,
  size_bytes       bigint,
  file_count       integer,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz,
  CHECK (kind = 'organization' OR subject_user_id IS NOT NULL)
);
CREATE INDEX data_exports_org ON data_exports (organization_id, created_at DESC);
ALTER TABLE data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_exports USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE organizations
  ADD COLUMN deletion_scheduled_at  timestamptz,
  ADD COLUMN deletion_requested_at  timestamptz,
  ADD COLUMN deletion_requested_by  uuid REFERENCES users(id) ON DELETE SET NULL;

-- Kept by RoundDigital after the organization is gone: what was deleted and when. No
-- tenant data beyond the organization's name and who asked; never RLS-scoped, because
-- the tenant it describes no longer exists.
CREATE TABLE deletion_certificates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  organization_name     text NOT NULL,
  organization_slug     text NOT NULL,
  requested_by_email    text,
  requested_at          timestamptz,
  deleted_at            timestamptz NOT NULL,
  rows_deleted          jsonb NOT NULL,
  objects_deleted       integer NOT NULL,
  backups_expire_by     timestamptz NOT NULL,
  digest                text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
