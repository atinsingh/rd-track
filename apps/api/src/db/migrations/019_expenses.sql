-- Stage 4 F7 (docs/design/06-stage-4-scope.md): expenses. An employee claims what they
-- spent for work, with an optional receipt in private object storage; their team manager
-- (or an org admin) approves it in the approvals inbox. Approved expenses are reimbursed in
-- the payroll file for the period they were approved in, and billable ones on a client's
-- project go on that client's next draft invoice.

SELECT set_config('rd.org_id', '*', true);

CREATE TABLE expenses (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id               uuid REFERENCES projects(id) ON DELETE SET NULL,
  category                 text NOT NULL CHECK (category IN ('travel', 'meals', 'equipment', 'software', 'training', 'other')),
  amount_cents             bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000),
  currency                 text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  spent_on                 date NOT NULL,
  note                     text NOT NULL,
  billable                 boolean NOT NULL DEFAULT false,
  receipt_key              text,
  receipt_content_type     text,
  receipt_size             integer,
  status                   text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at              timestamptz,
  review_note              text,
  -- The pay period whose payroll file reimbursed it (set when that file is made).
  reimbursed_period_from   date,
  reimbursed_period_to     date,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT billable OR project_id IS NOT NULL)
);
CREATE INDEX expenses_user ON expenses (organization_id, user_id, spent_on DESC);
CREATE INDEX expenses_pending ON expenses (organization_id, status) WHERE status = 'pending';
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expenses USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- An invoice line made from an expense remembers it, so an expense is billed once.
ALTER TABLE invoice_lines ADD COLUMN expense_id uuid REFERENCES expenses(id) ON DELETE SET NULL;
CREATE INDEX invoice_lines_expense ON invoice_lines (expense_id) WHERE expense_id IS NOT NULL;
