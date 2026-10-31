import type { ScimTokenDTO } from '@rd/contracts';
import type { Deps, DirectoryActor, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { existsAnywhere } from '../../db/tenant-scope';
import type { EmailMessage } from '../../email/sender';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { inviteUser } from '../auth/identity';
import { assertEntitlement, assertSeatAvailable } from '../billing/service';
import { assertAnotherAdmin, createTeam, endAccess, removeTeamMember, renameTeam, restoreAccess, setTeamMember } from '../org/service';
import { ssoLive } from '../sso/service';

/**
 * Directory provisioning over SCIM 2.0 (RFC 7643/7644; slice 6b, G26). Users are people,
 * Groups are teams. The directory never deletes anyone: removing a user deactivates them,
 * so their time records stay. Everything it changes is audited as "Directory sync".
 */

export const SCIM = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
} as const;

/** An error the SCIM routes render as an RFC 7644 §3.12 error; `code` doubles as the scimType. */
export const scimError = (status: number, detail: string, scimType = 'invalidValue') => new AppError(status, scimType, detail);

// ───────────── tokens (org admin) ─────────────

const TOKEN_PREFIX = 'rdscim_';

export async function createScimToken(deps: Deps, q: Queryable, actor: UserActor, label: string, requestId?: string): Promise<ScimTokenDTO & { token: string }> {
  await assertEntitlement(q, actor.organizationId, 'sso', deps.now(), 'Directory sync');
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const r = await one<{ id: string; created_at: string }>(
    q,
    'INSERT INTO scim_tokens (organization_id, token_hash, label, created_by) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
    [actor.organizationId, sha256Hex(token), label, actor.userId],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'scim.token_created', targetType: 'scim_token', targetId: r!.id, requestId, metadata: { label } });
  return { id: r!.id, label, created_at: r!.created_at, created_by_name: actor.displayName, last_used_at: null, token };
}

export async function revokeScimToken(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<void> {
  const r = await q.query('UPDATE scim_tokens SET revoked_at = $3 WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL', [actor.organizationId, id, deps.now().toISOString()]);
  if (!r.rowCount) throw errors.notFound('Directory token');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'scim.token_revoked', targetType: 'scim_token', targetId: id, requestId });
}

/** The directory behind a bearer token, or why not: unknown/revoked, or a plan without SSO. */
export async function authenticateDirectory(deps: Deps, q: Queryable, token: string): Promise<DirectoryActor | 'not_entitled' | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const t = await one<{ id: string; organization_id: string; last_used_at: string | null }>(
    q,
    'SELECT id, organization_id, last_used_at FROM scim_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
    [sha256Hex(token)],
  );
  if (!t) return null;
  try {
    await assertEntitlement(q, t.organization_id, 'sso', deps.now(), 'Directory sync');
  } catch {
    return 'not_entitled';
  }
  const now = deps.now();
  if (!t.last_used_at || now.getTime() - new Date(t.last_used_at).getTime() > 5 * 60_000) {
    await q.query('UPDATE scim_tokens SET last_used_at = $2 WHERE id = $1', [t.id, now.toISOString()]);
  }
  return { kind: 'directory', tokenId: t.id, organizationId: t.organization_id };
}

// ───────────── shared ─────────────

/** `attr eq "value"`, the one filter directories send (RFC 7644 §3.4.2.2). */
function parseFilter(filter: string | undefined, attrs: Record<string, string>): { column: string; value: string } | null {
  if (!filter) return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const column = m ? attrs[m[1]!.toLowerCase()] : undefined;
  if (!m || !column) throw scimError(400, `Unsupported filter: ${filter}`, 'invalidFilter');
  return { column, value: m[2]!.replace(/\\(.)/g, '$1') };
}

function paging(qs: { startIndex?: string; count?: string }) {
  const start = Math.max(1, Number.parseInt(qs.startIndex ?? '1', 10) || 1);
  const count = Math.min(200, Math.max(0, Number.parseInt(qs.count ?? '100', 10) || 0));
  return { start, count: qs.count === undefined ? 100 : count };
}

const listResponse = (resources: unknown[], total: number, start: number) => ({
  schemas: [SCIM.list],
  totalResults: total,
  startIndex: start,
  itemsPerPage: resources.length,
  Resources: resources,
});

const truthy = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : typeof v === 'string' && /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : undefined;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface PatchOp {
  op: string;
  path?: string;
  value?: unknown;
}

