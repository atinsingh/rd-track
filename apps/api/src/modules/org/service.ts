import type { ProjectDTO, UserDTO } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import type { EmailMessage } from '../../email/sender';
import { hashPassword } from '../../lib/crypto';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { inviteUser } from '../auth/identity';
import { publish } from '../engine/events';
import { assertSeatAvailable } from '../billing/service';

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
  const exists = await one(q, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email]);
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

/** IAM-05: deactivation ends sessions, revokes devices and stops open work sessions immediately. */
export async function deactivateUser(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<UserDTO> {
  const user = await getUser(q, actor.organizationId, id);
  if (id === actor.userId) throw errors.validation('You cannot deactivate yourself');
  if (user.org_role === 'super_admin' && actor.orgRole !== 'super_admin') throw errors.forbidden();
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
  await publish(q, { organizationId: actor.organizationId, type: 'user.deactivated', subjectUserId: id, actorUserId: actor.userId });
  return getUser(q, actor.organizationId, id);
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
     FROM teams t WHERE t.organization_id = $1 ORDER BY t.name`,
    [orgId],
  );
}

export async function createTeam(q: Queryable, actor: UserActor, name: string, requestId?: string) {
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO teams (organization_id, name) VALUES ($1, $2)
     ON CONFLICT (organization_id, name) DO NOTHING RETURNING id`,
    [actor.organizationId, name],
  );
  if (!r) throw errors.conflict('name_taken', 'A team with this name already exists');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'team.create', targetType: 'team', targetId: r.id, requestId });
  return { id: r.id, name };
}

/** Adds or changes a membership; a role change closes the old row and opens a new one (IAM-07). */
export async function setTeamMember(
  q: Queryable,
  actor: UserActor,
  teamId: string,
  userId: string,
  role: 'member' | 'manager',
  requestId?: string,
) {
  await assertInOrg(q, actor.organizationId, 'teams', teamId, 'Team');
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

export async function removeTeamMember(q: Queryable, actor: UserActor, teamId: string, userId: string, requestId?: string) {
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

export async function assertInOrg(q: Queryable, orgId: string, table: 'teams' | 'projects' | 'users' | 'tasks' | 'devices', id: string, what: string) {
  const r = await one(q, `SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`, [id, orgId]);
  if (!r) throw errors.notFound(what);
}
