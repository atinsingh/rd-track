import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db/tenant-scope';
import { makeOrg, testEnv, type Org, type TestEnv } from './helpers';

/**
 * Row-level security is the second line of tenant isolation (ADR-0004): even a query
 * that forgets its `organization_id` filter only sees the scoped organization's rows.
 */
let env: TestEnv;
let a: Org;
let b: Org;

beforeAll(async () => {
  env = await testEnv();
  a = await makeOrg(env, 'rls-a');
  b = await makeOrg(env, 'rls-b');
});
afterAll(() => env.close());

const pool = () => env.deps.pool;

describe('row-level security', () => {
  it('the app role is not able to bypass RLS', async () => {
    const r = await pool().query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('an unfiltered query sees only the scoped organization', async () => {
    const users = await withScope(a.id, () => pool().query(`SELECT DISTINCT organization_id FROM users`));
    expect(users.rows.map((r) => r.organization_id)).toEqual([a.id]);
    const orgs = await withScope(a.id, () => pool().query(`SELECT id FROM organizations`));
    expect(orgs.rows.map((r) => r.id)).toEqual([a.id]);
    const audit = await withScope(b.id, () => pool().query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1`, [a.id]));
    expect(audit.rows[0].n).toBe(0);
  });

  it('writes into another organization are refused', async () => {
    await expect(
      withScope(a.id, () => pool().query(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Intruders')`, [b.id])),
    ).rejects.toThrow(/row-level security/);
    const moved = await withScope(a.id, () => pool().query(`UPDATE users SET display_name = 'x' WHERE organization_id = $1`, [b.id]));
    expect(moved.rowCount).toBe(0);
  });

  it('an unset or malformed scope sees nothing', async () => {
    for (const scope of ['', 'not-a-uuid']) {
      const r = await withScope(scope, () => pool().query(`SELECT count(*)::int AS n FROM users`));
      expect(r.rows[0].n).toBe(0);
    }
  });

  it('requests are scoped to the authenticated organization', async () => {
    // A tenant request that names another tenant's user gets 404, and RLS would hide the row anyway.
    const r = await a.admin.get(`/v1/users/${b.users.emp!.id}/sessions?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`);
    expect(r.status).toBe(404);
  });
});
