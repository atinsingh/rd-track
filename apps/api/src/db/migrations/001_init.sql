-- RoundDigital Track — initial schema (system design §4, commercial model §6).
-- All timestamps are timestamptz (UTC). Every business table carries organization_id.

-- ───────────── tenants & billing ─────────────
CREATE TABLE organizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  slug             text NOT NULL UNIQUE,
  region           text NOT NULL DEFAULT 'ca-central-1',
  policy_revision  integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  organization_id           uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan                      text NOT NULL CHECK (plan IN ('free', 'standard', 'pro')),
  status                    text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'grace', 'inactive', 'canceled')),
  seats                     integer NOT NULL DEFAULT 0 CHECK (seats >= 0),
  billing_interval          text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  price_per_seat_cents      integer,
  trial_ends_at             timestamptz,
  grace_ends_at             timestamptz,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  provider                  text NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual', 'stripe')),
  provider_customer_id      text,
  provider_subscription_id  text,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seat_usage_daily (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day              date NOT NULL,
  billable_seats   integer NOT NULL,
  viewer_seats     integer NOT NULL,
  PRIMARY KEY (organization_id, day)
);

-- ───────────── identity ─────────────
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email             text NOT NULL,
  display_name      text NOT NULL,
  password_hash     text,
  org_role          text NOT NULL DEFAULT 'employee' CHECK (org_role IN ('employee', 'org_admin', 'auditor', 'super_admin')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  tracking_enabled  boolean NOT NULL DEFAULT true,
  mfa_secret_enc    text,
  mfa_enabled       boolean NOT NULL DEFAULT false,
  timezone          text NOT NULL DEFAULT 'UTC',
  created_at        timestamptz NOT NULL DEFAULT now(),
  deactivated_at    timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_org ON users (organization_id);

CREATE TABLE user_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,
  mfa_verified     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);

CREATE TABLE teams (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- Memberships are never rewritten: moving teams closes one row and opens another (IAM-07).
CREATE TABLE team_memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id          uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('member', 'manager')),
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz
);
CREATE UNIQUE INDEX team_memberships_current ON team_memberships (team_id, user_id) WHERE valid_to IS NULL;
CREATE INDEX team_memberships_user ON team_memberships (user_id) WHERE valid_to IS NULL;

CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  client_ref       text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE project_memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('member', 'manager')),
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz
);
CREATE UNIQUE INDEX project_memberships_current ON project_memberships (project_id, user_id) WHERE valid_to IS NULL;

CREATE TABLE tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  UNIQUE (project_id, name)
);

-- ───────────── devices ─────────────
CREATE TABLE enrollment_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash        text NOT NULL UNIQUE,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz
);

CREATE TABLE devices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  os                       text NOT NULL CHECK (os IN ('windows', 'macos', 'linux')),
  os_version               text NOT NULL,
  agent_version            text NOT NULL,
  credential_hash          text NOT NULL UNIQUE,
  credential_status        text NOT NULL DEFAULT 'active' CHECK (credential_status IN ('active', 'revoked')),
  enrolled_at              timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  last_seen_at             timestamptz,
  last_sync_at             timestamptz,
  applied_policy_revision  integer,
  permissions              jsonb NOT NULL DEFAULT '{}'::jsonb,
  clock_offset_ms          integer NOT NULL DEFAULT 0,
  clock_skew_detected      boolean NOT NULL DEFAULT false,
  last_sequence            bigint NOT NULL DEFAULT -1,
  sequence_gaps            integer NOT NULL DEFAULT 0
);
CREATE INDEX devices_org ON devices (organization_id);

CREATE TABLE policy_receipts (
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  revision         integer NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, revision)
);

-- ───────────── policies ─────────────
CREATE TABLE policies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type       text NOT NULL CHECK (scope_type IN ('organization', 'team', 'project', 'device')),
  scope_id         uuid NOT NULL,
  current_version  integer NOT NULL DEFAULT 0,
  UNIQUE (organization_id, scope_type, scope_id)
);

CREATE TABLE policy_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id           uuid NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version             integer NOT NULL,
  org_revision        integer NOT NULL,
  settings            jsonb NOT NULL,
  change_note         text NOT NULL,
  expands_collection  boolean NOT NULL DEFAULT false,
  published_by        uuid NOT NULL REFERENCES users(id),
  published_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version)
);

-- ───────────── time & activity ─────────────
CREATE TABLE work_sessions (
  id                 uuid PRIMARY KEY,           -- generated by the agent (offline start, idempotent replays)
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id          uuid REFERENCES devices(id) ON DELETE SET NULL,
  project_id         uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id            uuid REFERENCES tasks(id) ON DELETE SET NULL,
  state              text NOT NULL CHECK (state IN ('active', 'paused', 'stopped')),
  source             text NOT NULL CHECK (source IN ('agent', 'manual')),
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  client_started_at  timestamptz,
  policy_revision    integer NOT NULL DEFAULT 0,
  stop_reason        text,
  corrected          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX work_sessions_user_time ON work_sessions (organization_id, user_id, started_at);
CREATE INDEX work_sessions_open ON work_sessions (user_id) WHERE state IN ('active', 'paused');

CREATE TABLE session_transitions (
  id               bigserial PRIMARY KEY,
  session_id       uuid NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  state            text NOT NULL CHECK (state IN ('active', 'paused', 'stopped')),
  at               timestamptz NOT NULL,
  reason           text
);
CREATE INDEX session_transitions_session ON session_transitions (session_id, at);

CREATE TABLE activity_buckets (
  session_id       uuid NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_start     timestamptz NOT NULL,
  active_seconds   smallint NOT NULL CHECK (active_seconds BETWEEN 0 AND 60),
  idle_seconds     smallint NOT NULL CHECK (idle_seconds BETWEEN 0 AND 60),
  keyboard_count   integer NOT NULL CHECK (keyboard_count >= 0),
  mouse_count      integer NOT NULL CHECK (mouse_count >= 0),
  data_quality     text NOT NULL CHECK (data_quality IN ('ok', 'partial', 'permission_missing')),
  PRIMARY KEY (session_id, bucket_start),
  CHECK (active_seconds + idle_seconds <= 60)
);
CREATE INDEX activity_buckets_user_time ON activity_buckets (organization_id, user_id, bucket_start);

CREATE TABLE app_usage (
  id                bigserial PRIMARY KEY,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id        uuid NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id          uuid NOT NULL UNIQUE,
  app_identifier    text NOT NULL,
  app_name          text NOT NULL,
  domain            text,
  started_at        timestamptz NOT NULL,
  duration_seconds  integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 3600)
);
CREATE INDEX app_usage_user_time ON app_usage (organization_id, user_id, started_at);

