import { userImportRow, type AdminProjectDTO, type ProjectDTO, type UserDTO, type UserImportResponse, type UserImportResult } from '@rd/contracts';
import type { Deps, OrgActor, UserActor } from '../../context';
import { many, one, withTx, type Queryable } from '../../db/pool';
import { existsAnywhere } from '../../db/tenant-scope';
import type { EmailMessage } from '../../email/sender';
import { hashPassword } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { inviteUser } from '../auth/identity';
import { publish } from '../engine/events';
import { assertSeatAvailable } from '../billing/service';
import { isValidTimeZone } from '../scheduling/tz';

const USER_SELECT = `
  SELECT u.id, u.email, u.display_name, u.org_role, u.status, u.tracking_enabled, u.mfa_enabled, u.timezone, u.created_at,
    u.password_hash IS NULL AS invite_pending, u.invited_at,
    COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'role', m.role) ORDER BY t.name)
              FROM team_memberships m JOIN teams t ON t.id = m.team_id
              WHERE m.user_id = u.id AND m.valid_to IS NULL), '[]') AS teams
  FROM users u`;

export async function listUsers(q: Queryable, orgId: string): Promise<UserDTO[]> {
  return many<UserDTO>(q, `${USER_SELECT} WHERE u.organization_id = $1 ORDER BY u.display_name`, [orgId]);
}

async function getUser(q: Queryable, orgId: string, id: string): Promise<UserDTO> {
  const u = await one<UserDTO>(q, `${USER_SELECT} WHERE u.organization_id = $1 AND u.id = $2`, [orgId, id]);
  if (!u) throw errors.notFound('User');
  return u;
}

export async function createUser(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: {
    email: string;
    display_name: string;
    org_role: UserDTO['org_role'];
    tracking_enabled: boolean;
    timezone: string;
    password?: string;
  },
  requestId?: string,
): Promise<{ user: UserDTO; invite: EmailMessage | null }> {
  if (input.org_role === 'super_admin' && actor.orgRole !== 'super_admin') throw errors.forbidden();
  if (input.tracking_enabled) await assertSeatAvailable(q, actor.organizationId, deps.now());
  // Addresses are unique across organizations, so look beyond this one.
  const exists = await existsAnywhere(deps.pool, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email]);
  if (exists) throw errors.conflict('email_taken', 'A user with this email already exists');
  // No password: the person is invited and chooses their own.
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO users (organization_id, email, display_name, password_hash, org_role, tracking_enabled, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [actor.organizationId, input.email, input.display_name, input.password ? await hashPassword(input.password) : null, input.org_role, input.tracking_enabled, input.timezone],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'user.create',
    targetType: 'user',
    targetId: r!.id,
    targetUserId: r!.id,
    requestId,
    metadata: { org_role: input.org_role, tracking_enabled: input.tracking_enabled },
  });
  const invite = input.password ? null : await inviteUser(deps, q, { orgId: actor.organizationId, userId: r!.id, invitedBy: actor, requestId });
  return { user: await getUser(q, actor.organizationId, r!.id), invite };
}

export async function updateUser(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  id: string,
  patch: Partial<Pick<UserDTO, 'display_name' | 'org_role' | 'tracking_enabled' | 'timezone'>>,
  requestId?: string,
): Promise<UserDTO> {
  const before = await getUser(q, actor.organizationId, id);
  if ((patch.org_role === 'super_admin' || before.org_role === 'super_admin') && actor.orgRole !== 'super_admin') {
    throw errors.forbidden();
  }
  if (patch.org_role && patch.org_role !== before.org_role) {
    // Nobody changes their own role (another admin can), and the last admin can't stop being one.
    if (id === actor.userId) throw errors.validation('Ask another admin to change your role');
    if (before.org_role === 'org_admin' && before.status === 'active') await assertAnotherAdmin(q, actor.organizationId, id);
  }
  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw errors.validation('Choose a valid time zone');
  if (patch.tracking_enabled === true && !before.tracking_enabled && before.status === 'active') {
    await assertSeatAvailable(q, actor.organizationId, deps.now());
  }
  await q.query(
    `UPDATE users SET display_name = COALESCE($3, display_name), org_role = COALESCE($4, org_role),
       tracking_enabled = COALESCE($5, tracking_enabled), timezone = COALESCE($6, timezone)
     WHERE organization_id = $1 AND id = $2`,
    [actor.organizationId, id, patch.display_name ?? null, patch.org_role ?? null, patch.tracking_enabled ?? null, patch.timezone ?? null],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'user.update',
    targetType: 'user',
    targetId: id,
    targetUserId: id,
    requestId,
    metadata: { fields: Object.keys(patch) },
  });
  return getUser(q, actor.organizationId, id);
}

