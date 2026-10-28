import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeForm, signStripePayload } from '../src/billing/stripe';
import { makeOrg, testEnv, type TestEnv } from './helpers';

/** A tiny stand-in for the Stripe REST API that records requests. */
function fakeStripe() {
  const calls: { method: string; path: string; body: URLSearchParams }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = new URLSearchParams(raw);
      calls.push({ method: req.method!, path: req.url!, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer sk_test_123') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: 'bad key' } }));
      }
      if (req.url === '/v1/customers') return res.end(JSON.stringify({ id: 'cus_1' }));
      if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }));
      if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ url: 'https://billing.stripe.test/p_1' }));
      if (req.url?.startsWith('/v1/subscriptions/')) return res.end(JSON.stringify({ id: 'sub_1' }));
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return { server, calls };
}

const WEBHOOK_SECRET = 'whsec_test';
let env: TestEnv;
let stripe: ReturnType<typeof fakeStripe>;

beforeAll(async () => {
  stripe = fakeStripe();
  await new Promise<void>((r) => stripe.server.listen(0, '127.0.0.1', r));
  const port = (stripe.server.address() as AddressInfo).port;
  env = await testEnv({
    webUrl: 'https://app.track.test',
    billing: {
      provider: 'stripe',
      stripe: {
        secretKey: 'sk_test_123',
        webhookSecret: WEBHOOK_SECRET,
        apiBase: `http://127.0.0.1:${port}`,
        prices: { standard: 'price_std', pro: 'price_pro' },
      },
    },
  });
});
afterAll(async () => {
  await env.close();
  stripe.server.close();
});

async function webhook(event: object, opts: { secret?: string; t?: number } = {}) {
  const raw = JSON.stringify(event);
  const t = opts.t ?? Math.floor(env.clock.t / 1000);
  return env.app.inject({
    method: 'POST',
    url: '/v1/webhooks/billing/stripe',
    payload: raw,
    headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, opts.secret ?? WEBHOOK_SECRET, t) },
  });
}

describe('self-serve signup', () => {
  it('creates the organization only after email verification, on a Pro trial', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { org_name: 'Acme Studio', display_name: 'Ada', email: 'ada@acme.test', password: 'a-long-enough-password' },
    });
    expect(res.statusCode).toBe(202);
    expect(await env.deps.pool.query(`SELECT 1 FROM users WHERE email = 'ada@acme.test'`).then((r) => r.rowCount)).toBe(0);

    const mail = env.email.sent.at(-1)!;
    expect(mail.to).toBe('ada@acme.test');
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    expect(mail.text).toContain('https://app.track.test/signup/verify?token=');

    const verify = await env.app.inject({ method: 'POST', url: '/v1/signup/verify', payload: { token } });
    expect(verify.statusCode).toBe(201);
    const cookie = String(verify.headers['set-cookie']).split(';')[0]!;
    const me = await env.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    const body = JSON.parse(me.body);
    expect(body.user).toMatchObject({ email: 'ada@acme.test', org_role: 'org_admin', tracking_enabled: true });
    expect(body.organization).toMatchObject({ name: 'Acme Studio', plan: 'pro' });

    const again = await env.app.inject({ method: 'POST', url: '/v1/signup/verify', payload: { token } });
    expect(again.statusCode).toBe(400);
    expect(JSON.parse(again.body).error.code).toBe('signup_link_invalid');
  });

  it("doesn't reveal whether an email already has an account", async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { org_name: 'Again', display_name: 'Ada', email: 'ada@acme.test', password: 'a-long-enough-password' },
    });
    expect(res.statusCode).toBe(202);
    expect(env.email.sent.at(-1)!.subject).toMatch(/already have/);
    expect(env.email.sent.at(-1)!.text).not.toContain('token=');
  });
});