function patchOps(body: unknown): PatchOp[] {
  const ops = (body as { Operations?: unknown })?.Operations;
  if (!Array.isArray(ops) || ops.some((o) => typeof o?.op !== 'string')) throw scimError(400, 'Operations must be a list of { op, path?, value? }', 'invalidSyntax');
  return ops as PatchOp[];
}

// ───────────── Users ─────────────

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'deactivated';
  external_id: string | null;
  org_role: string;
  tracking_enabled: boolean;
  created_at: string;
}

const USER_COLUMNS = 'id, email, display_name, status, external_id, org_role, tracking_enabled, created_at';
const USER_FILTERS: Record<string, string> = { username: 'lower(email)', 'emails.value': 'lower(email)', externalid: 'external_id', displayname: 'display_name' };

function toUser(base: string, u: UserRow) {
  return {
    schemas: [SCIM.user],
    id: u.id,
    ...(u.external_id ? { externalId: u.external_id } : {}),
    userName: u.email,
    name: { formatted: u.display_name },
    displayName: u.display_name,
    emails: [{ value: u.email, type: 'work', primary: true }],
    active: u.status === 'active',
    meta: { resourceType: 'User', created: u.created_at, location: `${base}/Users/${u.id}` },
  };
}

async function userRow(q: Queryable, orgId: string, id: string): Promise<UserRow> {
  const u = /^[0-9a-f-]{36}$/i.test(id) ? await one<UserRow>(q, `SELECT ${USER_COLUMNS} FROM users WHERE organization_id = $1 AND id = $2`, [orgId, id]) : null;
  if (!u) throw scimError(404, `User ${id} not found`, 'noTarget');
  return u;
}

