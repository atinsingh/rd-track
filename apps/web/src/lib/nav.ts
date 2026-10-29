import type { Entitlement, Me, OrgRole } from '@rd/contracts';

export type Capability =
  | 'me'
  | 'tracking'
  | 'screenshots'
  | 'team'
  | 'approvals'
  | 'projects'
  | 'admin'
  | 'work_limits'
  | 'audit'
  | 'exports'
  | 'webhooks'
  | 'schedule'
  | 'teamSchedule'
  | 'adminSchedules'
  | 'adminHolidays'
  | 'adminTimeOff'
  | 'money'
  | 'finance';

export interface Access {
  role: OrgRole;
  isAdmin: boolean;
  isAuditor: boolean;
  /** The finance role: Money without full admin (slice 4, G21). */
  isFinance: boolean;
  /** Tracking is on for the signed-in person, so My day has something to show. */
  tracks: boolean;
  managesTeams: boolean;
  managesProjects: boolean;
  entitlements: readonly Entitlement[];
}

export function accessFor(me: Me): Access {
  const role = me.user.org_role;
  return {
    role,
    isAdmin: role === 'org_admin' || role === 'super_admin',
    isAuditor: role === 'auditor',
    isFinance: role === 'finance',
    tracks: me.user.tracking_enabled,
    managesTeams: me.managed_team_ids.length > 0,
    managesProjects: me.managed_project_ids.length > 0,
    entitlements: me.entitlements,
  };
}

export function can(a: Access, c: Capability): boolean {
  const schedules = a.entitlements.includes('schedules');
  const timeOff = a.entitlements.includes('time_off');
  switch (c) {
    case 'me':
    case 'exports':
      return true;
    case 'tracking':
      // Your own time pages. People whose tracking was turned off keep their history; admins,
      // auditors and finance who never track don't get pages that can only be empty.
      return a.tracks || !(a.isAdmin || a.isAuditor || a.isFinance);
    case 'screenshots':
      return can(a, 'tracking') && a.entitlements.includes('screenshots');
    case 'team':
      return a.managesTeams;
    case 'approvals':
      // Org admins review deletion requests, and corrections, timesheets and time off for people without a team manager.
      return a.managesTeams || (a.isAdmin && (timeOff || (['correction_approvals', 'timesheets', 'screenshots'] as const).some((e) => a.entitlements.includes(e))));
    case 'projects':
      return a.managesProjects;
    case 'admin':
      return a.isAdmin;
    case 'webhooks':
      return a.isAdmin && a.entitlements.includes('webhooks');
    case 'work_limits':
      return a.isAdmin && a.entitlements.includes('timesheets');
    case 'audit':
      return a.isAdmin || a.isAuditor;
    case 'schedule':
      return schedules || timeOff;
    case 'teamSchedule':
      return a.managesTeams && (schedules || timeOff);
    case 'adminSchedules':
      return a.isAdmin && schedules;
    case 'adminHolidays':
      return a.isAdmin && (schedules || timeOff);
    case 'adminTimeOff':
      return a.isAdmin && timeOff;
    case 'money':
      // Clients, rates, budgets, invoices and payroll (Pro): org admins and finance.
      return (a.isAdmin || a.isFinance) && a.entitlements.includes('budgets_invoicing');
    case 'finance':
      // Finance people land on Money even before the plan includes it, to see what's needed.
      return a.isFinance || can(a, 'money');
  }
}

export interface NavItem {
  href: string;
  label: string;
  capability: Capability;
  badge?: 'approvals';
  /** Extra words the ⌘K palette matches on. */
  keywords?: string;
}
export type NavGroupKey = 'me' | 'team' | 'money' | 'admin' | 'settings';
export interface NavGroup {
  key: NavGroupKey;
  label: string;
  items: NavItem[];
}

