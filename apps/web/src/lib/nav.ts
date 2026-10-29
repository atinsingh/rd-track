import type { Entitlement, Me, OrgRole } from '@rd/contracts';

export type Capability =
  | 'me'
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
  | 'money';

export interface Access {
  role: OrgRole;
  isAdmin: boolean;
  isAuditor: boolean;
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
    case 'screenshots':
      return a.entitlements.includes('screenshots');
    case 'team':
      return a.managesTeams;
    case 'approvals':
      // Org admins review corrections, timesheets and time off for people without a team manager.
      return a.managesTeams || (a.isAdmin && (a.entitlements.includes('correction_approvals') || a.entitlements.includes('timesheets') || timeOff));
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
      // Clients, rates, budgets and invoices (Pro): org admins only.
      return a.isAdmin && a.entitlements.includes('budgets_invoicing');
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
      { href: '/me', label: 'My day', capability: 'me', keywords: 'today timeline home' },
      { href: '/me/time', label: 'My time', capability: 'me', keywords: 'timesheet week corrections manual' },
      { href: '/me/insights', label: 'Insights', capability: 'me', keywords: 'focus apps trends' },
      { href: '/me/schedule', label: 'Schedule and time off', capability: 'schedule', keywords: 'leave vacation holiday shifts' },
      { href: '/me/screenshots', label: 'Screenshots', capability: 'screenshots' },
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
      { href: '/admin/clients', label: 'Clients', capability: 'money' },
      { href: '/admin/invoices', label: 'Invoices', capability: 'money', keywords: 'billing clients' },
      { href: '/admin/rates', label: 'Rates and budgets', capability: 'money', keywords: 'pay bill rate cost' },
    ],
  },
  {
    key: 'admin',
    label: 'Admin',
    items: [
      { href: '/admin/users', label: 'People', capability: 'admin', keywords: 'users invite deactivate' },
      { href: '/admin/teams', label: 'Teams and projects', capability: 'admin', keywords: 'members managers tasks' },
      { href: '/admin/devices', label: 'Devices', capability: 'admin', keywords: 'agent enrol computers' },
      { href: '/admin/policies', label: 'Policies', capability: 'admin', keywords: 'idle screenshots tracking settings' },
      { href: '/admin/apps', label: 'Work apps', capability: 'admin', keywords: 'categories' },
      { href: '/admin/schedules', label: 'Schedules', capability: 'adminSchedules', keywords: 'shifts hours' },
      { href: '/admin/holidays', label: 'Holidays', capability: 'adminHolidays' },
      { href: '/admin/time-off', label: 'Time-off policies', capability: 'adminTimeOff', keywords: 'leave accrual' },
      { href: '/admin/work-limits', label: 'Work limits', capability: 'work_limits', keywords: 'overtime daily weekly' },
      { href: '/admin/requests', label: 'Deletion requests', capability: 'admin', keywords: 'privacy' },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    items: [
      { href: '/admin/billing', label: 'Plan and billing', capability: 'admin', keywords: 'seats subscription upgrade' },
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
    default:
      parts.push('Employee');
  }
  if (me.managed_team_ids.length) parts.push('Team manager');
  else if (me.managed_project_ids.length) parts.push('Project manager');
  if ((me.user.org_role === 'org_admin' || me.user.org_role === 'super_admin') && me.mfa_verified)
    parts.push('MFA verified');
  return parts.join(' · ');
}