export async function assertAnotherAdmin(q: Queryable, orgId: string, exceptId: string) {
  const r = await one<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM users WHERE organization_id = $1 AND id <> $2 AND status = 'active' AND org_role IN ('org_admin', 'super_admin')`,
    [orgId, exceptId],
  );
  if (!r?.n) throw errors.conflict('last_admin', 'Your organization needs at least one other active admin first');
}

/**
 * Brings a deactivated person back (G14). They sign in with their old password (or accept
 * a fresh invite), enrol their computer again and are added back to teams; nothing that
 * deactivation ended comes back by itself.
 */
export async function reactivateUser(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<UserDTO> {
  const user = await getUser(q, actor.organizationId, id);
  if (user.status === 'active') throw errors.conflict('already_active', 'This person is already active');
  if (user.org_role === 'super_admin' && actor.orgRole !== 'super_admin') throw errors.forbidden();
  await restoreAccess(deps, q, actor, id, user.tracking_enabled, requestId);
  return getUser(q, actor.organizationId, id);
}

/** Reactivation itself, shared with the directory (SCIM `active: true`). */
export async function restoreAccess(deps: Deps, q: Queryable, actor: OrgActor, id: string, tracking: boolean, requestId?: string): Promise<void> {
  const erased = await one(q, 'SELECT 1 FROM users WHERE id = $1 AND erased_at IS NOT NULL', [id]);
  if (erased) throw errors.conflict('erased', "This person's data was erased; invite them again as a new person");
  if (tracking) await assertSeatAvailable(q, actor.organizationId, deps.now());
  await q.query(`UPDATE users SET status = 'active', deactivated_at = NULL WHERE organization_id = $1 AND id = $2`, [actor.organizationId, id]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'user.reactivate', targetType: 'user', targetId: id, targetUserId: id, requestId });
}

/** IAM-05: deactivation ends sessions, revokes devices and stops open work sessions immediately. */
export async function deactivateUser(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<UserDTO> {
  const user = await getUser(q, actor.organizationId, id);
  if (id === actor.userId) throw errors.validation('You cannot deactivate yourself');
  if (user.org_role === 'super_admin' && actor.orgRole !== 'super_admin') throw errors.forbidden();
  await endAccess(deps, q, actor, id, requestId);
  return getUser(q, actor.organizationId, id);
}

/** Deactivation itself, shared with the directory (SCIM `active: false`). */
export async function endAccess(deps: Deps, q: Queryable, actor: OrgActor, id: string, requestId?: string): Promise<void> {
  const now = deps.now().toISOString();
  await q.query(`UPDATE users SET status = 'deactivated', deactivated_at = $3 WHERE organization_id = $1 AND id = $2`, [
    actor.organizationId,
    id,
    now,
  ]);
  await q.query('UPDATE user_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [id, now]);
  await q.query(
    `UPDATE devices SET credential_status = 'revoked', revoked_at = $2 WHERE user_id = $1 AND credential_status = 'active'`,
    [id, now],
  );
  const open = await many<{ id: string }>(
    q,
    `UPDATE work_sessions SET state = 'stopped', ended_at = $2, stop_reason = 'revoked', updated_at = now()
     WHERE user_id = $1 AND state IN ('active', 'paused') RETURNING id`,
    [id, now],
  );
  for (const s of open) {
    await q.query(
      `INSERT INTO session_transitions (session_id, organization_id, state, at, reason) VALUES ($1, $2, 'stopped', $3, 'revoked')`,
      [s.id, actor.organizationId, now],
    );
  }
  await q.query(`UPDATE team_memberships SET valid_to = $2 WHERE user_id = $1 AND valid_to IS NULL`, [id, now]);
  await q.query(`UPDATE project_memberships SET valid_to = $2 WHERE user_id = $1 AND valid_to IS NULL`, [id, now]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'user.deactivate',
    targetType: 'user',
    targetId: id,
    targetUserId: id,
    requestId,
    metadata: { stopped_sessions: open.length },
  });
  await publish(q, { organizationId: actor.organizationId, type: 'user.deactivated', subjectUserId: id, actorUserId: actor.kind === 'user' ? actor.userId : null });
}

// ───────────── teams ─────────────

export interface AdminTeam {
  id: string;
  name: string;
  member_count: number;
  members: { user_id: string; display_name: string; role: 'member' | 'manager' }[];
}

export async function listTeams(q: Queryable, orgId: string): Promise<AdminTeam[]> {
  return many<AdminTeam>(
    q,
    `SELECT t.id, t.name,
       (SELECT count(*)::int FROM team_memberships m WHERE m.team_id = t.id AND m.valid_to IS NULL) AS member_count,
       COALESCE((SELECT json_agg(json_build_object('user_id', u.id, 'display_name', u.display_name, 'role', m.role)
                                 ORDER BY u.display_name)
                 FROM team_memberships m JOIN users u ON u.id = m.user_id
                 WHERE m.team_id = t.id AND m.valid_to IS NULL), '[]') AS members
     FROM teams t WHERE t.organization_id = $1 AND t.archived_at IS NULL ORDER BY t.name`,
    [orgId],
  );
}

export async function createTeam(q: Queryable, actor: OrgActor, name: string, requestId?: string) {
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO teams (organization_id, name) VALUES ($1, $2)
     ON CONFLICT (organization_id, name) DO NOTHING RETURNING id`,
    [actor.organizationId, name],
  );
  if (!r) {
    // Creating a team with an archived team's name brings that team back.
    const archived = await one<{ id: string }>(
      q,
      `UPDATE teams SET archived_at = NULL WHERE organization_id = $1 AND name = $2 AND archived_at IS NOT NULL RETURNING id`,
      [actor.organizationId, name],
    );
    if (!archived) throw errors.conflict('name_taken', 'A team with this name already exists');
    await audit(q, { organizationId: actor.organizationId, actor, action: 'team.restore', targetType: 'team', targetId: archived.id, requestId });
    return { id: archived.id, name };
  }
  await audit(q, { organizationId: actor.organizationId, actor, action: 'team.create', targetType: 'team', targetId: r.id, requestId });
  return { id: r.id, name };
}

