/**
 * Development seed: one demo organization with people, teams, projects, policies and
 * a few days of synthetic sessions so every screen has something to show.
 * Refuses to run in production. All passwords are DEMO_PASSWORD.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config';
import type { Deps } from './context';
import { createPool, one, withTx, type Queryable } from './db/pool';
import { migrate } from './db/migrate';
import { hashPassword, randomToken, sha256Hex } from './lib/crypto';
import { createOrganization } from './modules/platform/routes';
import { MemoryObjectStore } from './storage/object-store';
import { recordIdleDecision } from './modules/idle/service';
import { ConsoleEmailSender } from './email/sender';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'track-demo-2026';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

// Deterministic pseudo-random numbers so the demo looks the same on every machine.
let s = 42;
const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

async function addUser(q: Queryable, orgId: string, email: string, name: string, role = 'employee', tracking = true) {
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO users (organization_id, email, display_name, password_hash, org_role, tracking_enabled, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, 'America/Toronto') RETURNING id`,
    [orgId, email, name, await hashPassword(DEMO_PASSWORD), role, tracking],
  );
  return r!.id;
}

async function publish(q: Queryable, orgId: string, by: string, scopeType: string, scopeId: string, settings: object, note: string) {
  const p = await one<{ id: string }>(
    q,
    `INSERT INTO policies (organization_id, scope_type, scope_id, current_version) VALUES ($1, $2, $3, 1) RETURNING id`,
    [orgId, scopeType, scopeId],
  );
  const rev = await one<{ policy_revision: number }>(
    q,
    'UPDATE organizations SET policy_revision = policy_revision + 1 WHERE id = $1 RETURNING policy_revision',
    [orgId],
  );
  await q.query(
    `INSERT INTO policy_versions (policy_id, organization_id, version, org_revision, settings, change_note, expands_collection, published_by)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7)`,
    [p!.id, orgId, rev!.policy_revision, settings, note, scopeType === 'project', by],
  );
}

async function demoDay(q: Queryable, orgId: string, userId: string, deviceId: string, projectId: string, day: Date, quality: string) {
  const blocks: [number, number][] = [
    [9 * 60 + Math.floor(rand() * 20), 12 * 60 + Math.floor(rand() * 10)],
    [13 * 60 + Math.floor(rand() * 10), 17 * 60 + Math.floor(rand() * 40)],
  ];
  for (const [startMin, endMin] of blocks) {
    const sid = randomUUID();
    // 13:00 local Toronto ≈ 17:00/18:00 UTC; store in UTC using a fixed −4 h offset for the demo.
    const start = new Date(day.getTime() + (startMin + 240) * 60_000);
    const end = new Date(day.getTime() + (endMin + 240) * 60_000);
    if (end > new Date()) continue;
    await q.query(
      `INSERT INTO work_sessions (id, organization_id, user_id, device_id, project_id, state, source, started_at, ended_at, stop_reason)
       VALUES ($1, $2, $3, $4, $5, 'stopped', 'agent', $6, $7, 'user')`,
      [sid, orgId, userId, deviceId, projectId, start.toISOString(), end.toISOString()],
    );
    await q.query(
      `INSERT INTO session_transitions (session_id, organization_id, state, at, reason) VALUES ($1, $2, 'active', $3, 'start'), ($1, $2, 'stopped', $4, 'user')`,
      [sid, orgId, start.toISOString(), end.toISOString()],
    );
    const values: unknown[] = [];
    const rows: string[] = [];
    for (let t = start.getTime(); t + 60_000 <= end.getTime(); t += 60_000) {
      const active = Math.min(60, Math.max(0, Math.round(25 + rand() * 40 - (rand() < 0.1 ? 40 : 0))));
      const idle = 60 - active;
      const i = values.length;
      rows.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}, $${i + 8}, $${i + 9})`);
      values.push(sid, orgId, userId, new Date(t).toISOString(), active, idle, Math.round(active * 2.5), Math.round(active * 1.2), quality);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = values.slice(i * 9, (i + chunk.length) * 9);
      const renumbered = chunk.map((_, j) => `(${Array.from({ length: 9 }, (_, k) => `$${j * 9 + k + 1}`).join(', ')})`);
      await q.query(
        `INSERT INTO activity_buckets (session_id, organization_id, user_id, bucket_start, active_seconds, idle_seconds, keyboard_count, mouse_count, data_quality)
         VALUES ${renumbered.join(', ')}`,
        vals,
      );
    }
    const apps = [
      ['com.microsoft.VSCode', 'Visual Studio Code', 0.45],
      ['com.google.Chrome', 'Google Chrome', 0.3],
      ['com.figma.Desktop', 'Figma', 0.1],
      ['com.tinyspeck.slackmacgap', 'Slack', 0.1],
      ['us.zoom.xos', 'Zoom', 0.05],
    ] as const;
    let cursor = start.getTime();
    const total = (end.getTime() - start.getTime()) / 1000;
    for (const [id, name, share] of apps) {
      let left = Math.round(total * share);
      while (left > 0) {
        const d = Math.min(3600, left);
        await q.query(
          `INSERT INTO app_usage (organization_id, session_id, user_id, event_id, app_identifier, app_name, started_at, duration_seconds)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [orgId, sid, userId, randomUUID(), id, name, new Date(cursor).toISOString(), d],
        );
        cursor += d * 1000;
        left -= d;
      }
    }
  }
}

async function main() {
  const config = loadConfig();
  await migrate(config.databaseUrl, () => undefined);
  const pool = createPool(config.databaseUrl);
  const deps: Deps = { pool, config, store: new MemoryObjectStore(), email: new ConsoleEmailSender(), now: () => new Date() };

  const existing = await one(pool, `SELECT 1 FROM organizations WHERE slug = 'rounddigital'`);
  if (existing) {
    console.log('Demo organization already exists; nothing to do.');
    await pool.end();
    return;
  }

  await withTx(pool, async (q) => {
    const { organization_id: orgId, admin_user_id: adminId } = await createOrganization(
      deps,
      q,
      { name: 'RoundDigital', slug: 'rounddigital', region: 'ca-central-1', admin_email: 'admin@rounddigital.example', admin_name: 'Jordan Lee', plan: 'pro', seats: 10 },
      { kind: 'system' },
    );
    await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [adminId, await hashPassword(DEMO_PASSWORD)]);

    const priya = await addUser(q, orgId, 'priya@rounddigital.example', 'Priya Nair');
    const sam = await addUser(q, orgId, 'sam@rounddigital.example', 'Sam Ortiz', 'employee', false);
    const people = {
      alex: await addUser(q, orgId, 'alex@rounddigital.example', 'Alex Moreno'),
      jun: await addUser(q, orgId, 'jun@rounddigital.example', 'Jun Park'),
      tom: await addUser(q, orgId, 'tom@rounddigital.example', 'Tom Becker'),
      sara: await addUser(q, orgId, 'sara@rounddigital.example', 'Sara Lindqvist'),
    };
    await addUser(q, orgId, 'audit@rounddigital.example', 'Robin Auditor', 'auditor', false);

    const team = async (name: string) => (await one<{ id: string }>(q, `INSERT INTO teams (organization_id, name) VALUES ($1, $2) RETURNING id`, [orgId, name]))!.id;
    const platform = await team('Platform');
    const support = await team('Support');
    const member = (t: string, u: string, role = 'member') =>
      q.query(`INSERT INTO team_memberships (organization_id, team_id, user_id, role) VALUES ($1, $2, $3, $4)`, [orgId, t, u, role]);
    await member(platform, priya, 'manager');
    await member(platform, sam, 'manager');
    for (const u of [people.alex, people.jun, people.tom]) await member(platform, u);
    await member(support, people.sara);
    await member(support, sam, 'manager');

    const project = async (name: string, client: string | null) =>
      (await one<{ id: string }>(q, `INSERT INTO projects (organization_id, name, client_ref) VALUES ($1, $2, $3) RETURNING id`, [orgId, name, client]))!.id;
    const clientA = await project('Client A — Website rebuild', 'CA-2026-07');
    const clientB = await project('Client B — Mobile app', 'CB-2026-02');
    const internal = await project('Internal', null);
    for (const [p, names] of [
      [clientA, ['Build', 'QA pass', 'Stand-up']],
      [clientB, ['Design', 'Build']],
      [internal, ['Admin', 'Training']],
    ] as const) {
      for (const n of names) await q.query(`INSERT INTO tasks (organization_id, project_id, name) VALUES ($1, $2, $3)`, [orgId, p, n]);
    }
    await q.query(`INSERT INTO project_memberships (organization_id, project_id, user_id, role) VALUES ($1, $2, $3, 'manager')`, [orgId, clientA, sam]);

    await publish(q, orgId, adminId, 'organization', orgId, { idle: { threshold_seconds: 300 }, apps: { capture_window_titles: false } }, 'Baseline: idle after 5 minutes; no window titles.');
    await publish(q, orgId, adminId, 'team', support, { retention: { screenshot_days: 14 } }, 'Support handles customer data: shorter screenshot retention.');
    await publish(
      q,
      orgId,
      adminId,
      'project',
      clientA,
      { screenshots: { enabled: true, interval_minutes: 15 }, viewers: { manager_can_view_screenshots: true } },
      'Client contract §7 requires visual evidence of work on deliverables. Approved by HR and Legal.',
    );

    // Synthetic history for the last 5 weekdays.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (const [name, uid] of Object.entries({ priya, ...people })) {
      const dev = await one<{ id: string }>(
        q,
        `INSERT INTO devices (organization_id, user_id, name, os, os_version, agent_version, credential_hash, last_seen_at, last_sync_at, applied_policy_revision, permissions)
         VALUES ($1, $2, $3, $4, $5, '0.1.0', $6, now(), now(), 3, $7) RETURNING id`,
        [
          orgId,
          uid,
          `Laptop (${name})`,
          name === 'alex' || name === 'sara' ? 'windows' : 'macos',
          name === 'alex' || name === 'sara' ? '11 24H2' : '15.6',
          sha256Hex(randomToken()),
          { input_monitoring: 'granted', screen_recording: name === 'tom' ? 'denied' : 'granted', accessibility: 'granted' },
        ],
      );
      for (let d = 1; d <= 7; d++) {
        const day = new Date(today.getTime() - d * 86_400_000);
        if ([0, 6].includes(day.getUTCDay())) continue;
        const proj = name === 'sara' ? internal : rand() < 0.65 ? clientA : clientB;
        await demoDay(q, orgId, uid, dev!.id, proj, day, name === 'tom' && d === 2 ? 'permission_missing' : 'ok');
      }
    }
    // Stage 4 F1: on her latest day Priya removed one idle run and asked to move another.
    const last = await one<{ id: string; device_id: string; started_at: string; ended_at: string }>(
      q,
      `SELECT id, device_id, started_at, ended_at FROM work_sessions WHERE user_id = $1 AND source = 'agent' ORDER BY started_at DESC LIMIT 1`,
      [priya],
    );
    if (last) {
      const t0 = new Date(last.started_at).getTime();
      const span = (fromMin: number, len: number) => [new Date(t0 + fromMin * 60_000).toISOString(), new Date(t0 + (fromMin + len) * 60_000).toISOString()] as const;
      const [a1, a2] = span(52, 18);
      const [b1, b2] = span(118, 25);
      await recordIdleDecision(deps, q, last.device_id, { eventId: randomUUID(), sessionId: last.id, startedAt: a1, endedAt: a2, decision: 'discard', projectId: null, taskId: null });
      await recordIdleDecision(deps, q, last.device_id, { eventId: randomUUID(), sessionId: last.id, startedAt: b1, endedAt: b2, decision: 'reassign', projectId: internal, taskId: null });
    }
    console.log(`Seeded organization "RoundDigital" (${orgId}).`);
  });

  console.log(`
Demo sign-ins (password: ${DEMO_PASSWORD})
  admin@rounddigital.example   org admin (set MFA_REQUIRED_FOR_ADMINS=false locally, or enroll TOTP on first sign-in)
  priya@rounddigital.example   employee + Platform team manager
  sam@rounddigital.example     Platform & Support manager, Client A project manager (viewer seat)
  tom@rounddigital.example     employee
  audit@rounddigital.example   auditor
`);
  await pool.end();
}

await main();
