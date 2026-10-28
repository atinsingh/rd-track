import { randomUUID, createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { WebhookDeliveryDTO, WebhookEndpointDTO, WebhookEventType, WebhookPayload } from '@rd/contracts';
import type { Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { enqueue } from '../../jobs/queue';
import { decryptSecret, encryptSecret, randomToken } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit/service';

/**
 * Outbound webhooks (INT-03). Payloads carry ids and timestamps only. Each POST is
 * signed (`x-rd-signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">`), retried with
 * backoff by the job queue, and only ever sent to public https addresses.
 */

const SELECT = `SELECT id, url, description, events, active, created_at FROM webhook_endpoints`;

export async function listEndpoints(q: Queryable, orgId: string): Promise<WebhookEndpointDTO[]> {
  return many<WebhookEndpointDTO>(q, `${SELECT} WHERE organization_id = $1 ORDER BY created_at`, [orgId]);
}

export async function createEndpoint(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  input: { url: string; description?: string; events: WebhookEventType[] },
  requestId?: string,
): Promise<WebhookEndpointDTO> {
  await assertPublicHttps(input.url);
  const secret = `whsec_${randomToken(24)}`;
  const r = await one<WebhookEndpointDTO>(
    q,
    `INSERT INTO webhook_endpoints (organization_id, url, description, events, secret_enc, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, url, description, events, active, created_at`,
    [actor.organizationId, input.url, input.description ?? null, input.events, encryptSecret(deps.config.appEncryptionKey, secret), actor.userId],
  );
  await audit(q, {
    organizationId: actor.organizationId,
    actor,
    action: 'webhook.create',
    targetType: 'webhook',
    targetId: r!.id,
    requestId,
    metadata: { host: new URL(input.url).host, events: input.events },
  });
  return { ...r!, signing_secret: secret };
}

export async function deleteEndpoint(q: Queryable, actor: UserActor, id: string, requestId?: string) {
  const r = await q.query('DELETE FROM webhook_endpoints WHERE id = $1 AND organization_id = $2', [id, actor.organizationId]);
  if (r.rowCount === 0) throw errors.notFound('Webhook');
  await audit(q, { organizationId: actor.organizationId, actor, action: 'webhook.delete', targetType: 'webhook', targetId: id, requestId });
}

export async function listDeliveries(q: Queryable, orgId: string, endpointId: string): Promise<WebhookDeliveryDTO[]> {
  return many<WebhookDeliveryDTO>(
    q,
    `SELECT id, event_type, status, attempts, last_status_code, last_error, created_at, delivered_at
     FROM webhook_deliveries WHERE organization_id = $1 AND endpoint_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [orgId, endpointId],
  );
}

/**
 * Queues one delivery per subscribed endpoint. Called inside the transaction that
 * produced the event, so a rolled-back change never notifies anyone.
 */
export async function emitEvent(
  q: Queryable,
  orgId: string,
  type: WebhookEventType | 'webhook.test',
  data: WebhookPayload['data'],
  onlyEndpointId?: string,
): Promise<number> {
  const endpoints = await many<{ id: string }>(
    q,
    `SELECT id FROM webhook_endpoints WHERE organization_id = $1 AND active AND ($2::uuid IS NOT NULL AND id = $2 OR $2::uuid IS NULL AND $3 = ANY(events))`,
    [orgId, onlyEndpointId ?? null, type],
  );
  if (endpoints.length === 0) return 0;
  const payload: WebhookPayload = { id: randomUUID(), type, created_at: new Date().toISOString(), organization_id: orgId, data };
  for (const e of endpoints) {
    const d = await one<{ id: string }>(
      q,
      `INSERT INTO webhook_deliveries (organization_id, endpoint_id, event_id, event_type, payload) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, e.id, payload.id, type, payload],
    );
    await enqueue(q, 'webhook.deliver', { delivery_id: d!.id }, { organizationId: orgId, maxAttempts: 10 });
  }
  return endpoints.length;
}

export function signWebhook(body: string, secret: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Worker: one attempt. Throws to let the queue retry with backoff. */
export async function deliver(deps: Deps, q: Queryable, deliveryId: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
  const d = await one<{ id: string; payload: WebhookPayload; status: string; url: string; secret_enc: string; active: boolean }>(
    q,
    `SELECT d.id, d.payload, d.status, e.url, e.secret_enc, e.active FROM webhook_deliveries d
     JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = $1`,
    [deliveryId],
  );
  if (!d || d.status !== 'pending' || !d.active) return;
  const body = JSON.stringify(d.payload);
  let status: number | null = null;
  let error: string | null = null;
  try {
    await assertPublicHttps(d.url);
    const res = await fetchImpl(d.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'RoundDigital-Track-Webhooks/1',
        'x-rd-event': d.payload.type,
        'x-rd-signature': signWebhook(body, decryptSecret(deps.config.appEncryptionKey, d.secret_enc), Math.floor(Date.now() / 1000)),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (res.status >= 200 && res.status < 300) {
      await q.query(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_status_code = $2, last_error = NULL, delivered_at = now() WHERE id = $1`,
        [d.id, status],
      );
      return;
    }
    error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message.slice(0, 300);
  }
  await q.query(`UPDATE webhook_deliveries SET attempts = attempts + 1, last_status_code = $2, last_error = $3 WHERE id = $1`, [d.id, status, error]);
  throw new Error(`webhook delivery failed: ${error}`);
}

/** After the queue gives up: mark it failed so admins see it. */
export async function markFailed(q: Queryable, deliveryId: string) {
  await q.query(`UPDATE webhook_deliveries SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [deliveryId]);
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

/** SSRF guard: https only, and the host must resolve to public addresses. */
export async function assertPublicHttps(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw errors.validation('Invalid URL');
  }
  if (u.protocol !== 'https:') throw errors.validation('Webhook URLs must use https');
  if (process.env.WEBHOOKS_ALLOW_PRIVATE === 'true') return; // local development and tests only
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw errors.validation('Webhook host does not resolve');
  if (addresses.some(isPrivateAddress)) throw new AppError(400, 'webhook_url_not_public', 'Webhook URLs must point to a public address');
}
