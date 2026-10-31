import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which organization the current unit of work may see in Postgres (`rd.org_id`, enforced
 * by row-level security — migration 003). Requests run inside `tenantScope.run`; the auth
 * hook narrows the scope to the authenticated user's or device's organization.
 * Code outside any request (worker loop, scripts, tests) runs in the system scope '*'.
 */
export const tenantScope = new AsyncLocalStorage<{ org: string }>();

export const SYSTEM_SCOPE = '*';

export function currentScope(): string {
  return tenantScope.getStore()?.org ?? SYSTEM_SCOPE;
}

/** Runs `fn` with database access limited to one organization (or '*' for system work). */
export function withScope<T>(org: string, fn: () => Promise<T>): Promise<T> {
  return tenantScope.run({ org }, fn);
}

/**
 * Whether any organization has a matching row: for global uniqueness (email addresses,
 * verified domains) checked from inside one tenant's scope. Returns nothing else.
 */
export async function existsAnywhere(pool: { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }> }, sql: string, args: unknown[]): Promise<boolean> {
  const r = await withScope(SYSTEM_SCOPE, () => pool.query(sql, args));
  return Boolean(r.rowCount);
}
