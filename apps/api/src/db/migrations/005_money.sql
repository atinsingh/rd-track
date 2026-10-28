-- Stage 3 "Money" (competitive gap analysis §Stage 3 item 2): clients, effective-dated pay
-- and bill rates, project budgets with once-only alerts, invoices and payroll exports.
--
-- Money is integer cents in an ISO-4217 currency. Hours on invoices and payroll are derived
-- from seconds: summed per line, rounded to the nearest minute (half up), then to hours
-- with two decimals (half up); amount = hours × hourly rate, rounded to the cent (half up);
-- tax = subtotal × tax_rate_bp / 10 000, rounded to the cent (half up). See
-- packages/contracts/src/money.ts (`billableHours`, `lineAmountCents`, `taxCents`).
--
-- Rates are never overwritten: a change is a new row with a later `effective_from`.
-- The rate for a session is the newest row whose `effective_from` is on or before the
-- session's start date in the employee's timezone.

-- ───────────── clients ─────────────
CREATE TABLE clients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  contact_email    text,
  currency         text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  address          text,
  archived         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

ALTER TABLE projects ADD COLUMN client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX projects_client ON projects (client_id) WHERE client_id IS NOT NULL;
-- Budgets and invoices read time per project.
CREATE INDEX work_sessions_project_time ON work_sessions (organization_id, project_id, started_at) WHERE project_id IS NOT NULL;

-- ───────────── rates (effective-dated, append-only history) ─────────────
CREATE TABLE pay_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents     integer NOT NULL CHECK (amount_cents >= 0),   -- per hour
  currency         text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from   date NOT NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, effective_from)
);
CREATE INDEX pay_rates_org ON pay_rates (organization_id, user_id, effective_from DESC);

CREATE TABLE bill_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,  -- NULL = project default
  amount_cents     integer NOT NULL CHECK (amount_cents >= 0),   -- per hour
  currency         text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from   date NOT NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bill_rates_unique ON bill_rates (project_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);
CREATE INDEX bill_rates_org ON bill_rates (organization_id, project_id, effective_from DESC);

-- Rate history is append-only: amounts and dates never change once written (only the
-- `created_by` reference may be cleared when that user is removed).
CREATE FUNCTION rates_immutable() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'created_by') IS DISTINCT FROM (to_jsonb(OLD) - 'created_by') THEN
    RAISE EXCEPTION '% rows are append-only; add a new rate with a later effective_from', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pay_rates_no_update BEFORE UPDATE ON pay_rates FOR EACH ROW EXECUTE FUNCTION rates_immutable();
CREATE TRIGGER bill_rates_no_update BEFORE UPDATE ON bill_rates FOR EACH ROW EXECUTE FUNCTION rates_immutable();

-- ───────────── budgets ─────────────
CREATE TABLE project_budgets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('hours', 'amount')),
  -- seconds for an hours budget, cents (in `currency`) for an amount budget
  limit_value       bigint NOT NULL CHECK (limit_value > 0),
  currency          text CHECK (currency ~ '^[A-Z]{3}$'),
  alert_thresholds  integer[] NOT NULL DEFAULT '{80,100}',
  stop_at_budget    boolean NOT NULL DEFAULT false,
  resets            text NOT NULL DEFAULT 'never' CHECK (resets IN ('monthly', 'never')),
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'amount') = (currency IS NOT NULL))
);

-- Each threshold alerts once per budget period ('all' for budgets that never reset, 'YYYY-MM' otherwise).
CREATE TABLE budget_alerts_sent (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  budget_id        uuid NOT NULL REFERENCES project_budgets(id) ON DELETE CASCADE,
  threshold        integer NOT NULL,
  period           text NOT NULL,
  sent_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (budget_id, threshold, period)
);

-- ───────────── invoices ─────────────
CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  number           text,                       -- assigned on issue: INV-YYYY-NNNN, gap-free per org and year
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  period_from      date NOT NULL,
  period_to        date NOT NULL,              -- inclusive
  timezone         text NOT NULL DEFAULT 'UTC',
  group_by         text NOT NULL DEFAULT 'project' CHECK (group_by IN ('project', 'project_person')),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_cents   bigint NOT NULL DEFAULT 0,
  tax_rate_bp      integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  tax_cents        bigint NOT NULL DEFAULT 0,
  total_cents      bigint NOT NULL DEFAULT 0,
  issued_at        timestamptz,
  due_date         date,
  notes            text,
  voided_at        timestamptz,
  void_reason      text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number),
  CHECK (period_to >= period_from),
  CHECK (status = 'draft' OR (number IS NOT NULL AND issued_at IS NOT NULL))
);
CREATE INDEX invoices_org ON invoices (organization_id, created_at DESC);

CREATE TABLE invoice_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id       uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position         integer NOT NULL,
  project_id       uuid REFERENCES projects(id) ON DELETE SET NULL,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  description      text NOT NULL,
  hours            numeric(10,2) NOT NULL CHECK (hours >= 0),
  rate_cents       integer NOT NULL CHECK (rate_cents >= 0),
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0)
);
CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id, position);

-- Issuing locks an invoice: totals and lines change only while it is a draft; afterwards the
-- only allowed change is issued → void. Foreign keys that are cleared when a referenced
-- user or project is removed (ON DELETE SET NULL) are the one exception.
CREATE FUNCTION invoices_lock() RETURNS trigger AS $$
DECLARE
  fixed text[] := ARRAY['status', 'voided_at', 'void_reason', 'updated_at', 'created_by'];
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - fixed) IS DISTINCT FROM (to_jsonb(OLD) - fixed)
     OR (OLD.status = 'issued' AND NEW.status NOT IN ('issued', 'void'))
     OR (OLD.status = 'void' AND (NEW.status <> 'void' OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
                                  OR NEW.void_reason IS DISTINCT FROM OLD.void_reason)) THEN
    RAISE EXCEPTION 'invoice % is %; it can only be voided', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_locked BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_lock();

CREATE FUNCTION invoice_lines_lock() RETURNS trigger AS $$
DECLARE
  st text;
  refs text[] := ARRAY['project_id', 'user_id'];
BEGIN
  SELECT status INTO st FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  -- No parent row: the invoice itself is being deleted (draft delete or tenant offboarding).
  IF st IS NULL OR st = 'draft' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - refs) = (to_jsonb(OLD) - refs)
     AND (NEW.project_id IS NULL OR NEW.project_id = OLD.project_id)
     AND (NEW.user_id IS NULL OR NEW.user_id = OLD.user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invoice lines are locked once the invoice is issued';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_lines_locked BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_lock();

-- ───────────── payroll exports (same job + object storage + 24 h expiry pattern as export_jobs) ─────────────
CREATE TABLE payroll_exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requester_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_from      date NOT NULL,
  period_to        date NOT NULL,              -- inclusive
  timezone         text NOT NULL DEFAULT 'UTC',
  user_ids         uuid[],                     -- NULL = everyone with time in the period
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  object_key       text,
  row_count        integer,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz,
  CHECK (period_to >= period_from)
);
CREATE INDEX payroll_exports_org ON payroll_exports (organization_id, created_at DESC);

-- ───────────── row-level security (ADR-0004) ─────────────
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clients USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE pay_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_rates USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE bill_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bill_rates USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE project_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_budgets USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE budget_alerts_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_alerts_sent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget_alerts_sent USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_lines USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE payroll_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_exports USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