export async function listUsers(q: Queryable, actor: DirectoryActor, base: string, qs: { filter?: string; startIndex?: string; count?: string }) {
  const f = parseFilter(qs.filter, USER_FILTERS);
  const { start, count } = paging(qs);
  const where = `organization_id = $1 ${f ? `AND ${f.column} = ${f.column === 'lower(email)' ? 'lower($2)' : '$2'}` : ''}`;
  const args: unknown[] = f ? [actor.organizationId, f.value] : [actor.organizationId];
  const total = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM users WHERE ${where}`, args);
  const rows = await many<UserRow>(q, `SELECT ${USER_COLUMNS} FROM users WHERE ${where} ORDER BY created_at, id LIMIT ${count} OFFSET ${start - 1}`, args);
  return listResponse(rows.map((r) => toUser(base, r)), total!.n, start);
}

export async function getUser(q: Queryable, actor: DirectoryActor, base: string, id: string) {
  return toUser(base, await userRow(q, actor.organizationId, id));
}

interface UserChanges {
  email?: string;
  displayName?: string;
  active?: boolean;
  externalId?: string | null;
}

/** What a POST or PUT body says; userName is the sign-in address. */
function userChanges(b: Record<string, unknown>): UserChanges {
  const name = (b.name ?? {}) as { formatted?: unknown; givenName?: unknown; familyName?: unknown };
  const emails = Array.isArray(b.emails) ? (b.emails as { value?: unknown; primary?: unknown }[]) : [];
  const userName = typeof b.userName === 'string' ? b.userName.trim() : '';
  const email = EMAIL.test(userName) ? userName : (emails.find((e) => e.primary === true) ?? emails[0])?.value;
  const given = [name.givenName, name.familyName].filter((x) => typeof x === 'string' && x.trim()).join(' ');
  const displayName = [b.displayName, name.formatted, given].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
  return {
    email: typeof email === 'string' && EMAIL.test(email) ? email.toLowerCase() : undefined,
    displayName: displayName?.trim().slice(0, 200),
    active: truthy(b.active),
    externalId: typeof b.externalId === 'string' ? b.externalId : undefined,
  };
}

/** New people: an employee; tracked if a seat is free. Without single sign-on they're also invited. */
export async function createUser(deps: Deps, q: Queryable, actor: DirectoryActor, base: string, body: Record<string, unknown>): Promise<{ resource: unknown; mail: EmailMessage[] }> {
  const c = userChanges(body);
  if (!c.email) throw scimError(400, 'userName (or a primary email) must be an email address');
  if (await existsAnywhere(deps.pool, 'SELECT 1 FROM users WHERE lower(email) = $1', [c.email])) throw scimError(409, `A person with ${c.email} already exists`, 'uniqueness');
  if (c.externalId && (await one(q, 'SELECT 1 FROM users WHERE organization_id = $1 AND external_id = $2', [actor.organizationId, c.externalId]))) {
    throw scimError(409, `externalId ${c.externalId} is already in use`, 'uniqueness');
  }
  const active = c.active ?? true;
  let tracking = active;
  if (tracking) {
    try {
      await assertSeatAvailable(q, actor.organizationId, deps.now());
    } catch {
      tracking = false;
    }
  }
  const r = await one<UserRow>(
    q,
    `INSERT INTO users (organization_id, email, display_name, org_role, tracking_enabled, external_id, status, deactivated_at)
     VALUES ($1, $2, $3, 'employee', $4, $5, $6, $7) RETURNING ${USER_COLUMNS}`,
    [actor.organizationId, c.email, c.displayName ?? c.email.split('@')[0], tracking, c.externalId ?? null, active ? 'active' : 'deactivated', active ? null : deps.now().toISOString()],
  );
  await audit(q, { organizationId: actor.organizationId, actor, action: 'user.create', targetType: 'user', targetId: r!.id, targetUserId: r!.id, metadata: { via: 'scim', org_role: 'employee', tracking_enabled: tracking } });
  const mail = active && !(await ssoLive(deps, q, actor.organizationId)) ? [await inviteUser(deps, q, { orgId: actor.organizationId, userId: r!.id, invitedBy: null })] : [];
  return { resource: toUser(base, r!), mail };
}

async function applyUser(deps: Deps, q: Queryable, actor: DirectoryActor, u: UserRow, c: UserChanges): Promise<void> {
  const fields: string[] = [];
  if (c.email && c.email !== u.email.toLowerCase()) {
    if (await existsAnywhere(deps.pool, 'SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [c.email, u.id])) throw scimError(409, `A person with ${c.email} already exists`, 'uniqueness');
    await q.query('UPDATE users SET email = $2 WHERE id = $1', [u.id, c.email]);
    fields.push('email');
  }
  if (c.displayName && c.displayName !== u.display_name) {
    await q.query('UPDATE users SET display_name = $2 WHERE id = $1', [u.id, c.displayName]);
    fields.push('display_name');
  }
  if (c.externalId !== undefined && c.externalId !== u.external_id) {
    if (c.externalId && (await one(q, 'SELECT 1 FROM users WHERE organization_id = $1 AND external_id = $2 AND id <> $3', [actor.organizationId, c.externalId, u.id]))) {
      throw scimError(409, `externalId ${c.externalId} is already in use`, 'uniqueness');
    }
    await q.query('UPDATE users SET external_id = $2 WHERE id = $1', [u.id, c.externalId]);
    fields.push('external_id');
  }
  if (fields.length) await audit(q, { organizationId: actor.organizationId, actor, action: 'user.update', targetType: 'user', targetId: u.id, targetUserId: u.id, metadata: { via: 'scim', fields } });
  if (c.active === false && u.status === 'active') {
    if (u.org_role === 'org_admin' || u.org_role === 'super_admin') {
      try {
        await assertAnotherAdmin(q, actor.organizationId, u.id);
      } catch {
        throw scimError(409, 'This is the organization’s last active admin; make someone else an admin in Track first', 'mutability');
      }
    }
    await endAccess(deps, q, actor, u.id);
  } else if (c.active === true && u.status === 'deactivated') {
    try {
      await restoreAccess(deps, q, actor, u.id, u.tracking_enabled);
    } catch (e) {
      // No seat free: back without tracking rather than not at all.
      if (!(e instanceof AppError) || (e.code !== 'seat_limit_reached' && e.code !== 'plan_upgrade_required')) throw e;
      await q.query('UPDATE users SET tracking_enabled = false WHERE id = $1', [u.id]);
      await restoreAccess(deps, q, actor, u.id, false);
    }
  }
}

export async function replaceUser(deps: Deps, q: Queryable, actor: DirectoryActor, base: string, id: string, body: Record<string, unknown>) {
  const u = await userRow(q, actor.organizationId, id);
  const c = userChanges(body);
  // PUT replaces: an omitted externalId is cleared.
  await applyUser(deps, q, actor, u, { ...c, externalId: c.externalId ?? null });
  return toUser(base, await userRow(q, actor.organizationId, id));
}

export async function patchUser(deps: Deps, q: Queryable, actor: DirectoryActor, base: string, id: string, body: unknown) {
  const u = await userRow(q, actor.organizationId, id);
  const c: UserChanges = {};
  let given: string | undefined;
  let family: string | undefined;
  const set = (path: string, v: unknown, remove: boolean) => {
    switch (path) {
      case 'active':
        c.active = truthy(v);
        break;
      case 'displayname':
      case 'name.formatted':
        if (typeof v === 'string' && v.trim()) c.displayName = v.trim().slice(0, 200);
        break;
      case 'name.givenname':
        if (typeof v === 'string') given = v.trim();
        break;
      case 'name.familyname':
        if (typeof v === 'string') family = v.trim();
        break;
      case 'name':
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) set(`name.${k.toLowerCase()}`, x, remove);
        break;
      case 'username':
        if (typeof v === 'string' && EMAIL.test(v.trim())) c.email = v.trim().toLowerCase();
        break;
      case 'externalid':
        c.externalId = remove ? null : typeof v === 'string' ? v : undefined;
        break;
      default:
      // Attributes Track doesn't keep (title, phone numbers, manager, …) are ignored.
    }
  };
  for (const op of patchOps(body)) {
    const kind = op.op.toLowerCase();
    if (!['add', 'replace', 'remove'].includes(kind)) throw scimError(400, `Unknown op ${op.op}`, 'invalidSyntax');
    if (op.path) set(op.path.toLowerCase(), op.value, kind === 'remove');
    else if (op.value && typeof op.value === 'object') for (const [k, v] of Object.entries(op.value)) set(k.toLowerCase(), v, kind === 'remove');
  }
  if (!c.displayName && given && family) c.displayName = `${given} ${family}`.slice(0, 200);
  await applyUser(deps, q, actor, u, c);
  return toUser(base, await userRow(q, actor.organizationId, id));
}

/** DELETE deactivates: Track keeps the person's hours, timesheets and pay. */
export async function deleteUser(deps: Deps, q: Queryable, actor: DirectoryActor, id: string): Promise<void> {
  const u = await userRow(q, actor.organizationId, id);
  await applyUser(deps, q, actor, u, { active: false });
}

// ───────────── Groups (teams) ─────────────

interface TeamRow {
  id: string;
  name: string;
  external_id: string | null;
  created_at: string;
}

const GROUP_FILTERS: Record<string, string> = { displayname: 'name', externalid: 'external_id' };

async function teamRow(q: Queryable, orgId: string, id: string): Promise<TeamRow> {
  const t = /^[0-9a-f-]{36}$/i.test(id)
    ? await one<TeamRow>(q, 'SELECT id, name, external_id, created_at FROM teams WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL', [orgId, id])
    : null;
  if (!t) throw scimError(404, `Group ${id} not found`, 'noTarget');
  return t;
}

async function toGroup(q: Queryable, base: string, t: TeamRow, withMembers: boolean) {
  const members = withMembers
    ? await many<{ value: string; display: string }>(
        q,
        `SELECT u.id AS value, u.display_name AS display FROM team_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1 AND m.valid_to IS NULL ORDER BY u.display_name`,
        [t.id],
      )
    : null;
  return {
    schemas: [SCIM.group],
    id: t.id,
    ...(t.external_id ? { externalId: t.external_id } : {}),
    displayName: t.name,
    ...(members ? { members: members.map((m) => ({ ...m, $ref: `${base}/Users/${m.value}` })) } : {}),
    meta: { resourceType: 'Group', created: t.created_at, location: `${base}/Groups/${t.id}` },
  };
}

const wantsMembers = (qs: { excludedAttributes?: string; attributes?: string }) =>
  !(qs.excludedAttributes ?? '').toLowerCase().split(',').includes('members') && (!qs.attributes || qs.attributes.toLowerCase().split(',').includes('members'));

export async function listGroups(q: Queryable, actor: DirectoryActor, base: string, qs: { filter?: string; startIndex?: string; count?: string; excludedAttributes?: string; attributes?: string }) {
  const f = parseFilter(qs.filter, GROUP_FILTERS);
  const { start, count } = paging(qs);
  const where = `organization_id = $1 AND archived_at IS NULL ${f ? `AND ${f.column} = $2` : ''}`;
  const args: unknown[] = f ? [actor.organizationId, f.value] : [actor.organizationId];
  const total = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM teams WHERE ${where}`, args);
  const rows = await many<TeamRow>(q, `SELECT id, name, external_id, created_at FROM teams WHERE ${where} ORDER BY created_at, id LIMIT ${count} OFFSET ${start - 1}`, args);
  const withMembers = wantsMembers(qs);
  return listResponse(await Promise.all(rows.map((r) => toGroup(q, base, r, withMembers))), total!.n, start);
}

