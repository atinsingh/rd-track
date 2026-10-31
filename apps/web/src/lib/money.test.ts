import { describe, expect, it } from 'vitest';
import type { Me } from '@rd/contracts';
import { latestBy, parseHoursInput, parseMoneyInput, parsePercentBp, parseThresholds, formatPercentBp } from './money';
import { accessFor, navFor } from './nav';

describe('money inputs', () => {
  it('parses amounts to cents without floating-point drift', () => {
    expect(parseMoneyInput('45')).toBe(4500);
    expect(parseMoneyInput('45.5')).toBe(4550);
    expect(parseMoneyInput('1,200.07')).toBe(120_007);
    expect(parseMoneyInput('0.29')).toBe(29);
    expect(parseMoneyInput('-1')).toBeNull();
    expect(parseMoneyInput('1.005')).toBeNull();
    expect(parseMoneyInput('abc')).toBeNull();
  });
  it('parses hours, thresholds and tax rates', () => {
    expect(parseHoursInput('1.25')).toBe(1.25);
    expect(parseHoursInput('1.255')).toBeNull();
    expect(parseThresholds('100, 80')).toEqual([80, 100]);
    expect(parseThresholds('80%, 80')).toEqual([80]);
    expect(parseThresholds('')).toEqual([]);
    expect(parseThresholds('0')).toBeNull();
    expect(parsePercentBp('8.25')).toBe(825);
    expect(parsePercentBp('')).toBe(0);
    expect(parsePercentBp('101')).toBeNull();
    expect(formatPercentBp(825)).toBe('8.25%');
    expect(formatPercentBp(1300)).toBe('13%');
  });
  it('picks the rate in effect today per key', () => {
    const rows = [
      { k: 'a', effective_from: '2026-01-01' },
      { k: 'a', effective_from: '2026-10-01' },
      { k: 'a', effective_from: '2027-01-01' },
      { k: 'b', effective_from: '2027-02-01' },
    ];
    const cur = latestBy(rows, (r) => r.k, '2026-10-28');
    expect(cur.get('a')?.effective_from).toBe('2026-10-01');
    expect(cur.has('b')).toBe(false);
  });
});

describe('money navigation', () => {
  const me = (role: Me['user']['org_role'], entitlements: Me['entitlements']): Me => ({
    user: { id: 'u', email: 'e', display_name: 'D', org_role: role, timezone: 'UTC', tracking_enabled: true, mfa_enabled: true, locale: null },
    organization: { id: 'o', name: 'Org', plan: 'pro', license: 'active', locale: null, logo_url: null },
    mfa_verified: true,
    managed_team_ids: [],
    managed_project_ids: [],
    entitlements,
  });
  const hrefs = (m: Me) => navFor(accessFor(m)).flatMap((g) => g.items.map((i) => i.href));
  it('shows clients, rates and invoices to org admins on Pro only', () => {
    expect(hrefs(me('org_admin', ['budgets_invoicing']))).toEqual(expect.arrayContaining(['/admin/clients', '/admin/rates', '/admin/invoices']));
    expect(hrefs(me('org_admin', []))).not.toContain('/admin/invoices');
    expect(hrefs(me('employee', ['budgets_invoicing']))).not.toContain('/admin/rates');
    expect(hrefs(me('auditor', ['budgets_invoicing']))).not.toContain('/admin/clients');
  });
});
