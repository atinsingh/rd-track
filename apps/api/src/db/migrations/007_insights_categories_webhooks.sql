-- Stage 3: work-app categories (ACT-07) and outbound webhooks (INT-03).
-- Insights are computed on read from existing tables and need no storage.

-- Team- or organization-level classification of apps. Context for people, never a score.
CREATE TABLE app_categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id          uuid REFERENCES teams(id) ON DELETE CASCADE,
  app_identifier   text NOT NULL,
  category         text NOT NULL CHECK (category IN ('core_work', 'supporting', 'communication', 'break')),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_categories_scope ON app_categories (organization_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(app_identifier));

CREATE TABLE webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url              text NOT NULL CHECK (url LIKE 'https://%'),
  description      text,
  events           text[] NOT NULL,
  secret_enc       text NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint_id       uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id          uuid NOT NULL,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts          integer NOT NULL DEFAULT 0,
  last_status_code  integer,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz
);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at DESC);

ALTER TABLE app_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_categories USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_endpoints USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_deliveries USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));
