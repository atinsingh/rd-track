import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, PASSWORD, testEnv, type Org, type TestEnv } from './helpers';

/** G27: language and formats for the organization and for each person. */

let env: TestEnv;
let org: Org;

beforeAll(async () => {
  env = await testEnv();
  org = await makeOrg(env, 'lang');
});
afterAll(async () => {
  await env.close();
});

describe('language and formats', () => {
  it('nobody has chosen at first: each browser decides', async () => {
    const me = (await org.users.emp!.client.get('/v1/me')).body;
    expect(me.user.locale).toBeNull();
    expect(me.organization.locale).toBeNull();
  });

  it('an admin sets the organization default; others can only read it', async () => {
    const r = await org.admin.put('/v1/admin/branding/locale', { locale: 'fr-CA' });
    expect(r.status).toBe(200);
    expect(r.body.locale).toBe('fr-CA');
    expect((await org.users.emp!.client.get('/v1/me')).body.organization.locale).toBe('fr-CA');
    expect((await org.users.emp!.client.put('/v1/admin/branding/locale', { locale: 'en-US' })).status).toBe(403);
    expect((await org.admin.put('/v1/admin/branding/locale', { locale: 'de-DE' })).status).toBe(400);
    const audit = await org.admin.get('/v1/audit-events?action=organization.locale_changed');
    expect(audit.body.items[0].metadata).toMatchObject({ locale: 'fr-CA' });
  });

  it('a person picks their own, and can go back to the default', async () => {
    const c = org.users.emp!.client;
    expect((await c.req('PATCH', '/v1/me', { locale: 'en-GB' })).status).toBe(200);
    expect((await c.get('/v1/me')).body.user.locale).toBe('en-GB');
    // Changing something else keeps it.
    await c.req('PATCH', '/v1/me', { display_name: 'Lang Emp' });
    expect((await c.get('/v1/me')).body.user).toMatchObject({ locale: 'en-GB', display_name: 'Lang Emp' });
    await c.req('PATCH', '/v1/me', { locale: null });
    expect((await c.get('/v1/me')).body.user.locale).toBeNull();
    expect((await c.req('PATCH', '/v1/me', { locale: 'xx' })).status).toBe(400);
  });
});

describe('what the server writes, in each reader’s language', () => {
  it('notifications, to-dos and emails follow the person, then the organization', async () => {
    // The organization is French (above); the manager chose English for themselves.
    await org.users.manager!.client.req('PATCH', '/v1/me', { locale: 'en-GB' });
    const emp2 = org.users.emp2!.client;

    // A security notice to someone following the organization: French.
    expect((await emp2.post('/v1/me/password', { current_password: PASSWORD, new_password: 'another-long-password-1' })).status).toBe(200);
    const fr = (await emp2.get('/v1/me/notifications')).body.items.find((n: { kind: string }) => n.kind === 'password_changed');
    expect(fr.title).toBe('Votre mot de passe a été changé');

    // To-dos are written when read, in the reader's language.
    const todos = (await emp2.get('/v1/me/todos')).body.items as { kind: string; title: string }[];
    expect(todos.find((x) => x.kind === 'connect_computer')?.title).toBe('Connectez votre ordinateur');
    const enTodos = (await org.users.manager!.client.get('/v1/me/todos')).body.items as { kind: string; title: string }[];
    expect(enTodos.find((x) => x.kind === 'connect_computer')?.title).toBe('Connect your computer');

    // Emails too: the reset link in French, its expiry and footer included.
    const before = env.email.sent.length;
    await env.app.inject({ method: 'POST', url: '/v1/auth/password-reset', payload: { email: 'manager@lang.test' } });
    await env.app.inject({ method: 'POST', url: '/v1/auth/password-reset', payload: { email: 'emp@lang.test' } });
    const [en, frMail] = env.email.sent.slice(before);
    expect(en!.subject).toBe('Reset your RoundDigital Track password');
    expect(frMail!.subject).toBe('Réinitialisez votre mot de passe RoundDigital Track');
    expect(frMail!.text).toContain('Le lien fonctionne une seule fois et expire dans');
    expect(frMail!.html).toContain('lang="fr-CA"');
  });
});