/** Five groups (Stage 4 IA): your own pages, the people you manage, money, organisation admin, settings. */
const GROUPS: NavGroup[] = [
  {
    key: 'me',
    label: 'Me',
    items: [
      { href: '/me', label: 'My day', capability: 'tracking', keywords: 'today timeline home' },
      { href: '/me/time', label: 'My time', capability: 'tracking', keywords: 'timesheet week corrections manual' },
      { href: '/me/insights', label: 'Insights', capability: 'tracking', keywords: 'focus apps trends' },
      { href: '/me/schedule', label: 'Schedule and time off', capability: 'schedule', keywords: 'leave vacation holiday shifts' },
      { href: '/me/screenshots', label: 'Screenshots', capability: 'screenshots' },
      { href: '/me/computers', label: 'My computers', capability: 'tracking', keywords: 'download install app agent enrol connect code' },
      { href: '/me/privacy', label: "What's collected", capability: 'me', keywords: 'privacy data deletion' },
      { href: '/me/settings', label: 'Settings', capability: 'me', keywords: 'notifications email preferences account' },
      { href: '/exports', label: 'Exports', capability: 'exports', keywords: 'csv download payroll' },
    ],
  },
  {
    key: 'team',
    label: 'Team',
    items: [
      { href: '/team', label: 'Team', capability: 'team', keywords: 'people reports' },
      { href: '/approvals', label: 'Approvals', capability: 'approvals', badge: 'approvals', keywords: 'inbox review corrections timesheets time off' },
      { href: '/team/attendance', label: 'Attendance and calendar', capability: 'teamSchedule', keywords: 'leave late absent' },
      { href: '/projects', label: 'Projects', capability: 'projects', keywords: 'budget report' },
    ],
  },
  {
    key: 'money',
    label: 'Money',
    items: [
      { href: '/money', label: 'Period close', capability: 'finance', keywords: 'home payroll unpaid invoices unbilled' },
      { href: '/admin/clients', label: 'Clients', capability: 'money' },
      { href: '/admin/invoices', label: 'Invoices', capability: 'money', keywords: 'billing clients' },
      { href: '/admin/rates', label: 'Rates and budgets', capability: 'money', keywords: 'pay bill rate cost' },
    ],
  },
  {
    key: 'admin',
    label: 'Admin',
    items: [
      { href: '/admin', label: 'Setup and health', capability: 'admin', keywords: 'home checklist overview seats summary' },
      { href: '/admin/users', label: 'People', capability: 'admin', keywords: 'users invite deactivate' },
      { href: '/admin/teams', label: 'Teams and projects', capability: 'admin', keywords: 'members managers tasks' },
      { href: '/admin/devices', label: 'Devices', capability: 'admin', keywords: 'agent enrol computers' },
      { href: '/admin/policies', label: 'Policies', capability: 'admin', keywords: 'idle screenshots tracking settings' },
      { href: '/admin/apps', label: 'Work apps', capability: 'admin', keywords: 'categories' },
      { href: '/admin/schedules', label: 'Schedules', capability: 'adminSchedules', keywords: 'shifts hours' },
      { href: '/admin/holidays', label: 'Holidays', capability: 'adminHolidays' },
      { href: '/admin/time-off', label: 'Time-off policies', capability: 'adminTimeOff', keywords: 'leave accrual' },
      { href: '/admin/work-limits', label: 'Work limits', capability: 'work_limits', keywords: 'overtime daily weekly timesheet deadline reminder due' },
      { href: '/admin/requests', label: 'Deletion requests', capability: 'admin', keywords: 'privacy' },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    items: [
      { href: '/admin/billing', label: 'Plan and billing', capability: 'admin', keywords: 'seats subscription upgrade' },
      { href: '/admin/data', label: 'Organization data', capability: 'admin', keywords: 'export download close delete account offboarding' },
      { href: '/admin/support', label: 'Support access', capability: 'admin', keywords: 'rounddigital help grant operator' },
      { href: '/admin/webhooks', label: 'Webhooks', capability: 'webhooks', keywords: 'developers integrations api' },
      { href: '/audit', label: 'Audit log', capability: 'audit', keywords: 'history security' },
    ],
  },
];

/** Navigation filtered to what the signed-in user's roles allow. */
export function navFor(a: Access): NavGroup[] {
  return GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => can(a, i.capability)) })).filter((g) => g.items.length > 0);
}

/** The group holding the current page, which always stays open. */
export function groupOf(groups: NavGroup[], href: string | null): NavGroupKey | null {
  return groups.find((g) => g.items.some((i) => i.href === href))?.key ?? null;
}

/** Longest nav href that prefixes the path, so /team/123 highlights "Team". */
export function activeHref(groups: NavGroup[], pathname: string): string | null {
  let best: string | null = null;
  for (const g of groups)
    for (const i of g.items) {
      const match = pathname === i.href || pathname.startsWith(`${i.href}/`);
      if (match && (!best || i.href.length > best.length)) best = i.href;
    }
  return best;
}

export function roleLabel(me: Me): string {
  const parts: string[] = [];
  switch (me.user.org_role) {
    case 'org_admin':
      parts.push('Org admin');
      break;
    case 'super_admin':
      parts.push('Super admin');
      break;
    case 'auditor':
      parts.push('Auditor');
      break;
    case 'finance':
      parts.push('Finance');
      break;
    default:
      parts.push('Employee');
  }
  if (me.managed_team_ids.length) parts.push('Team manager');
  else if (me.managed_project_ids.length) parts.push('Project manager');
  if ((me.user.org_role === 'org_admin' || me.user.org_role === 'super_admin' || me.user.org_role === 'finance') && me.mfa_verified)
    parts.push('MFA verified');
  return parts.join(' · ');
}

// ───────────── role homes (slice 4) ─────────────

export interface Home {
  href: string;
  label: string;
}

/**
 * The homes this person can switch between, most specific first: the first one is where
 * "/" lands unless they picked another. My day is offered to anyone who tracks, and is
 * the fallback for everyone else.
 */
export function homesFor(a: Access): Home[] {
  const homes: Home[] = [];
  if (a.isAdmin) homes.push({ href: '/admin', label: 'Setup and health' });
  if (can(a, 'finance')) homes.push({ href: '/money', label: 'Period close' });
  if (a.isAuditor) homes.push({ href: '/audit', label: 'Audit log' });
  if (a.managesTeams) homes.push({ href: '/team', label: 'Team today' });
  if (a.tracks || homes.length === 0) homes.push({ href: '/me', label: 'My day' });
  return homes;
}

/** Where "/" goes: the saved choice if it's still one of theirs, else their first home. */
export function homeFor(a: Access, saved: string | null): string {
  const homes = homesFor(a);
  return homes.find((h) => h.href === saved)?.href ?? homes[0]!.href;
}

export const HOME_KEY = 'rd.home';
