-- Family (docs/design/08-family-plan.md, phase 1): transparent parental controls on Track's engine.
-- A family is an organization of kind 'family'; parents are org_admin; each child is a user with
-- org_role 'child' (never signs in, never emailed) and a child_profiles row. Family rules are a
-- family-wide document plus per-child overrides, delivered signed to the child's devices.

SELECT set_config('rd.org_id', '*', true);

ALTER TABLE organizations ADD COLUMN kind text NOT NULL DEFAULT 'business' CHECK (kind IN ('business', 'family'));

-- What a signup creates: a workforce organization or a family.
ALTER TABLE signup_requests ADD COLUMN kind text NOT NULL DEFAULT 'business' CHECK (kind IN ('business', 'family'));

ALTER TABLE users DROP CONSTRAINT users_org_role_check;
ALTER TABLE users ADD CONSTRAINT users_org_role_check
  CHECK (org_role IN ('employee', 'org_admin', 'auditor', 'super_admin', 'finance', 'child'));

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_plan_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check CHECK (plan IN ('free', 'standard', 'pro', 'family'));

CREATE TABLE child_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  birth_year       integer NOT NULL CHECK (birth_year BETWEEN 1900 AND 2100),
  birth_month      integer NOT NULL CHECK (birth_month BETWEEN 1 AND 12),
  region           text NOT NULL CHECK (region IN ('CA', 'CA-QC', 'US', 'GB', 'EU', 'OTHER')),
  color            text NOT NULL DEFAULT 'amber',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX child_profiles_org ON child_profiles (organization_id);
ALTER TABLE child_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE child_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON child_profiles USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- One document for the family (child_user_id NULL) and at most one per child. A field a child's
-- document sets replaces the family's; see resolveFamilyRules in the contracts.
CREATE TABLE family_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  child_user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  document         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE NULLS NOT DISTINCT (organization_id, child_user_id)
);
ALTER TABLE family_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON family_rules USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- Connecting a child's computer (doc 08): the parent signs in and confirms for a child, so the
-- enrollment code is for the child (user_id) while the parent approved it.
ALTER TABLE device_link_requests ADD COLUMN approved_by uuid REFERENCES users(id) ON DELETE SET NULL;
