import {
  deletionRequestCreate,
  exportCreateRequest,
  reviewRequest,
  timeCorrectionRequest,
  type DirectoryPerson,
  type DirectoryResponse,
  type MemberVisibility,
} from '@rd/contracts';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps, UserActor } from '../context';
import { isAdmin } from '../context';
import { many, withTx } from '../db/pool';
import { userOf } from '../http';
import { errors } from '../lib/errors';
import { parse, parseRange } from '../lib/validate';
import { activityFor, appsFor, projectReport, sessionsFor, teamReport } from './activity/queries';
import { accessLogFor, audit } from './audit/service';
import { assertCanView, managedProjectIds, managedTeamIds, visibilityFor, type ViewPurpose } from './authz';
import { myCorrections, pendingForReviewer, proposeCorrection, reviewCorrection } from './corrections/service';
import { createExport, getExport, listExports } from './exports/service';
import { listProjects, projectsForUser } from './org/service';
import { myPolicy, resolveFor } from './policy/service';
import { listNotifications, markNotificationRead, requestDeletion } from './privacy/service';
import { listScreenshots, viewUrl } from './screenshots/service';

type RangeReq = FastifyRequest<{ Querystring: { from?: string; to?: string; tz?: string } }>;

/** Employee self-service, people a manager may view, reports, corrections and exports. */
export async function peopleRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };

  // ───────── me ─────────
  app.get('/v1/me/sessions', user, async (req: RangeReq) => {
    const a = userOf(req);
    return { items: await sessionsFor(deps, pool, a.organizationId, a.userId, parseRange(req.query)) };
  });
  app.get('/v1/me/activity', user, async (req: RangeReq) => {
    const a = userOf(req);
    return activityFor(deps, pool, a.organizationId, a.userId, parseRange(req.query));
  });
  app.get('/v1/me/apps', user, async (req: RangeReq) => {
    const a = userOf(req);
    return appsFor(pool, a.organizationId, a.userId, parseRange(req.query));
  });
  app.get('/v1/me/screenshots', user, async (req: RangeReq) => {
    const a = userOf(req);
    return { items: await listScreenshots(pool, a.organizationId, a.userId, parseRange(req.query)) };
  });
  app.get('/v1/me/policy', user, async (req) => myPolicy(deps, pool, userOf(req)));
  app.get('/v1/me/access-log', user, async (req) => {
    const a = userOf(req);
    return { items: await accessLogFor(pool, a.organizationId, a.userId) };
  });
  app.get('/v1/me/projects', user, async (req) => {
    const a = userOf(req);
    return { items: await projectsForUser(pool, a.organizationId, a.userId) };
  });
  app.get('/v1/me/notifications', user, async (req) => ({ items: await listNotifications(pool, userOf(req).userId) }));
  app.post<{ Params: { id: string } }>('/v1/me/notifications/:id/read', user, async (req) => {
    await markNotificationRead(pool, userOf(req).userId, req.params.id);
    return { ok: true };
  });
  app.get('/v1/me/corrections', user, async (req) => ({ items: await myCorrections(pool, userOf(req)) }));
  app.post('/v1/me/time-corrections', user, async (req, reply) => {
    const body = parse(timeCorrectionRequest, req.body);
    const r = await withTx(pool, (tx) => proposeCorrection(deps, tx, userOf(req), body, req.id));
    return reply.code(201).send(r);
  });
  app.post('/v1/me/deletion-requests', user, async (req, reply) => {
    const body = parse(deletionRequestCreate, req.body);
    const r = await withTx(pool, (tx) => requestDeletion(deps, tx, userOf(req), body, req.id));
    return reply.code(201).send(r);
  });

  // ───────── people the actor may view (audited when it isn't themself) ─────────
  async function viewing(req: FastifyRequest<{ Params: { id: string } }>, purpose: ViewPurpose, action: string) {
    const actor = userOf(req);
    const target = req.params.id;
    await assertCanView(deps, pool, actor, target, purpose, { requestId: req.id });
    if (target !== actor.userId) {
      await audit(pool, {
        organizationId: actor.organizationId,
        actor,
        action,
        targetType: 'user',
        targetId: target,
        targetUserId: target,
        requestId: req.id,
      });
    }
    return { actor, target };
  }
  type UserReq = FastifyRequest<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>;
  app.get('/v1/users/:id/sessions', user, async (req: UserReq) => {
    const { actor, target } = await viewing(req, 'time', 'time.view');
    return { items: await sessionsFor(deps, pool, actor.organizationId, target, parseRange(req.query)) };
  });
  app.get('/v1/users/:id/activity', user, async (req: UserReq) => {
    const { actor, target } = await viewing(req, 'activity', 'activity.view');
    return activityFor(deps, pool, actor.organizationId, target, parseRange(req.query));
  });
  app.get('/v1/users/:id/apps', user, async (req: UserReq) => {
    const { actor, target } = await viewing(req, 'apps', 'apps.view');
    return appsFor(pool, actor.organizationId, target, parseRange(req.query));
  });
  app.get('/v1/users/:id/screenshots', user, async (req: UserReq) => {
    // Listing reveals capture times only; each image view is authorized and audited separately.
    const { actor, target } = await viewing(req, 'screenshots', 'screenshot.list');
    return { items: await listScreenshots(pool, actor.organizationId, target, parseRange(req.query)) };
  });
  app.get<{ Params: { id: string } }>('/v1/users/:id/visibility', user, async (req): Promise<MemberVisibility> => {
    const actor = userOf(req);
    await assertCanView(deps, pool, actor, req.params.id, 'time', { requestId: req.id });
    if (req.params.id === actor.userId) return { time: true, activity: true, apps: true, screenshots: true };
    const v = await visibilityFor(deps, pool, actor.organizationId, req.params.id);
    // Screenshot access is granted per project: check the projects this person tracked recently.
    const projects = await many<{ project_id: string }>(
      pool,
      `SELECT DISTINCT project_id FROM work_sessions
       WHERE user_id = $1 AND project_id IS NOT NULL AND started_at > now() - interval '90 days'`,
      [req.params.id],
    );
    let screenshots = v.screenshots;
    for (const p of projects) {
      if (screenshots) break;
      const { settings } = await resolveFor(deps, pool, actor.organizationId, req.params.id, { projectId: p.project_id });
      screenshots = settings.screenshots.enabled && settings.viewers.manager_can_view_screenshots;
    }
    return { time: true, activity: v.activity, apps: v.apps, screenshots };
  });
  app.get<{ Params: { id: string } }>('/v1/screenshots/:id/view-url', user, async (req) =>
    withTx(pool, (tx) => viewUrl(deps, tx, userOf(req), req.params.id, req.id)),
  );

  // ───────── team & project reports ─────────
  app.get('/v1/teams', user, async (req) => {
    const a = userOf(req);
    const ids = await managedTeamIds(pool, a.userId);
    return {
      items: await many(
        pool,
        `SELECT t.id, t.name, (SELECT count(*)::int FROM team_memberships m WHERE m.team_id = t.id AND m.valid_to IS NULL) AS member_count
         FROM teams t WHERE t.organization_id = $1 AND t.id = ANY($2::uuid[]) ORDER BY t.name`,
        [a.organizationId, ids],
      ),
    };
  });
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; tz?: string; project_id?: string } }>(
    '/v1/teams/:id/report',
    user,
    async (req) => {
      const a = userOf(req);
      if (!(await managedTeamIds(pool, a.userId)).includes(req.params.id)) throw errors.forbidden();
      const projectId = req.query.project_id ? parse(z.uuid(), req.query.project_id) : null;
      const report = await teamReport(deps, pool, a.organizationId, req.params.id, parseRange(req.query), tz(req.query.tz), projectId);
      await auditTeamView(a, report.members.map((m) => m.user_id), req.params.id, req.id);
      return report;
    },
  );
  // Names for jumping to a person or project (⌘K). Not a data view, so not audited as one.
  app.get('/v1/me/directory', user, async (req): Promise<DirectoryResponse> => {
    const a = userOf(req);
    const [teams, projects] = await Promise.all([managedTeamIds(pool, a.userId), managedProjectIds(pool, a.userId)]);
    const people = await many<DirectoryPerson>(
      pool,
      `SELECT DISTINCT ON (u.id) u.id AS user_id, u.display_name, t.id AS team_id, t.name AS team_name
       FROM team_memberships m JOIN teams t ON t.id = m.team_id JOIN users u ON u.id = m.user_id
       WHERE t.organization_id = $1 AND t.id = ANY($2::uuid[]) AND m.valid_to IS NULL
         AND u.status = 'active' AND u.id <> $3
       ORDER BY u.id, t.name`,
      [a.organizationId, teams, a.userId],
    );
    const list = projects.length ? await listProjects(pool, a.organizationId, projects) : [];
    return {
      people: people.sort((x, y) => x.display_name.localeCompare(y.display_name)),
      projects: list.filter((p) => p.status === 'active').map((p) => ({ id: p.id, name: p.name })),
    };
  });
  app.get('/v1/projects', user, async (req) => {
    const a = userOf(req);
    return { items: await listProjects(pool, a.organizationId, await managedProjectIds(pool, a.userId)) };
  });
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; tz?: string } }>(
    '/v1/projects/:id/report',
    user,
    async (req) => {
      const a = userOf(req);
      if (!(await managedProjectIds(pool, a.userId)).includes(req.params.id)) throw errors.forbidden();
      return projectReport(pool, a.organizationId, req.params.id, parseRange(req.query), tz(req.query.tz));
    },
  );

  // ───────── corrections review ─────────
  app.get('/v1/corrections/pending', user, async (req) => ({ items: await pendingForReviewer(pool, userOf(req)) }));
  for (const verb of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/v1/corrections/:id/${verb}`, user, async (req) => {
      const { note } = parse(reviewRequest, req.body ?? {});
      return withTx(pool, (tx) => reviewCorrection(deps, tx, userOf(req), req.params.id, verb === 'approve', note, req.id));
    });
  }

  // ───────── exports ─────────
  app.post('/v1/exports', user, async (req, reply) => {
    const body = parse(exportCreateRequest, req.body);
    const r = await withTx(pool, (tx) => createExport(deps, tx, userOf(req), body, req.id));
    return reply.code(201).send(r);
  });
  app.get('/v1/exports', user, async (req) => ({ items: await listExports(deps, pool, userOf(req)) }));
  app.get<{ Params: { id: string } }>('/v1/exports/:id', user, async (req) => getExport(deps, pool, userOf(req), req.params.id, req.id));

  async function auditTeamView(actor: UserActor, members: string[], teamId: string, requestId: string) {
    // One entry per member so each employee sees it under "Who viewed my data".
    for (const m of members) {
      if (m === actor.userId) continue;
      await audit(pool, {
        organizationId: actor.organizationId,
        actor,
        action: 'activity.view',
        targetType: 'team_report',
        targetId: teamId,
        targetUserId: m,
        requestId,
        metadata: { via: 'team_report', admin: isAdmin(actor) },
      });
    }
  }
}

function tz(v: string | undefined): string {
  if (!v) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return v;
  } catch {
    throw errors.validation('Unknown time zone');
  }
}
