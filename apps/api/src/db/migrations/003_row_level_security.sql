-- Stage 2: row-level security as defence in depth (ADR-0004).
--
-- The API sets `rd.org_id` on its connection to the organization of the authenticated
-- user or device for every request; public, platform and worker code paths use '*'
-- (system scope, needed for cross-tenant lookups such as login by email, device
-- credential lookup and retention). An unset value matches nothing (default deny).
-- FORCE applies the policies to the table owner too; superusers still bypass RLS, so
-- production must not connect as a superuser (RDS master users are not superusers).

CREATE FUNCTION rd_org_visible(org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN current_setting('rd.org_id', true) = '*' THEN true
    WHEN current_setting('rd.org_id', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN org = current_setting('rd.org_id', true)::uuid
    ELSE false
  END
$$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations USING (rd_org_visible(id)) WITH CHECK (rd_org_visible(id));

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE seat_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE seat_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON seat_usage_daily USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_sessions USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teams USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE team_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON team_memberships USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON projects USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_memberships USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tasks USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE enrollment_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON enrollment_codes USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON devices USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE policy_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policy_receipts USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policies USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policy_versions USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE work_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_sessions USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE session_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON session_transitions USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE activity_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON activity_buckets USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE app_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_usage USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE data_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_gaps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_gaps USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE screenshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE screenshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON screenshots USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE time_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON time_corrections USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deletion_requests USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON legal_holds USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_jobs USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_logs USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE ingest_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingest_events USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON jobs USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_access_grants USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