CREATE TABLE data_gaps (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id         uuid NOT NULL UNIQUE,
  gap_start        timestamptz NOT NULL,
  gap_end          timestamptz NOT NULL,
  reason           text NOT NULL,
  CHECK (gap_end > gap_start)
);
CREATE INDEX data_gaps_user_time ON data_gaps (organization_id, user_id, gap_start);

-- ───────────── screenshots ─────────────
CREATE TABLE screenshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id         uuid NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id          uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  object_key         text NOT NULL UNIQUE,
  content_type       text NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending', 'verifying', 'stored', 'deleted', 'failed')),
  captured_at        timestamptz,
  sha256             text,
  bytes              integer,
  width              integer,
  height             integer,
  policy_revision    integer NOT NULL,
  intent_expires_at  timestamptz NOT NULL,
  retention_after    timestamptz NOT NULL,
  deleted_at         timestamptz,
  deletion_reason    text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX screenshots_user_time ON screenshots (organization_id, user_id, captured_at);
CREATE INDEX screenshots_retention ON screenshots (retention_after) WHERE deleted_at IS NULL;

-- ───────────── corrections, privacy ─────────────
CREATE TABLE time_corrections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id       uuid REFERENCES work_sessions(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('edit', 'manual_add')),
  original         jsonb,
  requested        jsonb NOT NULL,
  reason           text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by     uuid NOT NULL REFERENCES users(id),
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  review_note      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_corrections_org_status ON time_corrections (organization_id, status);

-- Original values are written once (TIME-08).
CREATE FUNCTION time_corrections_keep_original() RETURNS trigger AS $$
BEGIN
  IF NEW.original IS DISTINCT FROM OLD.original OR NEW.requested IS DISTINCT FROM OLD.requested THEN
    RAISE EXCEPTION 'time_corrections.original and requested are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER time_corrections_immutable BEFORE UPDATE ON time_corrections
  FOR EACH ROW EXECUTE FUNCTION time_corrections_keep_original();

CREATE TABLE deletion_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requester_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type      text NOT NULL CHECK (target_type IN ('screenshot')),
  target_id        uuid NOT NULL,
  reason           text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  reviewer_id      uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX deletion_requests_target ON deletion_requests (target_id);

CREATE TABLE legal_holds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_at          timestamptz NOT NULL,
  to_at            timestamptz NOT NULL,
  reason           text NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz,
  CHECK (to_at > from_at)
);

CREATE TABLE notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  title            text NOT NULL,
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  read_at          timestamptz
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

CREATE TABLE export_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requester_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('sessions', 'activity_daily')),
  scope            jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  object_key       text,
  row_count        integer,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz
);

-- ───────────── audit (append-only) ─────────────
CREATE TABLE audit_logs (
  id               bigserial PRIMARY KEY,
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type       text NOT NULL CHECK (actor_type IN ('user', 'device', 'system', 'platform')),
  actor_id         uuid,
  action           text NOT NULL,
  target_type      text,
  target_id        text,
  target_user_id   uuid,
  result           text NOT NULL CHECK (result IN ('success', 'denied', 'error')),
  request_id       text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_target_user ON audit_logs (organization_id, target_user_id, created_at DESC);

CREATE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  -- Tenant offboarding deletes the organization (cascade); that path sets this flag.
  IF TG_OP = 'DELETE' AND current_setting('rd.allow_audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- ───────────── ingestion & jobs ─────────────
CREATE TABLE ingest_events (
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_id         uuid NOT NULL,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL,
  event_type       text NOT NULL,
  sequence         bigint NOT NULL,
  occurred_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
  reason           text,
  processed_at     timestamptz,
  PRIMARY KEY (device_id, event_id)
);
CREATE INDEX ingest_events_processed ON ingest_events (processed_at) WHERE processed_at IS NOT NULL;

CREATE TABLE jobs (
  id               bigserial PRIMARY KEY,
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  run_at           timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 8,
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX jobs_ready ON jobs (run_at) WHERE status = 'queued';

-- ───────────── platform (vendor operators) ─────────────
CREATE TABLE platform_admins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  display_name    text NOT NULL,
  password_hash   text NOT NULL,
  mfa_secret_enc  text,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email ON platform_admins (lower(email));

CREATE TABLE platform_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_admin_id  uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  token_hash         text NOT NULL UNIQUE,
  mfa_verified       boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);

CREATE TABLE support_access_grants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform_admin_id  uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  approved_by        uuid REFERENCES users(id),
  reason             text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);
