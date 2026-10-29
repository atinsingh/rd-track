-- Engine slice 1 (docs/design/07-product-review.md §3): domain events, one notification
-- service with categories, deep links, preferences and email, and terms at signup.

SELECT set_config('rd.org_id', '*', true);

-- Every meaningful change, written in the same transaction as the change itself.
-- `dedupe_key` makes milestone events (trial ends in 7 days, …) happen once.
CREATE TABLE domain_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type             text NOT NULL,
  subject_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  data             jsonb NOT NULL DEFAULT '{}',
  dedupe_key       text,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);
CREATE INDEX domain_events_org_time ON domain_events (organization_id, occurred_at DESC);
ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON domain_events USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- Notifications gain a category (for preferences), a deep link, the event that caused
-- them (one notification per person per event) and when the email went out.
ALTER TABLE notifications ADD COLUMN category text NOT NULL DEFAULT 'privacy';
ALTER TABLE notifications ADD COLUMN link text;
ALTER TABLE notifications ADD COLUMN event_id uuid REFERENCES domain_events(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN emailed_at timestamptz;
-- false when the person turned in-app off for the category but still gets the email.
ALTER TABLE notifications ADD COLUMN in_app boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX notifications_event_user ON notifications (event_id, user_id) WHERE event_id IS NOT NULL;
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL AND in_app;
UPDATE notifications SET category = CASE kind
  WHEN 'schedule_change' THEN 'schedule'
  WHEN 'time_off_adjustment' THEN 'schedule'
  WHEN 'time_off_request' THEN 'approvals'
  WHEN 'timesheet_review' THEN 'my_requests'
  WHEN 'project_budget' THEN 'budgets'
  ELSE 'privacy' END;

-- A person's choices per category; no row = the defaults in @rd/contracts.
CREATE TABLE notification_preferences (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category         text NOT NULL,
  in_app           boolean NOT NULL,
  email            boolean NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preferences USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- Which version of the subscription terms and DPA the organization accepted, and who.
ALTER TABLE organizations ADD COLUMN terms_version text;
ALTER TABLE organizations ADD COLUMN terms_accepted_at timestamptz;
ALTER TABLE organizations ADD COLUMN terms_accepted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE signup_requests ADD COLUMN terms_version text;