async function activeTeam(q: Queryable, orgId: string, teamId: string) {
  const t = await one<{ id: string; name: string; archived_at: string | null }>(q, 'SELECT id, name, archived_at FROM teams WHERE id = $1 AND organization_id = $2', [teamId, orgId]);
  if (!t || t.archived_at) throw errors.notFound('Team');
  return t;
}

export async function renameTeam(q: Queryable, actor: OrgActor, teamId: string, name: string, requestId?: string) {
  const t = await activeTeam(q, actor.organizationId, teamId);
  if (t.name === name) return { id: teamId, name };
  if (await one(q, 'SELECT 1 FROM teams WHERE organization_id = $1 AND name = $2', [actor.organizationId, name])) {
    throw errors.conflict('name_taken', 'A team with this name already exists');
  }
  await q.query('UPDATE teams SET name = $2 WHERE id = $1', [teamId, name]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'team.rename', targetType: 'team', targetId: teamId, requestId, metadata: { from: t.name, to: name } });
  return { id: teamId, name };
}

/** Only an empty team can be archived, so nobody silently loses their manager or their access. */
export async function archiveTeam(deps: Pick<Deps, 'now'>, q: Queryable, actor: OrgActor, teamId: string, requestId?: string) {
  await activeTeam(q, actor.organizationId, teamId);
  const n = await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM team_memberships WHERE team_id = $1 AND valid_to IS NULL', [teamId]);
  if (n?.n) throw errors.conflict('team_not_empty', 'Move or remove everyone in this team first');
  await q.query('UPDATE teams SET archived_at = $2 WHERE id = $1', [teamId, deps.now().toISOString()]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'team.archive', targetType: 'team', targetId: teamId, requestId });
  return { ok: true as const };
}

