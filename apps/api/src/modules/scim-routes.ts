import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { directoryOf } from '../http';
import { AppError } from '../lib/errors';
import * as scim from './scim/service';

type Qs = { filter?: string; startIndex?: string; count?: string; excludedAttributes?: string; attributes?: string };
const KNOWN_SCIM_TYPES = new Set(['uniqueness', 'invalidFilter', 'invalidValue', 'invalidSyntax', 'mutability', 'noTarget', 'tooMany']);

const asObject = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw scim.scimError(400, 'Expected a JSON object', 'invalidSyntax');
  return body as Record<string, unknown>;
};

/**
 * SCIM 2.0 for the organization's directory (Entra ID, Okta, Google, JumpCloud…): slice 6b,
 * G26. Authenticated with a directory token (`Authorization: Bearer rdscim_…`).
 */
export async function scimRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const base = `${deps.config.webUrl}/scim/v2`;
  const dir = { config: { auth: 'directory' as const } };

  app.addContentTypeParser('application/scim+json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(new AppError(400, 'invalidSyntax', 'Body is not valid JSON'), undefined);
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    if (String(reply.getHeader('content-type') ?? '').startsWith('application/json')) reply.header('content-type', 'application/scim+json; charset=utf-8');
    return payload;
  });
  // RFC 7644 §3.12 errors, whatever went wrong.
  app.setErrorHandler((caught, req, reply) => {
    const err = caught as Error & { statusCode?: number };
    const status = err instanceof AppError ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err: { message: err.message } }, 'scim error');
    const code = err instanceof AppError ? err.code : '';
    return reply.code(status).send({
      schemas: [scim.SCIM.error],
      status: String(status),
      ...(KNOWN_SCIM_TYPES.has(code) ? { scimType: code } : {}),
      detail: status >= 500 ? 'Something went wrong' : err.message,
    });
  });

  const run = <T>(fn: (tx: Parameters<Parameters<typeof withTx>[1]>[0]) => Promise<T>) => withTx(pool, fn);
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get('/scim/v2/ServiceProviderConfig', dir, async (req) => (directoryOf(req), scim.serviceProviderConfig(base)));
  app.get('/scim/v2/ResourceTypes', dir, async (req) => (directoryOf(req), scim.resourceTypes(base)));
  app.get('/scim/v2/Schemas', dir, async (req) => (directoryOf(req), scim.schemas()));

  app.get<{ Querystring: Qs }>('/scim/v2/Users', dir, async (req) => scim.listUsers(pool, directoryOf(req), base, req.query));
  app.get('/scim/v2/Users/:id', dir, async (req) => scim.getUser(pool, directoryOf(req), base, id(req)));
  app.post('/scim/v2/Users', dir, async (req, reply) => {
    const a = directoryOf(req);
    const { resource, mail } = await run((tx) => scim.createUser(deps, tx, a, base, asObject(req.body)));
    for (const m of mail) await deps.email.send(m);
    return reply.code(201).send(resource);
  });
  app.put('/scim/v2/Users/:id', dir, async (req) => {
    const a = directoryOf(req);
    return run((tx) => scim.replaceUser(deps, tx, a, base, id(req), asObject(req.body)));
  });
  app.patch('/scim/v2/Users/:id', dir, async (req) => {
    const a = directoryOf(req);
    return run((tx) => scim.patchUser(deps, tx, a, base, id(req), req.body));
  });
  app.delete('/scim/v2/Users/:id', dir, async (req, reply) => {
    const a = directoryOf(req);
    await run((tx) => scim.deleteUser(deps, tx, a, id(req)));
    return reply.code(204).send();
  });

  app.get<{ Querystring: Qs }>('/scim/v2/Groups', dir, async (req) => scim.listGroups(pool, directoryOf(req), base, req.query));
  app.get<{ Querystring: Qs }>('/scim/v2/Groups/:id', dir, async (req) => scim.getGroup(pool, directoryOf(req), base, id(req), req.query));
  app.post('/scim/v2/Groups', dir, async (req, reply) => {
    const a = directoryOf(req);
    return reply.code(201).send(await run((tx) => scim.createGroup(tx, a, base, asObject(req.body))));
  });
  app.put('/scim/v2/Groups/:id', dir, async (req) => {
    const a = directoryOf(req);
    return run((tx) => scim.replaceGroup(tx, a, base, id(req), asObject(req.body)));
  });
  app.patch('/scim/v2/Groups/:id', dir, async (req) => {
    const a = directoryOf(req);
    return run((tx) => scim.patchGroup(tx, a, base, id(req), req.body));
  });
  app.delete('/scim/v2/Groups/:id', dir, async (req, reply) => {
    const a = directoryOf(req);
    await run((tx) => scim.deleteGroup(deps, tx, a, id(req)));
    return reply.code(204).send();
  });
}
