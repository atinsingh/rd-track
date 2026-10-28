import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../lib/errors';

/**
 * Minimal Stripe REST client (form-encoded, API version pinned by the account).
 * Only the calls Track needs: customers, Checkout, Billing Portal, subscriptions.
 */
export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly apiBase = 'https://api.stripe.com',
  ) {
    if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  async request<T = Record<string, any>>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
    const body = method === 'GET' ? undefined : encodeForm(params);
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; type?: string } };
    if (!res.ok) {
      // Stripe's message is safe to log; it never contains card data.
      throw new AppError(502, 'billing_provider_error', `Billing provider error: ${json.error?.message ?? res.status}`);
    }
    return json as T;
  }

  createCustomer(p: { name: string; email: string; organizationId: string }) {
    return this.request<{ id: string }>('POST', '/v1/customers', {
      name: p.name,
      email: p.email,
      metadata: { organization_id: p.organizationId },
    }, `customer-${p.organizationId}`);
  }

  createCheckoutSession(p: { customer: string; price: string; quantity: number; organizationId: string; successUrl: string; cancelUrl: string }) {
    return this.request<{ id: string; url: string }>('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer: p.customer,
      client_reference_id: p.organizationId,
      line_items: [{ price: p.price, quantity: p.quantity }],
      subscription_data: { metadata: { organization_id: p.organizationId } },
      allow_promotion_codes: true,
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
    });
  }

  createPortalSession(p: { customer: string; returnUrl: string }) {
    return this.request<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer: p.customer, return_url: p.returnUrl });
  }

  updateSubscriptionItem(p: { subscription: string; item: string; price: string; quantity: number }) {
    return this.request('POST', `/v1/subscriptions/${encodeURIComponent(p.subscription)}`, {
      items: [{ id: p.item, price: p.price, quantity: p.quantity }],
      proration_behavior: 'create_prorations',
      cancel_at_period_end: false,
    });
  }

  cancelAtPeriodEnd(subscription: string) {
    return this.request('POST', `/v1/subscriptions/${encodeURIComponent(subscription)}`, { cancel_at_period_end: true });
  }
}

/** Stripe's nested form encoding: a[b][0][c]=v. */
export function encodeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.append(prefix, String(v));
  };
  walk('', params);
  return out.toString();
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, any> };
}

const TOLERANCE_SEC = 300;

/**
 * Verifies a `Stripe-Signature` header (`t=…,v1=…`): HMAC-SHA256 over `${t}.${rawBody}`
 * with the endpoint secret, within a 5-minute tolerance. Throws on any mismatch.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, nowSec: number): StripeEvent {
  if (!secret) throw new AppError(500, 'billing_not_configured', 'Webhook secret is not configured');
  const parts = Object.fromEntries((header ?? '').split(',').map((kv) => kv.split('=', 2) as [string, string]));
  const signatures = (header ?? '')
    .split(',')
    .filter((kv) => kv.startsWith('v1='))
    .map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || signatures.length === 0) throw new AppError(400, 'signature_invalid', 'Missing signature');
  if (Math.abs(nowSec - t) > TOLERANCE_SEC) throw new AppError(400, 'signature_invalid', 'Signature timestamp outside tolerance');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const ok = signatures.some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new AppError(400, 'signature_invalid', 'Signature mismatch');
  return JSON.parse(rawBody) as StripeEvent;
}

export function signStripePayload(rawBody: string, secret: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}
