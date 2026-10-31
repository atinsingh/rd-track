import { describe, expect, it } from 'vitest';
import type { Me } from '@rd/contracts';
import { accessFor, homeFor, homesFor, navFor } from './nav';
import { invoiceState, setupProgress, totalsByCurrency, weekDelta } from './workspaces';

const me = (role: Me['user']['org_role'], opts: { tracks?: boolean; teams?: string[]; entitlements?: Me['entitlements'] } = {}): Me => ({
  user: { id: 'u', email: 'e', display_name: 'D', org_role: role, timezone: 'UTC', tracking_enabled: opts.tracks ?? true, mfa_enabled: false, locale: null },
  organization: { id: 'o', name: 'Org', plan: 'pro', license: 'active', locale: null, logo_url: null },
  mfa_verified: true,
  managed_team_ids: opts.teams ?? [],
  managed_project_ids: [],
  entitlements: opts.entitlements ?? ['budgets_invoicing', 'timesheets'],
});
const homes = (m: Me) => homesFor(accessFor(m)).map((h) => h.href);

describe('role homes', () => {
  it('lands each role on its own home, with My day for anyone who tracks', () => {
    expect(homes(me('employee'))).toEqual(['/me']);
    expect(homes(me('employee', { teams: ['t'] }))).toEqual(['/team', '/me']);
    expect(homes(me('org_admin', { tracks: false }))).toEqual(['/admin', '/money']);
    expect(homes(me('finance', { tracks: false }))).toEqual(['/money']);
    expect(homes(me('auditor', { tracks: false }))).toEqual(['/audit']);
    // Someone with nothing else still has a home.
    expect(homes(me('employee', { tracks: false }))).toEqual(['/me']);
  });

  it('remembers a chosen home only while it is still theirs', () => {
    const a = accessFor(me('org_admin', { teams: ['t'] }));
    expect(homeFor(a, null)).toBe('/admin');
    expect(homeFor(a, '/team')).toBe('/team');
    expect(homeFor(a, '/audit')).toBe('/admin');
  });

  it('gives finance Money and nothing admin', () => {
    const items = navFor(accessFor(me('finance', { tracks: false }))).flatMap((g) => g.items.map((i) => i.href));
    expect(items).toEqual(expect.arrayContaining(['/money', '/admin/invoices', '/admin/rates', '/admin/clients']));
    expect(items).not.toContain('/admin');
    expect(items).not.toContain('/admin/users');
    expect(items).not.toContain('/audit');
    // No empty time pages for someone who never tracks; an employee with tracking off keeps their history.
    expect(items).not.toContain('/me/time');
    expect(navFor(accessFor(me('employee', { tracks: false }))).flatMap((g) => g.items.map((i) => i.href))).toContain('/me/time');
  });
});

describe('workspace helpers', () => {
  it('counts only required setup steps', () => {
    expect(
      setupProgress([
        { key: 'invite_people', done: true, optional: false },
        { key: 'connect_computer', done: false, optional: false },
        { key: 'timesheet_deadline', done: false, optional: true },
      ]),
    ).toEqual({ done: 1, total: 2, complete: false });
    expect(setupProgress([{ key: 'timesheet_deadline', done: false, optional: true }]).complete).toBe(true);
  });

  it('names an invoice by what finance has to do with it', () => {
    const issued = { status: 'issued' as const, paid_on: null, due_date: '2026-11-03' };
    expect(invoiceState(issued, '2026-11-03')).toBe('unpaid');
    expect(invoiceState(issued, '2026-11-04')).toBe('overdue');
    expect(invoiceState({ ...issued, paid_on: '2026-11-04' }, '2026-12-01')).toBe('paid');
    expect(invoiceState({ status: 'draft', paid_on: null, due_date: null }, '2026-12-01')).toBe('draft');
  });

  it('never adds money across currencies', () => {
    expect(totalsByCurrency([{ currency: 'USD', total_cents: 100 }, { currency: 'CAD', total_cents: 5 }, { currency: 'USD', total_cents: 50 }])).toEqual([
      { currency: 'CAD', total_cents: 5 },
      { currency: 'USD', total_cents: 150 },
    ]);
  });

  it('compares the week so far with all of last week', () => {
    expect(weekDelta(3600, 3600)).toBe('Same as last week so far');
    expect(weekDelta(7200, 3600)).toBe('1h 00m more than all of last week');
    expect(weekDelta(1800, 3600)).toBe('0h 30m less than all of last week');
  });
});