export async function getGroup(q: Queryable, actor: DirectoryActor, base: string, id: string, qs: { excludedAttributes?: string; attributes?: string } = {}) {
  return toGroup(q, base, await teamRow(q, actor.organizationId, id), wantsMembers(qs));
}

const memberIds = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).map((m) => (typeof m === 'string' ? m : (m as { value?: unknown })?.value)).filter((x): x is string => typeof x === 'string');

/** Adds people as members; anyone already in the team keeps their role (a manager stays one). */
async function addMembers(q: Queryable, actor: DirectoryActor, teamId: string, ids: string[]) {
  for (const id of ids) {
    const u = /^[0-9a-f-]{36}$/i.test(id) ? await one(q, 'SELECT 1 FROM users WHERE organization_id = $1 AND id = $2', [actor.organizationId, id]) : null;
    if (!u) throw scimError(400, `No user ${id} in this organization`);
    const current = await one(q, 'SELECT 1 FROM team_memberships WHERE team_id = $1 AND user_id = $2 AND valid_to IS NULL', [teamId, id]);
    if (!current) await setTeamMember(q, actor, teamId, id, 'member');
  }
}

async function removeMembers(q: Queryable, actor: DirectoryActor, teamId: string, ids: string[]) {
  for (const id of ids) {
    const current = await one(q, 'SELECT 1 FROM team_memberships WHERE team_id = $1 AND user_id = $2 AND valid_to IS NULL', [teamId, id]);
    if (current) await removeTeamMember(q, actor, teamId, id);
  }
}

