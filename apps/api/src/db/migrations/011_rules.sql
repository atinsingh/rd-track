-- Engine slice 3 (docs/design/07-product-review.md §3): rules that run on a schedule.
-- Timesheet deadlines are off until an org admin turns them on.

SELECT set_config('rd.org_id', '*', true);

CREATE TABLE timesheet_rules (
  organization_id       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled               boolean NOT NULL DEFAULT false,
  -- Due on this ISO weekday (1 = Monday) of the week after, at due_time in each person's zone.
  due_weekday           smallint NOT NULL DEFAULT 1 CHECK (due_weekday BETWEEN 1 AND 7),
  due_time              time NOT NULL DEFAULT '10:00',
  -- Reviewers get one digest this many hours after the deadline; 0 = never.
  escalate_after_hours  integer NOT NULL DEFAULT 24 CHECK (escalate_after_hours BETWEEN 0 AND 168),
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE timesheet_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheet_rules USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
