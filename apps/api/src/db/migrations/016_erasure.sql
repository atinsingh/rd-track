-- Slice 5c (docs/design/07-product-review.md, G18): a person asks to have their data
-- erased; an org admin decides. Erasure deletes what Track measured about them (activity,
-- app names, screenshots, idle and gap records, devices' names, notifications, sign-in
-- material) except anything under a legal hold, deactivates them, and replaces their
-- name and email. Records the organization must keep for pay and billing (sessions,
-- timesheets, time off, corrections, invoices) stay, attached to the erased placeholder.

SELECT set_config('rd.org_id', '*', true);

ALTER TABLE users ADD COLUMN erased_at timestamptz;

CREATE TABLE erasure_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'completed')),
  decided_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  decline_reason   text,
  completed_at     timestamptz,
  -- What was deleted, and what a legal hold kept (counts only).
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX erasure_requests_open ON erasure_requests (user_id) WHERE status IN ('pending', 'approved');
CREATE INDEX erasure_requests_org ON erasure_requests (organization_id, created_at DESC);
ALTER TABLE erasure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON erasure_requests USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
