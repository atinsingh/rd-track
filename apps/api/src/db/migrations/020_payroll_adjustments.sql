-- Stage 4 F8 (docs/design/06-stage-4-scope.md): payroll adjustments. A bonus, deduction or
-- reimbursement for one person, once (in the pay period containing its date) or every pay
-- period from its date (until it ends). They appear as their own columns in the payroll
-- file; the person sees their own. Amounts never go into the audit log.

SELECT set_config('rd.org_id', '*', true);

CREATE TABLE payroll_adjustments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('bonus', 'deduction', 'reimbursement')),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  note             text NOT NULL,
  recurrence       text NOT NULL CHECK (recurrence IN ('once', 'every_period')),
  effective_from   date NOT NULL,
  -- Every period only: the last day it applies (inclusive); NULL = until ended.
  effective_to     date,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (recurrence = 'every_period' OR effective_to IS NULL),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX payroll_adjustments_user ON payroll_adjustments (organization_id, user_id, effective_from DESC);
ALTER TABLE payroll_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_adjustments USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