/** Adds or changes a membership; a role change closes the old row and opens a new one (IAM-07). */
export async function setTeamMember(
  q: Queryable,
  actor: OrgActor,
  teamId: string,
  userId: string,
  role: 'member' | 'manager',
  requestId?: string,
) {
  await activeTeam(q, actor.organizationId, teamId);
  await assertInOrg(q, actor.organizationId, 'users', userId, 'User');
  const current = await one<{ id: string; role: string }>(
    q,
    'SELECT id, role FROM team_memberships WHERE team_id = $1 AND user_id = $2 AND valid_to IS NULL',
    [teamId, userId],
  );
  if (current?.role === role) return;
  if (current) await q.query('UPDATE team_memberships SET valid_to = now() WHERE id = $1', [current.id]);
  await q.query(`INSERT INTO team_memberships (organization_id, team_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
    actor.organizationId,
    teamId,
    userId,
    role,
  ]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'team.member_set',
    targetType: 'team',
    targetId: teamId,
    targetUserId: userId,
    requestId,
    metadata: { role },
  });
}

export async function removeTeamMember(q: Queryable, actor: OrgActor, teamId: string, userId: string, requestId?: string) {
  await assertInOrg(q, actor.organizationId, 'teams', teamId, 'Team');
  await q.query('UPDATE team_memberships SET valid_to = now() WHERE team_id = $1 AND user_id = $2 AND valid_to IS NULL', [
    teamId,
    userId,
  ]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'team.member_removed',
    targetType: 'team',
    targetId: teamId,
    targetUserId: userId,
    requestId,
  });
}

// ───────────── projects & tasks ─────────────

const PROJECT_SELECT = `
  SELECT p.id, p.name, p.client_ref, p.status,
    COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name)
              FROM tasks t WHERE t.project_id = p.id AND t.status = 'active'), '[]') AS tasks
  FROM projects p`;

export async function listProjects(q: Queryable, orgId: string, onlyIds?: string[]): Promise<ProjectDTO[]> {
  return many<ProjectDTO>(
    q,
    `${PROJECT_SELECT} WHERE p.organization_id = $1 AND ($2::uuid[] IS NULL OR p.id = ANY($2)) ORDER BY p.name`,
    [orgId, onlyIds ?? null],
  );
}

/** Projects a user can book time to: memberships, or every active project when the org uses none. */
export async function projectsForUser(q: Queryable, orgId: string, userId: string): Promise<ProjectDTO[]> {
  return many<ProjectDTO>(
    q,
    `${PROJECT_SELECT} WHERE p.organization_id = $1 AND p.status = 'active' AND (
       p.id IN (SELECT project_id FROM project_memberships WHERE user_id = $2 AND valid_to IS NULL)
       OR NOT EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id AND pm.valid_to IS NULL))
     ORDER BY p.name`,
    [orgId, userId],
  );
}

export async function createProject(q: Queryable, actor: UserActor, name: string, clientRef: string | undefined, requestId?: string) {
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO projects (organization_id, name, client_ref) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, name) DO NOTHING RETURNING id`,
    [actor.organizationId, name, clientRef ?? null],
  );
  if (!r) throw errors.conflict('name_taken', 'A project with this name already exists');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'project.create', targetType: 'project', targetId: r.id, requestId });
  return (await listProjects(q, actor.organizationId, [r.id]))[0]!;
}

export async function createTask(q: Queryable, actor: UserActor, projectId: string, name: string, requestId?: string) {
  await assertInOrg(q, actor.organizationId, 'projects', projectId, 'Project');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO tasks (organization_id, project_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, name) DO NOTHING RETURNING id`,
    [actor.organizationId, projectId, name],
  );
  if (!r) throw errors.conflict('name_taken', 'A task with this name already exists');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'task.create', targetType: 'task', targetId: r.id, requestId });
  return { id: r.id, name };
}

export async function setProjectMember(
  q: Queryable,
  actor: UserActor,
  projectId: string,
  userId: string,
  role: 'member' | 'manager',
  requestId?: string,
) {
  await assertInOrg(q, actor.organizationId, 'projects', projectId, 'Project');
  await assertInOrg(q, actor.organizationId, 'users', userId, 'User');
  const current = await one<{ id: string; role: string }>(
    q,
    'SELECT id, role FROM project_memberships WHERE project_id = $1 AND user_id = $2 AND valid_to IS NULL',
    [projectId, userId],
  );
  if (current?.role === role) return;
  if (current) await q.query('UPDATE project_memberships SET valid_to = now() WHERE id = $1', [current.id]);
  await q.query(`INSERT INTO project_memberships (organization_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
    actor.organizationId,
    projectId,
    userId,
    role,
  ]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'project.member_set',
    targetType: 'project',
    targetId: projectId,
    targetUserId: userId,
    requestId,
    metadata: { role },
  });
}

