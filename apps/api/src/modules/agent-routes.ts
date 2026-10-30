import {
  MAX_BATCH_BYTES,
  devicePolicyQuery,
  deviceWorkLimitsQuery,
  enrollRequest,
  eventBatchSchema,
  heartbeatRequest,
  screenshotCompleteRequest,
  sessionCreateRequest,
  sessionStopRequest,
  uploadIntentRequest,
  type DeviceProjectsResponse,
  type DeviceScheduleTodayResponse,
  type DeviceWorkLimitsResponse,
} from '@rd/contracts';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { deviceOf } from '../http';
import { AppError, errors } from '../lib/errors';
import { parse } from '../lib/validate';
import { assertLicensedForTracking } from './billing/service';
import { enroll, heartbeat } from './devices/service';
import { deviceUpdate } from './devices/updates';
import { projectsForUser } from './org/service';
import { deviceScheduleToday } from './scheduling/service';
import { deviceWorkLimits } from './timesheets/service';
import { ingestBatch } from './ingestion/service';
import { signedPolicyForDevice } from './policy/service';
import { completeUpload, createUploadIntent } from './screenshots/service';
import { changeSessionState, getSessionForDevice, startSession } from './sessions/service';

/** Agent-facing endpoints (system design §5.2). Request bodies are never logged. */
export async function agentRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;

  app.post(
    '/v1/devices/enroll',
    { config: { auth: 'public', rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(enrollRequest, req.body);
      const res = await withTx(pool, (tx) => enroll(deps, tx, body, req.id));
      return reply.code(201).send(res);
    },
  );

  app.post('/v1/device/heartbeat', { config: { auth: 'device' } }, async (req) => {
    const body = parse(heartbeatRequest, req.body);
    return withTx(pool, (tx) => heartbeat(deps, tx, deviceOf(req), body));
  });

  // G10: the desktop app's updater asks here with its device credential.
  const updateQuery = z.object({ target: z.string().max(20), arch: z.string().max(20), current_version: z.string().max(40) });
  app.get('/v1/device/update', { config: { auth: 'device' } }, async (req, reply) => {
    const q = parse(updateQuery, req.query);
    const u = await deviceUpdate(deps.config.agentDownloads, pool, deviceOf(req), q, deps.now().getTime());
    return u ? u : reply.code(204).send();
  });

  app.get('/v1/device/projects', { config: { auth: 'device' } }, async (req): Promise<DeviceProjectsResponse> => {
    const d = deviceOf(req);
    const projects = await projectsForUser(pool, d.organizationId, d.userId);
    return { projects: projects.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks })) };
  });

  app.get('/v1/device/policy', { config: { auth: 'device' } }, async (req) => {
    const { project_id } = parse(devicePolicyQuery, req.query);
    return signedPolicyForDevice(deps, pool, deviceOf(req), project_id ?? null);
  });

  // Stage 4 F4 / F3: what the tray needs for limit warnings and reminders. Reads only the device's own user.
  app.get('/v1/device/work-limits', { config: { auth: 'device' } }, async (req): Promise<DeviceWorkLimitsResponse> => {
    const { exclude_session_id } = parse(deviceWorkLimitsQuery, req.query);
    return deviceWorkLimits(deps, pool, deviceOf(req), exclude_session_id ?? null);
  });

  app.get('/v1/device/schedule-today', { config: { auth: 'device' } }, async (req): Promise<DeviceScheduleTodayResponse> =>
    deviceScheduleToday(deps, pool, deviceOf(req)),
  );

  app.post('/v1/ingestion/event-batches', { config: { auth: 'device' }, bodyLimit: MAX_BATCH_BYTES }, async (req) => {
    const batch = parse(eventBatchSchema, req.body);
    return ingestBatch(deps, deviceOf(req), batch, req.id);
  });

  // REST equivalents of the lifecycle events, for online clients.
  app.post('/v1/sessions', { config: { auth: 'device' } }, async (req, reply) => {
    const body = parse(sessionCreateRequest, req.body);
    const device = deviceOf(req);
    const session = await withTx(pool, async (tx) => {
      await assertLicensedForTracking(tx, device.organizationId, device.userId, deps.now());
      const rev = await tx.query<{ policy_revision: number }>('SELECT policy_revision FROM organizations WHERE id = $1', [
        device.organizationId,
      ]);
      const r = await startSession(deps, tx, device, {
        sessionId: body.session_id,
        projectId: body.project_id,
        taskId: body.task_id,
        at: deps.now(),
        clientAt: body.client_started_at,
        policyRevision: rev.rows[0]!.policy_revision,
      });
      if (!r.ok) throw errors.conflict(r.reason, `Session could not be started: ${r.reason}`);
      return getSessionForDevice(tx, device, body.session_id);
    });
    return reply.code(201).send(session);
  });

  for (const [action, to] of [
    ['pause', 'paused'],
    ['resume', 'active'],
    ['stop', 'stopped'],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/v1/sessions/:id/${action}`, { config: { auth: 'device' } }, async (req) => {
      const device = deviceOf(req);
      const reason = action === 'stop' ? parse(sessionStopRequest, req.body ?? {}).reason : action === 'pause' ? 'user' : 'resume';
      return withTx(pool, async (tx) => {
        const r = await changeSessionState(tx, device, req.params.id, to, deps.now(), reason);
        if (!r.ok) throw errors.notFound('Session');
        return getSessionForDevice(tx, device, req.params.id);
      });
    });
  }

  app.post('/v1/screenshots/upload-intents', { config: { auth: 'device' } }, async (req, reply) => {
    const body = parse(uploadIntentRequest, req.body);
    const res = await withTx(pool, (tx) => createUploadIntent(deps, tx, deviceOf(req), body));
    return reply.code(201).send(res);
  });

  app.post('/v1/screenshots/complete', { config: { auth: 'device' } }, async (req) => {
    const body = parse(screenshotCompleteRequest, req.body);
    const r = await withTx(pool, (tx) => completeUpload(deps, tx, deviceOf(req), body));
    // The discard is committed before the agent is told (SCR-02).
    if (r.status === 'discarded') {
      throw new AppError(403, 'session_not_active', 'The capture time is outside the active session; the image was discarded');
    }
    if (r.status === 'not_blurred') {
      throw new AppError(403, 'blur_required', 'The policy blurs screenshots and this one was not blurred; it was discarded. Update the app.');
    }
    return r;
  });
}
