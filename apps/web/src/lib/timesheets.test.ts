import { describe, expect, it } from 'vitest';
import type { Me, TimesheetTotals } from '@rd/contracts';
import { accessFor, navFor } from './nav';
import {
  countedTotals,
  formatLimitMinutes,
  limitInputValue,
  limitsSummary,
  overtimeText,
  parseLimitInput,
  reviewActions,
  statusTone,
  timesheetGrid,
} from './timesheets';

const day = (date: string, projects: { project_id: string | null; project_name: string; seconds: number }[]) => ({
  date,
  total_seconds: projects.reduce((n, p) => n + p.seconds, 0),
  tracked_seconds: 0,
  manual_seconds: 0,
  corrected_seconds: 0,
  overtime_seconds: 0,
  projects,
});

const totals = (over: Partial<TimesheetTotals> = {}): TimesheetTotals => ({
  total_seconds: 0,
  tracked_seconds: 0,
  manual_seconds: 0,
  corrected_seconds: 0,
  daily_overtime_seconds: 0,
  weekly_overtime_seconds: 0,
  overtime_seconds: 0,
  limits: { daily_minutes: null, weekly_minutes: null },
  days: [],
  projects: [],
  ...over,
});

describe('limit formatting and parsing', () => {
  it('formats minutes as hours', () => {
    expect(formatLimitMinutes(480)).toBe('8h');
    expect(formatLimitMinutes(450)).toBe('7h 30m');
    expect(formatLimitMinutes(45)).toBe('45m');
    expect(formatLimitMinutes(null)).toBe('No limit');
    expect(limitsSummary({ daily_minutes: 480, weekly_minutes: 2400 })).toBe('8h a day · 40h a week');
    expect(limitsSummary({ daily_minutes: null, weekly_minutes: null })).toBe('No daily or weekly limit');
  });
  it('parses the forms admins type, and round-trips', () => {
    expect(parseLimitInput('8')).toBe(480);
    expect(parseLimitInput('7.5')).toBe(450);
    expect(parseLimitInput('7:30')).toBe(450);
    expect(parseLimitInput('7h 30m')).toBe(450);
    expect(parseLimitInput('40h')).toBe(2400);
    expect(parseLimitInput('90m')).toBe(90);
    expect(parseLimitInput('  ')).toBeNull();
    expect(parseLimitInput('0')).toBe('invalid');
    expect(parseLimitInput('lots')).toBe('invalid');
    expect(parseLimitInput(limitInputValue(450))).toBe(450);
    expect(limitInputValue(null)).toBe('');
  });
  it('writes overtime neutrally', () => {
    expect(overtimeText(5400)).toMatch(/^\+1h 30m$/);
    expect(overtimeText(0)).toBe('—');
    expect(statusTone('approved')).toBe('solid');
    expect(statusTone('rejected')).toBe('outline');
  });
});

describe('timesheetGrid', () => {
  it('builds a project × day matrix in the order the API gives', () => {
    const a = { project_id: 'a', project_name: 'Alpha', seconds: 3600 };
    const t = totals({
      days: [day('2026-10-26', [a]), day('2026-10-27', [{ ...a, seconds: 1800 }, { project_id: null, project_name: 'No project', seconds: 600 }])],
      projects: [
        { project_id: 'a', project_name: 'Alpha', seconds: 5400 },
        { project_id: null, project_name: 'No project', seconds: 600 },
      ],
    });
    expect(timesheetGrid(t)).toEqual([
      { key: 'a', name: 'Alpha', days: [3600, 1800], total: 5400 },
      { key: 'none', name: 'No project', days: [0, 600], total: 600 },
    ]);
  });
});

describe('review state', () => {
  const sheet = { id: 't1', can_review: true };
  it('offers approve/send back for submitted weeks and reopen for approved ones', () => {
    expect(reviewActions({ ...sheet, status: 'submitted' })).toEqual(['approve', 'reject']);
    expect(reviewActions({ ...sheet, status: 'approved' })).toEqual(['reopen']);
    expect(reviewActions({ ...sheet, status: 'rejected' })).toEqual([]);
    expect(reviewActions({ ...sheet, status: 'submitted', can_review: false })).toEqual([]);
    expect(reviewActions({ id: null, can_review: true, status: 'draft' })).toEqual([]);
  });
  it('uses the frozen totals once approved', () => {
    const live = totals({ total_seconds: 10 });
    const frozen = totals({ total_seconds: 7 });
    const base = { totals: live, approved_totals: frozen } as Parameters<typeof countedTotals>[0];
    expect(countedTotals({ ...base, status: 'approved' }).total_seconds).toBe(7);
    expect(countedTotals({ ...base, status: 'reopened' }).total_seconds).toBe(10);
  });
});

describe('timesheet navigation', () => {
  const me = (role: Me['user']['org_role'], entitlements: Me['entitlements'], teams: string[] = []): Me => ({
    user: { id: 'u', email: 'e', display_name: 'D', org_role: role, timezone: 'UTC', tracking_enabled: true, mfa_enabled: false },
    organization: { id: 'o', name: 'Org', plan: 'standard', license: 'active', logo_url: null },
    mfa_verified: true,
    managed_team_ids: teams,
    managed_project_ids: [],
    entitlements,
  });
  const hrefs = (m: Me) => navFor(accessFor(m)).flatMap((g) => g.items.map((i) => i.href));

  it('gives admins work limits and approvals only on plans with timesheets', () => {
    expect(hrefs(me('org_admin', ['timesheets']))).toEqual(expect.arrayContaining(['/admin/work-limits', '/approvals']));
    expect(hrefs(me('org_admin', []))).not.toContain('/admin/work-limits');
    expect(hrefs(me('org_admin', []))).not.toContain('/approvals');
    expect(hrefs(me('employee', ['timesheets']))).not.toContain('/admin/work-limits');
  });
});