/** The admin list adds who is on each project (members' names aren't shown to employees). */
export async function listAdminProjects(q: Queryable, orgId: string): Promise<AdminProjectDTO[]> {
  return many<AdminProjectDTO>(
    q,
    `SELECT p.id, p.name, p.client_ref, p.status,
       COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name)
                 FROM tasks t WHERE t.project_id = p.id AND t.status = 'active'), '[]') AS tasks,
       COALESCE((SELECT json_agg(json_build_object('user_id', u.id, 'display_name', u.display_name, 'role', m.role) ORDER BY u.display_name)
                 FROM project_memberships m JOIN users u ON u.id = m.user_id
                 WHERE m.project_id = p.id AND m.valid_to IS NULL), '[]') AS members
     FROM projects p WHERE p.organization_id = $1 ORDER BY p.name`,
    [orgId],
  );
}

export async function updateProject(
  q: Queryable,
  actor: UserActor,
  projectId: string,
  patch: { name?: string; client_ref?: string | null; status?: 'active' | 'archived' },
  requestId?: string,
): Promise<ProjectDTO> {
  await assertInOrg(q, actor.organizationId, 'projects', projectId, 'Project');
  if (patch.name && (await one(q, 'SELECT 1 FROM projects WHERE organization_id = $1 AND name = $2 AND id <> $3', [actor.organizationId, patch.name, projectId]))) {
    throw errors.conflict('name_taken', 'A project with this name already exists');
  }
  await q.query(
    `UPDATE projects SET name = COALESCE($2, name), status = COALESCE($3, status),
       client_ref = CASE WHEN $4::boolean THEN $5 ELSE client_ref END WHERE id = $1`,
    [projectId, patch.name ?? null, patch.status ?? null, patch.client_ref !== undefined, patch.client_ref || null],
  );
  const action = patch.status === 'archived' ? 'project.archive' : patch.status === 'active' ? 'project.restore' : 'project.update';
  await audit(q, { organizationId: actor.organizationId, actor, action, targetType: 'project', targetId: projectId, requestId, metadata: { fields: Object.keys(patch) } });
  return (await listProjects(q, actor.organizationId, [projectId]))[0]!;
}

export async function updateTask(
  q: Queryable,
  actor: UserActor,
  projectId: string,
  taskId: string,
  patch: { name?: string; status?: 'active' | 'archived' },
  requestId?: string,
) {
  const t = await one<{ id: string }>(q, 'SELECT id FROM tasks WHERE id = $1 AND project_id = $2 AND organization_id = $3', [taskId, projectId, actor.organizationId]);
  if (!t) throw errors.notFound('Task');
  if (patch.name && (await one(q, 'SELECT 1 FROM tasks WHERE project_id = $1 AND name = $2 AND id <> $3', [projectId, patch.name, taskId]))) {
    throw errors.conflict('name_taken', 'A task with this name already exists');
  }
  await q.query('UPDATE tasks SET name = COALESCE($2, name), status = COALESCE($3, status) WHERE id = $1', [taskId, patch.name ?? null, patch.status ?? null]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: patch.status === 'archived' ? 'task.archive' : 'task.update',
    targetType: 'task',
    targetId: taskId,
    requestId,
  });
  return { ok: true as const };
}

export async function removeProjectMember(q: Queryable, actor: UserActor, projectId: string, userId: string, requestId?: string) {
  await assertInOrg(q, actor.organizationId, 'projects', projectId, 'Project');
  await q.query('UPDATE project_memberships SET valid_to = now() WHERE project_id = $1 AND user_id = $2 AND valid_to IS NULL', [projectId, userId]);
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'project.member_removed',
    targetType: 'project',
    targetId: projectId,
    targetUserId: userId,
    requestId,
  });
}

