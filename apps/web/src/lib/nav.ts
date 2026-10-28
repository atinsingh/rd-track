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
  | 'exports';

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
  switch (c) {
    case 'me':
    case 'exports':
      return true;
    case 'screenshots':
      return a.entitlements.includes('screenshots');
    case 'team':
      return a.managesTeams;
    case 'approvals':
      // Org admins approve timesheets for people without a team manager.
      return a.managesTeams || (a.isAdmin && a.entitlements.includes('timesheets'));
    case 'projects':
      return a.managesProjects;
    case 'admin':
      return a.isAdmin;
    case 'work_limits':
      return a.isAdmin && a.entitlements.includes('timesheets');
    case 'audit':
      return a.isAdmin || a.isAuditor;
  }
}

export interface NavItem {
  href: string;
  label: string;
  capability: Capability;
  badge?: 'approvals';
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: 'Me',
    items: [
      { href: '/me', label: 'My day', capability: 'me' },
      { href: '/me/time', label: 'My time', capability: 'me' },
      { href: '/me/screenshots', label: 'Screenshots', capability: 'screenshots' },
      { href: '/me/privacy', label: "What's collected", capability: 'me' },
      { href: '/exports', label: 'Exports', capability: 'exports' },
    ],
  },
  {
    label: 'Team',
    items: [
      { href: '/team', label: 'Team', capability: 'team' },
      { href: '/approvals', label: 'Approvals', capability: 'approvals', badge: 'approvals' },
      { href: '/projects', label: 'Projects', capability: 'projects' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { href: '/admin/users', label: 'People', capability: 'admin' },
      { href: '/admin/teams', label: 'Teams and projects', capability: 'admin' },
      { href: '/admin/devices', label: 'Devices', capability: 'admin' },
      { href: '/admin/policies', label: 'Policies', capability: 'admin' },
      { href: '/admin/work-limits', label: 'Work limits', capability: 'work_limits' },
      { href: '/admin/requests', label: 'Deletion requests', capability: 'admin' },
      { href: '/admin/billing', label: 'Billing', capability: 'admin' },
      { href: '/audit', label: 'Audit log', capability: 'audit' },
    ],
  },
];

/** Navigation filtered to what the signed-in user's roles allow. */
export function navFor(a: Access): NavGroup[] {
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => can(a, i.capability)) })).filter(
    (g) => g.items.length > 0,
  );
  // Auditors without admin rights see the audit log under its own heading.
  return groups.map((g) => (g.label === 'Admin' && !a.isAdmin ? { ...g, label: 'Audit' } : g));
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
