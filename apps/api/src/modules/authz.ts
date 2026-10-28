import type { Deps, UserActor } from '../context';
import { many, one, type Queryable } from '../db/pool';
import { errors } from '../lib/errors';
import { audit } from './audit/service';
import { resolveFor } from './policy/service';

/**
 * The single gate for reading another person's data (system design §3).
 * Every read of someone else's time, activity, apps or screenshots calls this.
 */
export type ViewPurpose = 'time' | 'activity' | 'apps' | 'screenshots';

export async function managedTeamIds(q: Queryable, userId: string): Promise<string[]> {
  return (
    await many<{ team_id: string }>(
      q,
      `SELECT team_id FROM team_memberships WHERE user_id = $1 AND role = 'manager' AND valid_to IS NULL`,
      [userId],
    )
  ).map((r) => r.team_id);
}

export async function managedProjectIds(q: Queryable, userId: string): Promise<string[]> {
  return (
    await many<{ project_id: string }>(
      q,
      `SELECT project_id FROM project_memberships WHERE user_id = $1 AND role = 'manager' AND valid_to IS NULL`,
      [userId],
    )
  ).map((r) => r.project_id);
}

export async function isTeamManagerOf(q: Queryable, managerId: string, targetUserId: string): Promise<boolean> {
  const r = await one(
    q,
    `SELECT 1 FROM team_memberships m JOIN team_memberships t ON t.team_id = m.team_id
     WHERE m.user_id = $1 AND m.role = 'manager' AND m.valid_to IS NULL
       AND t.user_id = $2 AND t.valid_to IS NULL LIMIT 1`,
    [managerId, targetUserId],
  );
  return r !== null;
}

/** 404 when the user is in another organization (no existence oracle). */
export async function assertSameOrgUser(q: Queryable, actor: UserActor, targetUserId: string): Promise<void> {
  const r = await one(q, 'SELECT 1 FROM users WHERE id = $1 AND organization_id = $2', [targetUserId, actor.organizationId]);
  if (!r) throw errors.notFound('User');
}

export async function assertCanView(
  deps: Pick<Deps, 'now' | 'pool'>,
  q: Queryable,
  actor: UserActor,
  targetUserId: string,
  purpose: ViewPurpose,
  opts: { projectId?: string | null; requestId?: string } = {},
): Promise<void> {
  await assertSameOrgUser(q, actor, targetUserId);
  if (actor.userId === targetUserId) return;

  let allowed = false;
  if (await isTeamManagerOf(q, actor.userId, targetUserId)) {
    if (purpose === 'time') {
      allowed = true;
    } else {
      const { settings } = await resolveFor(deps, q, actor.organizationId, targetUserId, { projectId: opts.projectId });
      allowed =
        (purpose === 'activity' && settings.viewers.manager_can_view_activity) ||
        (purpose === 'apps' && settings.viewers.manager_can_view_apps) ||
        (purpose === 'screenshots' && settings.screenshots.enabled && settings.viewers.manager_can_view_screenshots);
    }
  }
  if (!allowed) {
    if (purpose === 'screenshots') {
      // Written outside the caller's transaction, which rolls back when we throw.
      await audit(deps.pool, {
        organizationId: actor.organizationId,
        actor,
        action: 'screenshot.view',
        targetType: 'user',
        targetId: targetUserId,
        targetUserId,
        result: 'denied',
        requestId: opts.requestId,
      });
    }
    throw errors.forbidden();
  }
}

/** What a manager may see for one member, for UI hints. */
export async function visibilityFor(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  targetUserId: string,
): Promise<{ activity: boolean; apps: boolean; screenshots: boolean }> {
  const { settings } = await resolveFor(deps, q, orgId, targetUserId);
  return {
    activity: settings.viewers.manager_can_view_activity,
    apps: settings.viewers.manager_can_view_apps,
    screenshots: settings.viewers.manager_can_view_screenshots,
  };
}
