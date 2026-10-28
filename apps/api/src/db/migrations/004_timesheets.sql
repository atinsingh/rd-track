-- Stage 3 (gap analysis, "Workforce operations" item 1): weekly timesheets with approval,
-- daily/weekly work limits and overtime.
--
-- A timesheet covers one ISO week in the employee's time zone: `period_start` is the
-- Monday, and the week runs from local midnight Monday to local midnight the next Monday
-- (`(period_start::timestamp AT TIME ZONE timezone)`, so DST weeks are 167 or 169 hours).
-- The zone is pinned when the row is created so later profile changes don't move the
-- boundaries of a submitted or approved week. Weeks without a row are drafts.
-- An approved timesheet locks its week: corrections and manual time for sessions that
-- start in it are refused (409 timesheet_locked) until an approver reopens it.

CREATE TABLE timesheets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start      date NOT NULL CHECK (extract(isodow FROM period_start) = 1),
  timezone          text NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'reopened')),
  submitted_at      timestamptz,
  reviewed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  note              text,
  -- what the employee submitted, and the frozen record at approval (TimesheetTotals)
  submitted_totals  jsonb,
  approved_totals   jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, period_start),
  CHECK (status <> 'approved' OR approved_totals IS NOT NULL)
);
CREATE INDEX timesheets_org_status ON timesheets (organization_id, status);
CREATE INDEX timesheets_user_period ON timesheets (user_id, period_start);

CREATE TABLE timesheet_events (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  timesheet_id     uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  action           text NOT NULL CHECK (action IN ('submit', 'approve', 'reject', 'reopen')),
  actor_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  note             text,
  -- totals at the time of the event (submit and approve)
  totals           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timesheet_events_sheet ON timesheet_events (timesheet_id, id);

-- Effective-dated limits. user_id NULL = organization default (a NULL field means no limit);
-- a per-user row overrides it (a NULL field inherits the organization default). The row in
-- force for a week is the latest one with effective_from <= the week's Sunday.
CREATE TABLE work_limits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  daily_minutes    integer CHECK (daily_minutes BETWEEN 1 AND 1440),
  weekly_minutes   integer CHECK (weekly_minutes BETWEEN 1 AND 10080),
  effective_from   date NOT NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (organization_id, user_id, effective_from)
);
CREATE INDEX work_limits_lookup ON work_limits (organization_id, user_id, effective_from DESC);

ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE timesheet_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheet_events USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE work_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_limits USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
