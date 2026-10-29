import type { ApiEndpointDoc, ApiTokenScope } from '@rd/contracts';

/**
 * The public API (Stage 4 F5): the only routes an API token can call, and what the
 * reference at /v1/docs lists. Everything else — signing in, passwords and MFA, tokens
 * themselves, single sign-on, support access, closing the organization, screenshot images —
 * answers 403 to a token. A token acts as its creator, so each route's own access rules
 * still apply on top.
 *
 * `personal`: personal tokens may call it (only routes about the caller themselves).
 * `payroll`: needs the payroll scope as well (pay rates and payroll files).
 */
type Entry = [method: ApiEndpointDoc['method'], path: string, summary: string, opts?: { personal?: boolean; payroll?: boolean }];

const SECTIONS: [section: string, entries: Entry[]][] = [
  [
    'You',
    [
      ['GET', '/v1/me', 'Your profile, organization and plan', { personal: true }],
      ['GET', '/v1/me/sessions', 'Your work sessions (`from`, `to`)', { personal: true }],
      ['GET', '/v1/me/activity', 'Your activity by minute (`from`, `to`)', { personal: true }],
      ['GET', '/v1/me/apps', 'Your app usage (`from`, `to`)', { personal: true }],
      ['GET', '/v1/me/insights', 'Your insights (`from`, `to`, `tz`)', { personal: true }],
      ['GET', '/v1/me/projects', 'Projects you can track to', { personal: true }],
      ['GET', '/v1/me/corrections', 'Your time corrections', { personal: true }],
      ['GET', '/v1/me/timesheets', 'Your timesheets', { personal: true }],
      ['GET', '/v1/me/timesheets/:period_start', 'One of your timesheets', { personal: true }],
      ['GET', '/v1/me/time-off', 'Your time off: balances and requests', { personal: true }],
      ['GET', '/v1/me/schedule', 'Your schedule', { personal: true }],
      ['GET', '/v1/me/attendance', 'Your attendance', { personal: true }],
      ['GET', '/v1/me/work-limits', 'Your work limits', { personal: true }],
      ['GET', '/v1/me/pay-rate', 'Your own pay rate', { personal: true }],
    ],
  ],
  [
    'People and structure',
    [
      ['GET', '/v1/admin/users', 'Everyone in the organization'],
      ['POST', '/v1/admin/users', 'Add a person (they are invited)'],
      ['PATCH', '/v1/admin/users/:id', "Change a person's name, role, time zone or tracking"],
      ['POST', '/v1/admin/users/:id/deactivate', 'Deactivate a person'],
      ['POST', '/v1/admin/users/:id/reactivate', 'Reactivate a person'],
      ['GET', '/v1/admin/teams', 'Teams'],
      ['POST', '/v1/admin/teams', 'Create a team'],
      ['POST', '/v1/admin/teams/:id/members', 'Add someone to a team (`user_id`, `role`)'],
      ['DELETE', '/v1/admin/teams/:id/members/:userId', 'Remove someone from a team'],
      ['GET', '/v1/admin/projects', 'Projects, with members and tasks'],
      ['POST', '/v1/admin/projects', 'Create a project'],
      ['PATCH', '/v1/admin/projects/:id', 'Rename or archive a project'],
      ['POST', '/v1/admin/projects/:id/tasks', 'Add a task'],
      ['POST', '/v1/admin/projects/:id/members', 'Add someone to a project'],
      ['DELETE', '/v1/admin/projects/:id/members/:userId', 'Remove someone from a project'],
      ['GET', '/v1/teams', 'Teams you manage (all, for admins)'],
      ['GET', '/v1/projects', 'Projects you manage (all, for admins)'],
    ],
  ],
  [
    'Time',
    [
      ['GET', '/v1/users/:id/sessions', "A person's work sessions (`from`, `to`)"],
      ['GET', '/v1/users/:id/activity', "A person's activity by minute, where policy allows"],
      ['GET', '/v1/users/:id/apps', "A person's app usage, where policy allows"],
      ['GET', '/v1/users/:id/timesheets/:period_start', "A person's timesheet"],
      ['GET', '/v1/teams/:id/report', 'Team hours (`from`, `to`, `tz`)'],
      ['GET', '/v1/projects/:id/report', 'Project hours (`from`, `to`)'],
      ['GET', '/v1/teams/:id/attendance', 'Team attendance'],
      ['GET', '/v1/teams/:id/calendar', 'Team time-off calendar'],
      ['GET', '/v1/teams/:id/overtime', 'Team overtime'],
      ['GET', '/v1/timesheets/pending', 'Timesheets waiting for you'],
      ['GET', '/v1/corrections/pending', 'Time corrections waiting for you'],
      ['GET', '/v1/time-off/pending', 'Time-off requests waiting for you'],
      ['GET', '/v1/admin/holidays', 'Holidays'],
      ['POST', '/v1/admin/holidays', 'Add a holiday'],
      ['GET', '/v1/admin/time-off/policies', 'Time-off policies'],
    ],
  ],
  [
    'Exports',
    [
      ['GET', '/v1/exports', 'Your exports'],
      ['POST', '/v1/exports', 'Start a sessions or daily-activity CSV export'],
      ['GET', '/v1/exports/:id', 'An export, with its download link when ready'],
    ],
  ],
  [
    'Money',
    [
      ['GET', '/v1/admin/clients', 'Clients'],
      ['POST', '/v1/admin/clients', 'Add a client'],
      ['GET', '/v1/admin/budgets', 'Project budgets'],
      ['GET', '/v1/admin/invoices', 'Invoices'],
      ['GET', '/v1/admin/invoices/:id', 'An invoice with its lines'],
      ['GET', '/v1/admin/rates/bill', 'Client bill rates'],
      ['GET', '/v1/admin/rates/pay', 'Pay rates', { payroll: true }],
      ['POST', '/v1/admin/rates/pay', 'Set a pay rate', { payroll: true }],
      ['GET', '/v1/admin/payroll-exports', 'Payroll files', { payroll: true }],
      ['POST', '/v1/admin/payroll-exports', 'Make a payroll file for a period', { payroll: true }],
      ['GET', '/v1/admin/payroll-exports/:id', 'A payroll file, with its download link when ready', { payroll: true }],
    ],
  ],
  ['Audit', [['GET', '/v1/audit-events', 'The audit log (`from`, `to`, `action`, `actor_id`, `subject_id`, `cursor`)']]],
];

export const API_SURFACE: ApiEndpointDoc[] = SECTIONS.flatMap(([section, entries]) =>
  entries.map(([method, path, summary, opts]) => {
    const scopes: ApiTokenScope[] = [method === 'GET' ? 'read' : 'write'];
    if (opts?.payroll) scopes.push('payroll');
    return { method, path, section, summary, scopes, personal: Boolean(opts?.personal) };
  }),
);

const BY_ROUTE = new Map(API_SURFACE.map((e) => [`${e.method} ${e.path}`, e]));

/** The API entry for a matched route (Fastify's route pattern, e.g. `/v1/users/:id/sessions`). */
export function apiEndpoint(method: string, routeUrl: string | undefined): ApiEndpointDoc | undefined {
  return routeUrl ? BY_ROUTE.get(`${method.toUpperCase()} ${routeUrl}`) : undefined;
}
