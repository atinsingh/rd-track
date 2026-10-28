-- Stage 4 F1: what the person chose when they came back from an idle run.
--
-- keep     recorded for the person's history; the time stays as measured.
-- discard  each bucket overlapping the span loses the smaller of its idle seconds and
--          the span's seconds inside that minute — now, and again for any bucket of
--          the span that arrives later (the minute of the return is only sent when
--          it closes, which can be after the answer).
-- reassign a time correction (kind 'idle_reassign'); approved, the span moves to the
--          chosen project as a manual entry and its idle seconds are removed like a
--          discard; rejected, the time stays where it was.

CREATE TABLE idle_decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  device_id        uuid REFERENCES devices(id) ON DELETE SET NULL,
  event_id         uuid NOT NULL UNIQUE,
  idle_started_at  timestamptz NOT NULL,
  idle_ended_at    timestamptz NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('keep', 'discard', 'reassign')),
  project_id       uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id          uuid REFERENCES tasks(id) ON DELETE SET NULL,
  -- applied: in effect · pending: a reassign waiting for approval · rejected: no effect
  status           text NOT NULL CHECK (status IN ('applied', 'pending', 'rejected')),
  status_reason    text,
  correction_id    uuid REFERENCES time_corrections(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_ended_at > idle_started_at),
  CHECK ((decision = 'reassign') = (project_id IS NOT NULL))
);
CREATE INDEX idle_decisions_session ON idle_decisions (session_id, idle_started_at);
CREATE INDEX idle_decisions_user ON idle_decisions (organization_id, user_id, idle_started_at);

ALTER TABLE idle_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE idle_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idle_decisions USING (rd_org_visible(organization_id)) WITH CHECK (rd_org_visible(organization_id));

-- The agent's own idle seconds for a bucket, kept once a removal has touched it, so
-- removals are always recomputed from what was measured (idempotent, and a bucket
-- at a span's edge loses only the span's part: it may also hold a neighbouring run).
ALTER TABLE activity_buckets ADD COLUMN idle_seconds_raw int CHECK (idle_seconds_raw BETWEEN 0 AND 60);

ALTER TABLE time_corrections DROP CONSTRAINT IF EXISTS time_corrections_kind_check;
ALTER TABLE time_corrections ADD CONSTRAINT time_corrections_kind_check CHECK (kind IN ('edit', 'manual_add', 'idle_reassign'));