async function syncMembers(q: Queryable, actor: DirectoryActor, teamId: string, ids: string[]) {
  const current = await many<{ user_id: string }>(q, 'SELECT user_id FROM team_memberships WHERE team_id = $1 AND valid_to IS NULL', [teamId]);
  await removeMembers(q, actor, teamId, current.map((c) => c.user_id).filter((id) => !ids.includes(id)));
  await addMembers(q, actor, teamId, ids);
}

async function rename(q: Queryable, actor: DirectoryActor, t: TeamRow, name: unknown) {
  if (typeof name !== 'string' || !name.trim() || name.trim() === t.name) return;
  try {
    await renameTeam(q, actor, t.id, name.trim().slice(0, 200));
  } catch (e) {
    if (e instanceof AppError && e.code === 'name_taken') throw scimError(409, `A team named ${name} already exists`, 'uniqueness');
    throw e;
  }
}

/** A new team, or an existing one of that name that no directory group has claimed yet. */
export async function createGroup(q: Queryable, actor: DirectoryActor, base: string, body: Record<string, unknown>) {
  const name = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 200) : '';
  if (!name) throw scimError(400, 'displayName is required');
  const externalId = typeof body.externalId === 'string' ? body.externalId : null;
  const existing = await one<TeamRow & { archived_at: string | null }>(
    q,
    'SELECT id, name, external_id, created_at, archived_at FROM teams WHERE organization_id = $1 AND name = $2',
    [actor.organizationId, name],
  );
  let id: string;
  if (existing && !existing.archived_at) {
    if (existing.external_id) throw scimError(409, `A team named ${name} already exists`, 'uniqueness');
    id = existing.id;
    await audit(q, { organizationId: actor.organizationId, actor, action: 'team.linked', targetType: 'team', targetId: id, metadata: { via: 'scim' } });
  } else {
    id = (await createTeam(q, actor, name)).id;
  }
  await q.query('UPDATE teams SET external_id = $2 WHERE id = $1', [id, externalId]);
  await addMembers(q, actor, id, memberIds(body.members));
  return toGroup(q, base, await teamRow(q, actor.organizationId, id), true);
}

