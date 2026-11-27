import { adminConsentUpdate, consentDecisionRequest } from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../context';
import { one, withTx } from '../db/pool';
import { ADMIN_ROLES, deviceOf, requireRole, userOf } from '../http';
import { errors } from '../lib/errors';
import { parse } from '../lib/validate';
import { adminConsent, deviceConsent, personConsent, recordDecision, setAgreementText } from './consent/service';

/**
 * Device routes that track (or would apply a newer policy) and so need an accepted
 * agreement; checked in app.ts right after the device is authenticated. Pausing and
 * stopping stay open so a session can always end.
 */
export const CONSENT_GATED_ROUTES = new Set([
  'POST /v1/device/heartbeat',
  'GET /v1/device/policy',
  'POST /v1/ingestion/event-batches',
  'POST /v1/sessions',
  'POST /v1/sessions/:id/resume',
  'POST /v1/screenshots/upload-intents',
  'POST /v1/screenshots/complete',
]);

/** The monitoring agreement: the app's ask-and-answer, people's own record, admins' editor. */
export async function consentRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const device = { config: { auth: 'device' as const } };

  app.get('/v1/device/consent', device, async (req) => deviceConsent(deps, pool, deviceOf(req)));
  app.post('/v1/device/consent', device, async (req) => {
    const body = parse(consentDecisionRequest, req.body);
    // req.ip honours only the trusted proxy hops (app.ts), so a client can't name its own address.
    return withTx(pool, (tx) => recordDecision(deps, tx, deviceOf(req), body, req.ip, req.id));
  });

  app.get('/v1/me/consent', user, async (req) => {
    const a = userOf(req);
    return personConsent(pool, a.organizationId, a.userId);
  });
  app.get<{ Params: { id: string } }>('/v1/users/:id/consent', user, async (req) => {
    const a = requireRole(req, ADMIN_ROLES);
    const id = parse(z.uuid(), req.params.id);
    if (!(await one(pool, 'SELECT 1 FROM users WHERE id = $1 AND organization_id = $2', [id, a.organizationId]))) {
      throw errors.notFound('User');
    }
    return personConsent(pool, a.organizationId, id);
  });

  app.get('/v1/admin/consent', user, async (req) => adminConsent(deps, pool, requireRole(req, ADMIN_ROLES)));
  app.put('/v1/admin/consent', user, async (req) => {
    const a = requireRole(req, ADMIN_ROLES);
    const { custom_text } = parse(adminConsentUpdate, req.body);
    return withTx(pool, (tx) => setAgreementText(deps, tx, a, custom_text, req.id));
  });
}
