-- Slice 5a (docs/design/07-product-review.md, G2): support access that the tenant approves.
-- An operator asks with a reason and a duration; an org admin approves or declines; an
-- approved grant runs for that many hours from approval and can be ended by either side.
-- While it runs the operator can read the tenant's configuration (people, teams,
-- devices, policies, audit log) — never activity, apps, screenshots or money — and every
-- read is written to the tenant's own audit log.

SELECT set_config('rd.org_id', '*', true);

ALTER TABLE support_access_grants
  ALTER COLUMN expires_at DROP NOT NULL,
  ADD COLUMN requested_hours integer NOT NULL DEFAULT 4 CHECK (requested_hours BETWEEN 1 AND 72),
  ADD COLUMN status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'ended')),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN ended_by text CHECK (ended_by IN ('tenant', 'operator')),
  ADD CONSTRAINT support_grants_expiry CHECK (status <> 'approved' OR expires_at IS NOT NULL);

CREATE INDEX support_grants_org ON support_access_grants (organization_id, created_at DESC);
