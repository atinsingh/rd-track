import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context';
import { AppError } from '../lib/errors';
import { LocalObjectStore } from './object-store';

/** Serves LocalObjectStore's signed URLs. Registered only when that store is in use. */
export async function localStorageRoutes(app: FastifyInstance, deps: Deps) {
  const store = deps.store;
  if (!(store instanceof LocalObjectStore)) return;
  app.addContentTypeParser(/^(image\/.*|text\/csv.*|application\/octet-stream)$/, { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );
  type Req = { Params: { '*': string }; Querystring: { method?: string; exp?: string; sig?: string } };
  const check = (method: string, key: string, q: Req['Querystring']) => {
    if (q.method !== method || !store.verify(method, key, Number(q.exp), q.sig ?? '')) {
      throw new AppError(403, 'signature_invalid', 'Signed URL is invalid or expired');
    }
  };
  app.put<Req>('/v1/_storage/*', { config: { auth: 'public' } }, async (req) => {
    const key = decodeURIComponent(req.params['*']);
    check('PUT', key, req.query);
    await store.put(key, req.body as Buffer, String(req.headers['content-type'] ?? 'application/octet-stream'));
    return { ok: true };
  });
  app.get<Req>('/v1/_storage/*', { config: { auth: 'public' } }, async (req, reply) => {
    const key = decodeURIComponent(req.params['*']);
    check('GET', key, req.query);
    const body = await store.get(key);
    if (!body) throw new AppError(404, 'not_found', 'Object not found');
    const type = key.endsWith('.csv') ? 'text/csv' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return reply.type(type).send(body);
  });
}