// ───────────── CSV import (G14) ─────────────

/** Rolls back a dry run after every row was tried. */
class DryRunDone extends Error {}
/** Rolls back one rejected row, carrying why. */
class RowRejected extends Error {
  constructor(readonly result: UserImportResult) {
    super(result.message);
  }
}

/**
 * Invites people from CSV rows. Every row goes through createUser (same seat, email and
 * role rules as one invite), each in its own transaction, so one bad row never blocks the
 * others. A dry run tries every row in one transaction, each behind a savepoint so the
 * rows see each other (duplicates, seats), then rolls everything back.
 */
export async function importUsers(deps: Deps, actor: UserActor, rows: readonly unknown[], dryRun: boolean, requestId?: string): Promise<UserImportResponse> {
  const results: UserImportResult[] = [];
  const seen = new Set<string>();
  const invites: EmailMessage[] = [];

  const tryRow = async (q: Queryable, i: number, raw: unknown): Promise<UserImportResult> => {
    const email = typeof (raw as { email?: unknown })?.email === 'string' ? (raw as { email: string }).email.trim() : null;
    const parsed = userImportRow.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return { row: i + 1, email, ok: false, code: 'validation_failed', message: `${issue.path.join('.') || 'row'}: ${issue.message}` };
    }
    const r = parsed.data;
    const key = r.email.toLowerCase();
    if (seen.has(key)) return { row: i + 1, email: r.email, ok: false, code: 'duplicate_row', message: 'This email appears earlier in the file' };
    seen.add(key);
    if (!isValidTimeZone(r.timezone)) return { row: i + 1, email: r.email, ok: false, code: 'validation_failed', message: `timezone: ${r.timezone} is not a time zone` };
    try {
      const { user, invite } = await createUser(deps, q, actor, { ...r, password: undefined }, requestId);
      let team: UserImportResult['team'];
      if (r.team) {
        const existing = await one<{ id: string }>(q, 'SELECT id FROM teams WHERE organization_id = $1 AND name = $2 AND archived_at IS NULL', [actor.organizationId, r.team]);
        const teamId = existing?.id ?? (await createTeam(q, actor, r.team, requestId)).id;
        await setTeamMember(q, actor, teamId, user.id, 'member', requestId);
        team = existing ? 'joined' : 'created';
      }
      if (invite) invites.push(invite);
      return { row: i + 1, email: r.email, ok: true, user_id: dryRun ? undefined : user.id, ...(team ? { team } : {}) };
    } catch (e) {
      if (e instanceof AppError) return { row: i + 1, email: r.email, ok: false, code: e.code, message: e.message };
      throw e;
    }
  };

  if (dryRun) {
    try {
      await withTx(deps.pool, async (tx) => {
        for (const [i, raw] of rows.entries()) {
          await tx.query('SAVEPOINT import_row');
          const res = await tryRow(tx, i, raw);
          await tx.query(res.ok ? 'RELEASE SAVEPOINT import_row' : 'ROLLBACK TO SAVEPOINT import_row');
          results.push(res);
        }
        throw new DryRunDone();
      });
    } catch (e) {
      if (!(e instanceof DryRunDone)) throw e;
    }
  } else {
    for (const [i, raw] of rows.entries()) {
      // Per row: a failed row rolls back alone. The invite goes out after its row commits.
      const before = invites.length;
      let res: UserImportResult;
      try {
        res = await withTx(deps.pool, async (tx) => {
          const r = await tryRow(tx, i, raw);
          if (!r.ok) throw new RowRejected(r);
          return r;
        });
      } catch (e) {
        if (!(e instanceof RowRejected)) throw e;
        res = e.result;
        invites.length = before;
      }
      results.push(res);
      if (res.ok && invites.length > before) await deps.email.send(invites[invites.length - 1]!);
    }
  }
  const ok = results.filter((r) => r.ok).length;
  return { dry_run: dryRun, ok, failed: results.length - ok, results };
}

export async function assertInOrg(q: Queryable, orgId: string, table: 'teams' | 'projects' | 'users' | 'tasks' | 'devices', id: string, what: string) {
  const r = await one(q, `SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`, [id, orgId]);
  if (!r) throw errors.notFound(what);
}