export async function replaceGroup(q: Queryable, actor: DirectoryActor, base: string, id: string, body: Record<string, unknown>) {
  const t = await teamRow(q, actor.organizationId, id);
  await rename(q, actor, t, body.displayName);
  if (typeof body.externalId === 'string' || body.externalId === undefined) await q.query('UPDATE teams SET external_id = $2 WHERE id = $1', [id, body.externalId ?? null]);
  if (body.members !== undefined) await syncMembers(q, actor, id, memberIds(body.members));
  return toGroup(q, base, await teamRow(q, actor.organizationId, id), true);
}

export async function patchGroup(q: Queryable, actor: DirectoryActor, base: string, id: string, body: unknown) {
  const t = await teamRow(q, actor.organizationId, id);
  for (const op of patchOps(body)) {
    const kind = op.op.toLowerCase();
    const path = op.path?.trim() ?? '';
    const filtered = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
    if (filtered) {
      if (kind === 'remove') await removeMembers(q, actor, id, [filtered[1]!]);
      else await addMembers(q, actor, id, [filtered[1]!]);
    } else if (path.toLowerCase() === 'members') {
      if (kind === 'add') await addMembers(q, actor, id, memberIds(op.value));
      else if (kind === 'remove') await removeMembers(q, actor, id, op.value === undefined ? (await many<{ user_id: string }>(q, 'SELECT user_id FROM team_memberships WHERE team_id = $1 AND valid_to IS NULL', [id])).map((m) => m.user_id) : memberIds(op.value));
      else await syncMembers(q, actor, id, memberIds(op.value));
    } else if (path.toLowerCase() === 'displayname') {
      await rename(q, actor, t, op.value);
    } else if (path.toLowerCase() === 'externalid') {
      await q.query('UPDATE teams SET external_id = $2 WHERE id = $1', [id, kind === 'remove' ? null : op.value]);
    } else if (!path && op.value && typeof op.value === 'object') {
      const v = op.value as Record<string, unknown>;
      await rename(q, actor, t, v.displayName);
      if (v.members !== undefined) await (kind === 'add' ? addMembers(q, actor, id, memberIds(v.members)) : syncMembers(q, actor, id, memberIds(v.members)));
      if (typeof v.externalId === 'string') await q.query('UPDATE teams SET external_id = $2 WHERE id = $1', [id, v.externalId]);
    }
  }
  return toGroup(q, base, await teamRow(q, actor.organizationId, id), true);
}

/** DELETE ends every membership and archives the team; its history stays. */
export async function deleteGroup(deps: Deps, q: Queryable, actor: DirectoryActor, id: string): Promise<void> {
  await teamRow(q, actor.organizationId, id);
  await q.query('UPDATE team_memberships SET valid_to = now() WHERE team_id = $1 AND valid_to IS NULL', [id]);
  await q.query('UPDATE teams SET archived_at = $2, external_id = NULL WHERE id = $1', [id, deps.now().toISOString()]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'team.archive', targetType: 'team', targetId: id, metadata: { via: 'scim' } });
}

// ───────────── discovery (RFC 7643 §5–6) ─────────────

export function serviceProviderConfig(base: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://rounddigital.example/docs/scim',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A directory token from Settings › Single sign-on', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}

export function resourceTypes(base: string) {
  const rt = (name: string, endpoint: string, schema: string) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: name,
    name,
    endpoint,
    schema,
    meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/${name}` },
  });
  return listResponse([rt('User', '/Users', SCIM.user), rt('Group', '/Groups', SCIM.group)], 2, 1);
}

export function schemas() {
  const attr = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
    name,
    type,
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...extra,
  });
  return listResponse(
    [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
        id: SCIM.user,
        name: 'User',
        attributes: [
          attr('userName', 'string', { required: true, uniqueness: 'server' }),
          attr('displayName', 'string'),
          attr('name', 'complex', { subAttributes: [attr('formatted', 'string'), attr('givenName', 'string'), attr('familyName', 'string')] }),
          attr('emails', 'complex', { multiValued: true, subAttributes: [attr('value', 'string'), attr('type', 'string'), attr('primary', 'boolean')] }),
          attr('active', 'boolean'),
          attr('externalId', 'string', { caseExact: true }),
        ],
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
        id: SCIM.group,
        name: 'Group',
        attributes: [
          attr('displayName', 'string', { required: true, uniqueness: 'server' }),
          attr('members', 'complex', { multiValued: true, subAttributes: [attr('value', 'string'), attr('display', 'string', { mutability: 'readOnly' })] }),
          attr('externalId', 'string', { caseExact: true }),
        ],
      },
    ],
    2,
    1,
  );
}
