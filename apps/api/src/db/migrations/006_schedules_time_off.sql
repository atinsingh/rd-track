-- Stage 3: schedules, attendance, time off and holidays (gap analysis §"Stage 3 scope" item 3).
--
-- Attendance is NOT stored: it is computed on read from shifts, overrides, holidays,
-- approved leave and work sessions, so a late correction or a newly approved leave changes
-- it everywhere at once and there is no cache to invalidate.
-- Dates are calendar days (`date`) in the person's shift time zone; instants stay timestamptz.

-- Organization-wide scheduling settings (one row per organization, created on first write).
CREATE TABLE scheduling_settings (
  organization_id            uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  late_grace_minutes         integer NOT NULL DEFAULT 10 CHECK (late_grace_minutes BETWEEN 0 AND 240),
  early_leave_grace_minutes  integer NOT NULL DEFAULT 10 CHECK (early_leave_grace_minutes BETWEEN 0 AND 240),
  -- Hours a full day of leave costs on a weekday when the person has no shift.
  default_day_hours          numeric(4, 2) NOT NULL DEFAULT 8 CHECK (default_day_hours > 0 AND default_day_hours <= 24),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Recurring schedule: on each ISO weekday in `weekdays`, from start_time to end_time in
-- `timezone`. end_time <= start_time means the shift ends the next day (overnight); it
-- belongs to the day it starts on.
CREATE TABLE shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timezone         text NOT NULL,
  weekdays         smallint[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  effective_from   date NOT NULL,
  effective_to     date,                        -- inclusive last day; NULL = open-ended
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time <> end_time),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX shifts_user ON shifts (organization_id, user_id, effective_from);

-- One-off change for one person on one day: a different time, or no shift at all.
CREATE TABLE shift_overrides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date             date NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('change', 'cancel')),
  timezone         text NOT NULL,
  start_time       time,
  end_time         time,
  note             text,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, date),
  CHECK (kind = 'cancel' OR (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time <> end_time))
);

-- Organization holidays; team_id limits one to a team (NULL = everyone).
CREATE TABLE holidays (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  date             date NOT NULL,
  name             text NOT NULL,
  team_id          uuid REFERENCES teams(id) ON DELETE CASCADE,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX holidays_unique ON holidays (organization_id, date, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE time_off_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('paid', 'unpaid')),
  accrual            text NOT NULL DEFAULT 'none' CHECK (accrual IN ('none', 'per_month', 'per_year')),
  accrual_hours      numeric(7, 2) NOT NULL DEFAULT 0 CHECK (accrual_hours >= 0),
  max_balance_hours  numeric(7, 2) CHECK (max_balance_hours IS NULL OR max_balance_hours >= 0),
  -- Hours that survive into a new calendar year; NULL = everything carries over.
  carryover_hours    numeric(7, 2) CHECK (carryover_hours IS NULL OR carryover_hours >= 0),
  allow_negative     boolean NOT NULL DEFAULT false,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE time_off_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  policy_id        uuid NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date       date NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, user_id)
);
CREATE INDEX time_off_assignments_user ON time_off_assignments (user_id);

CREATE TABLE time_off_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id        uuid NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  -- Set for a part of one day; NULL = full days (hours computed from the schedule).
  partial_hours    numeric(5, 2) CHECK (partial_hours IS NULL OR (partial_hours > 0 AND partial_hours <= 24)),
  hours            numeric(7, 2) NOT NULL CHECK (hours > 0),
  reason           text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  review_note      text,
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (partial_hours IS NULL OR start_date = end_date)
);
CREATE INDEX time_off_requests_user ON time_off_requests (organization_id, user_id, start_date);
CREATE INDEX time_off_requests_pending ON time_off_requests (organization_id) WHERE status = 'pending';

-- Balance = sum(hours). Append-only in practice: approvals add `usage` (negative),
-- cancelling approved leave adds `usage_reversal`; accruals are unique per period.
CREATE TABLE time_off_ledger (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id        uuid NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('accrual', 'usage', 'usage_reversal', 'adjustment', 'carryover_expiry')),
  hours            numeric(7, 2) NOT NULL,
  effective_date   date NOT NULL,
  period           text,                         -- 'YYYY-MM' / 'YYYY' for accruals and expiry
  request_id       uuid REFERENCES time_off_requests(id) ON DELETE SET NULL,
  note             text,
  created_by       uuid REFERENCES users(id),     -- NULL = the accrual job
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_off_ledger_balance ON time_off_ledger (user_id, policy_id);
-- The accrual job may run any number of times: one accrual / expiry per person, policy and period.
CREATE UNIQUE INDEX time_off_ledger_period ON time_off_ledger (policy_id, user_id, kind, period)
  WHERE kind IN ('accrual', 'carryover_expiry');
CREATE UNIQUE INDEX time_off_ledger_request ON time_off_ledger (request_id, kind) WHERE request_id IS NOT NULL;

ALTER TABLE scheduling_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scheduling_settings USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shifts USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE shift_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shift_overrides USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON holidays USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE time_off_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON time_off_policies USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE time_off_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON time_off_assignments USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE time_off_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON time_off_requests USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE time_off_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON time_off_ledger USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