describe('Stripe billing', () => {
  it('sends a new paid plan to Checkout and applies it from the webhook', async () => {
    const org = await makeOrg(env, 'stripe1', 'free');
    const res = await org.admin.post('/v1/billing/plan', { plan: 'pro', seats: 4 });
    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.stripe.test/cs_1');
    expect(res.body.subscription.plan).toBe('free'); // nothing changes until payment

    const checkout = stripe.calls.find((c) => c.path === '/v1/checkout/sessions')!;
    expect(checkout.body.get('line_items[0][price]')).toBe('price_pro');
    expect(checkout.body.get('line_items[0][quantity]')).toBe('4');
    expect(checkout.body.get('client_reference_id')).toBe(org.id);
    expect(checkout.body.get('success_url')).toBe('https://app.track.test/admin/billing?checkout=success');

    const sub = {
      id: 'evt_sub_created',
      type: 'customer.subscription.created',
      created: 0,
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          cancel_at_period_end: false,
          metadata: { organization_id: org.id },
          items: { data: [{ id: 'si_1', quantity: 4, price: { id: 'price_pro' }, current_period_end: 1795000000 }] },
        },
      },
    };
    expect((await webhook(sub)).statusCode).toBe(200);
    const after = await org.admin.get('/v1/billing/subscription');
    expect(after.body).toMatchObject({ plan: 'pro', seats: 4, status: 'active', billing_provider: 'stripe', estimated_monthly_cents: 2000 });

    // Replays are ignored.
    expect((await webhook(sub)).statusCode).toBe(200);
    const processed = await env.deps.pool.query(`SELECT count(*)::int AS n FROM billing_webhook_events WHERE event_id = 'evt_sub_created'`);
    expect(processed.rows[0].n).toBe(1);

    // With a live subscription, seat changes update it in place.
    const more = await org.admin.post('/v1/billing/plan', { plan: 'pro', seats: 6 });
    expect(more.body.checkout_url).toBeNull();
    expect(more.body.subscription.seats).toBe(6);
    const update = stripe.calls.find((c) => c.path === '/v1/subscriptions/sub_1')!;
    expect(update.body.get('items[0][id]')).toBe('si_1');
    expect(update.body.get('items[0][quantity]')).toBe('6');

    const portal = await org.admin.post('/v1/billing/portal');
    expect(portal.body.url).toBe('https://billing.stripe.test/p_1');
  });

  it('moves to grace on payment failure and back on payment', async () => {
    const org = await makeOrg(env, 'stripe2', 'pro', 5);
    await env.deps.pool.query(`UPDATE subscriptions SET provider = 'stripe', provider_customer_id = 'cus_2' WHERE organization_id = $1`, [org.id]);
    await webhook({ id: 'evt_fail', type: 'invoice.payment_failed', created: 0, data: { object: { customer: 'cus_2' } } });
    expect((await org.admin.get('/v1/billing/subscription')).body).toMatchObject({ status: 'grace', license: 'grace' });
    await webhook({ id: 'evt_paid', type: 'invoice.paid', created: 0, data: { object: { customer: 'cus_2' } } });
    expect((await org.admin.get('/v1/billing/subscription')).body).toMatchObject({ status: 'active', license: 'active' });
    await webhook({ id: 'evt_del', type: 'customer.subscription.deleted', created: 0, data: { object: { id: 'sub_x', customer: 'cus_2', metadata: {} } } });
    // 3 tracked users > Free's 2: grace, not an abrupt stop.
    expect((await org.admin.get('/v1/billing/subscription')).body).toMatchObject({ plan: 'free', status: 'grace' });
  });

  it('rejects unsigned, mis-signed and stale webhooks', async () => {
    const event = { id: 'evt_bad', type: 'invoice.paid', created: 0, data: { object: { customer: 'cus_2' } } };
    expect((await webhook(event, { secret: 'whsec_wrong' })).statusCode).toBe(400);
    expect((await webhook(event, { t: Math.floor(env.clock.t / 1000) - 3600 })).statusCode).toBe(400);
    const unsigned = await env.app.inject({ method: 'POST', url: '/v1/webhooks/billing/stripe', payload: JSON.stringify(event), headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(400);
  });

  it('encodes nested parameters the way Stripe expects', () => {
    expect(decodeURIComponent(encodeForm({ a: 1, line_items: [{ price: 'p', quantity: 2 }], metadata: { org: 'x' } }))).toBe(
      'a=1&line_items[0][price]=p&line_items[0][quantity]=2&metadata[org]=x',
    );
  });
});
