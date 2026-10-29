import { describe, expect, it } from 'vitest';
import type { Me } from '@rd/contracts';
import { buildPath, parseErrorBody, unwrapList } from './api';
import { stackDaily } from './charts';
import { accessFor, activeHref, groupOf, navFor } from './nav';

describe('api helpers', () => {
  it('parses the error envelope', () => {
    const e = parseErrorBody(409, { error: { code: 'expansion_requires_confirmation', message: 'Confirm', request_id: 'r1', details: { affected_users: 3, changes: [] } } });
    expect(e).toMatchObject({ status: 409, code: 'expansion_requires_confirmation', requestId: 'r1' });
    expect(e.details).toEqual({ affected_users: 3, changes: [] });
    expect(parseErrorBody(401, undefined, 'h1')).toMatchObject({ code: 'unauthenticated', requestId: 'h1' });
    expect(parseErrorBody(502, 'x').code).toBe('http_502');
  });
  it('builds query strings and unwraps lists', () => {
    expect(buildPath('/v1/x', { from: 'a b', to: undefined, n: 2 })).toBe('/v1/x?from=a+b&n=2');
    expect(unwrapList({ items: [1, 2] })).toEqual([1, 2]);
    expect(unwrapList([3])).toEqual([3]);
    expect(unwrapList(undefined)).toEqual([]);
  });
});

describe('navigation by role', () => {
  const me = (over: Partial<Me['user']>, teams: string[] = [], projects: string[] = []): Me => ({
    user: { id: 'u', email: 'e', display_name: 'D', org_role: 'employee', timezone: 'UTC', tracking_enabled: true, mfa_enabled: false, ...over },
    organization: { id: 'o', name: 'Org', plan: 'standard', license: 'active' },
    mfa_verified: false,
    managed_team_ids: teams,
    managed_project_ids: projects,
    entitlements: [],
  });
  const hrefs = (m: Me) => navFor(accessFor(m)).flatMap((g) => g.items.map((i) => i.href));

  it('shows employees only their own pages', () => {
    expect(hrefs(me({}))).toEqual(['/me', '/me/time', '/me/insights', '/me/computers', '/me/privacy', '/me/settings', '/exports']);
  });
  it('adds team pages for managers and admin pages for admins', () => {
    expect(hrefs(me({}, ['t1']))).toContain('/approvals');
    expect(hrefs(me({}, [], ['p1']))).toContain('/projects');
    const admin = hrefs(me({ org_role: 'org_admin' }));
    expect(admin).toContain('/admin/policies');
    expect(admin).toContain('/audit');
    expect(admin).not.toContain('/team');
    // Webhooks are a Pro feature.
    expect(admin).not.toContain('/admin/webhooks');
    expect(navFor(accessFor({ ...me({ org_role: 'org_admin' }), entitlements: ['webhooks'] })).flatMap((g) => g.items.map((i) => i.href))).toContain('/admin/webhooks');
  });
  it('gives auditors the audit log only, under Settings', () => {
    const groups = navFor(accessFor(me({ org_role: 'auditor' })));
    expect(groups.map((g) => g.label)).toEqual(['Me', 'Settings']);
    expect(groups[1]!.items.map((i) => i.href)).toEqual(['/audit']);
  });
  it('groups an admin\u2019s pages into Me, Money, Admin and Settings', () => {
    const groups = navFor(accessFor({ ...me({ org_role: 'org_admin' }), entitlements: ['budgets_invoicing', 'webhooks'] }));
    expect(groups.map((g) => g.key)).toEqual(['me', 'money', 'admin', 'settings']);
    expect(groupOf(groups, '/admin/billing')).toBe('settings');
    expect(groupOf(groups, '/admin/invoices')).toBe('money');
    expect(groupOf(groups, null)).toBeNull();
  });
  it('highlights the longest matching item', () => {
    const groups = navFor(accessFor(me({}, ['t1'])));
    expect(activeHref(groups, '/me/time')).toBe('/me/time');
    expect(activeHref(groups, '/team/abc')).toBe('/team');
  });
});

describe('stackDaily', () => {
  it('keeps the top projects and groups the rest', () => {
    const p = (id: string, seconds: number) => ({ project_id: id, project_name: id.toUpperCase(), seconds });
    const chart = stackDaily([
      { date: '2026-10-26', projects: [p('a', 100), p('b', 50), p('c', 20), p('d', 10)] },
      { date: '2026-10-27', projects: [p('a', 10)] },
    ]);
    expect(chart.series.map((s) => [s.name, s.fill])).toEqual([
      ['A', 'data-1'],
      ['B', 'data-2'],
      ['Other projects', 'other'],
    ]);
    expect(chart.days[0]!.total).toBe(180);
    expect(chart.max).toBe(180);
    expect(chart.days[0]!.segments.find((s) => s.seriesId === '__other__')?.seconds).toBe(30);
  });
});
