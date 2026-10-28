import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import type { Deps } from '../src/context';
import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { drainJobs } from '../src/jobs/runner';
import { hashPassword } from '../src/lib/crypto';
import { createOrganization } from '../src/modules/platform/routes';
import { MemoryObjectStore } from '../src/storage/object-store';
import { MemoryEmailSender } from '../src/email/sender';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rd:rd@localhost:5432/rd_track_test';
export const PASSWORD = 'correct-horse-battery';

/** A controllable clock: tests move time forward explicitly. */
export class TestClock {
  constructor(public t = new Date('2026-10-26T13:00:00Z').getTime()) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
  iso(offsetMs = 0) {
    return new Date(this.t + offsetMs).toISOString();
  }
}

export async function resetDatabase() {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(TEST_DB, () => undefined);
}

export interface TestEnv {
  app: FastifyInstance;
  deps: Deps;
  store: MemoryObjectStore;
  email: MemoryEmailSender;
  clock: TestClock;
  close(): Promise<void>;
  drain(): Promise<number>;
}

export async function testEnv(overrides: Partial<Config> = {}): Promise<TestEnv> {
  await resetDatabase();
  const clock = new TestClock();
  const store = new MemoryObjectStore();
  const config = loadConfig({ databaseUrl: TEST_DB, mfaRequiredForAdmins: false, authRateLimitPerMinute: 10_000, ...overrides });
  const email = new MemoryEmailSender();
  const deps: Deps = { pool: createPool(TEST_DB), config, store, email, now: clock.now };
  const app = await buildApp(deps, { logger: Boolean(process.env.DEBUG_API) });
  return {
    app,
    deps,
    store,
    email,
    clock,
    drain: () => drainJobs(deps),
    async close() {
      await app.close();
      await deps.pool.end();
    },
  };
}

/** Cookie-authenticated client for one user. */
export class Client {
  constructor(
    private readonly app: FastifyInstance,
    public cookie: string,
  ) {}
  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
    const res = await this.app.inject({
      method,
      url,
      payload: body as object | undefined,
      headers: { cookie: this.cookie, ...(method === 'GET' ? {} : { 'x-rd-csrf': '1' }) },
    });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
  }
  get(url: string) {
    return this.req('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.req('POST', url, body);
  }
  put(url: string, body: unknown) {
    return this.req('PUT', url, body);
  }
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<Client> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return new Client(app, raw.split(';')[0]!);
}

export interface Org {
  id: string;
  admin: Client;
  adminId: string;
  users: Record<string, { id: string; client: Client }>;
  teamId: string;
  projectId: string;
}

/**
 * An organization on `plan` with an admin, a team manager and two employees in one team,
 * and one project. Names are prefixed so two orgs can coexist.
 */
export async function makeOrg(env: TestEnv, prefix: string, plan: 'free' | 'standard' | 'pro' = 'pro', seats = 10): Promise<Org> {
  const { app, deps } = env;
  const created = await createOrganization(
    deps,
    deps.pool,
    {
      name: `${prefix} Inc`,
      slug: `${prefix}-${randomUUID().slice(0, 6)}`,
      region: 'ca-central-1',
      admin_email: `admin@${prefix}.test`,
      admin_name: `${prefix} Admin`,
      plan,
      seats,
    },
    { kind: 'system' },
  );
  await deps.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [created.admin_user_id, await hashPassword(PASSWORD)]);
  const admin = await login(app, `admin@${prefix}.test`);

  const users: Org['users'] = {};
  const people: [string, boolean][] = plan === 'free' ? [['manager', true], ['emp', true]] : [['manager', true], ['emp', true], ['emp2', true]];
  for (const [name, tracking] of people) {
    const r = await admin.post('/v1/admin/users', {
      email: `${name}@${prefix}.test`,
      display_name: `${prefix} ${name}`,
      password: PASSWORD,
      tracking_enabled: tracking,
    });
    if (r.status !== 201) throw new Error(`create user: ${r.status} ${JSON.stringify(r.body)}`);
    users[name] = { id: r.body.user.id, client: await login(app, `${name}@${prefix}.test`) };
  }
  const team = await admin.post('/v1/admin/teams', { name: `${prefix} Team` });
  await admin.post(`/v1/admin/teams/${team.body.id}/members`, { user_id: users.manager!.id, role: 'manager' });
  for (const name of Object.keys(users)) {
    if (name !== 'manager') await admin.post(`/v1/admin/teams/${team.body.id}/members`, { user_id: users[name]!.id, role: 'member' });
  }
  const project = await admin.post('/v1/admin/projects', { name: `${prefix} Project` });
  return { id: created.organization_id, admin, adminId: created.admin_user_id, users, teamId: team.body.id, projectId: project.body.id };
}

export interface Device {
  id: string;
  credential: string;
  userId: string;
  orgId: string;
  seq: number;
  publicKeyB64: string;
}

export async function enrollDevice(env: TestEnv, org: Org, userKey: string): Promise<Device> {
  const code = await org.admin.post('/v1/admin/enrollment-codes', { user_id: org.users[userKey]!.id });
  if (code.status !== 201) throw new Error(`enrollment code: ${code.status} ${JSON.stringify(code.body)}`);
  const res = await env.app.inject({
    method: 'POST',
    url: '/v1/devices/enroll',
    payload: { enrollment_code: code.body.code, device_name: 'Test laptop', os: 'macos', os_version: '15.6', agent_version: '0.1.0' },
  });
  if (res.statusCode !== 201) throw new Error(`enroll: ${res.statusCode} ${res.body}`);
  const b = JSON.parse(res.body);
  return { id: b.device_id, credential: b.device_credential, userId: b.user_id, orgId: b.organization_id, seq: 0, publicKeyB64: b.policy_signing_key.public_key_b64 };
}

export async function deviceReq(env: TestEnv, d: Device, method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await env.app.inject({ method, url, payload: body as object | undefined, headers: { authorization: `Device ${d.credential}` } });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
}

export function event(d: Device, sessionId: string, type: string, payload: object, occurredAt: string) {
  return {
    event_id: randomUUID(),
    organization_id: d.orgId,
    device_id: d.id,
    session_id: sessionId,
    policy_version: 0,
    event_type: type,
    occurred_at: occurredAt,
    sequence: d.seq++,
    payload,
  };
}

export function bucket(d: Device, sessionId: string, minuteIso: string, active = 45, idle = 15) {
  const occurred = new Date(new Date(minuteIso).getTime() + 60_000).toISOString();
  return event(d, sessionId, 'activity_bucket.v1', {
    bucket_start: minuteIso,
    active_seconds: active,
    idle_seconds: idle,
    keyboard_count: 100,
    mouse_count: 40,
    data_quality: 'ok',
  }, occurred);
}

export async function sendBatch(env: TestEnv, d: Device, events: object[], sentAt = env.clock.iso()) {
  return deviceReq(env, d, 'POST', '/v1/ingestion/event-batches', { batch_id: randomUUID(), sent_at: sentAt, events });
}

/** Minute-aligned ISO timestamps starting at `startIso`. */
export function minutes(startIso: string, n: number): string[] {
  const t0 = new Date(startIso).getTime();
  return Array.from({ length: n }, (_, i) => new Date(t0 + i * 60_000).toISOString());
}
