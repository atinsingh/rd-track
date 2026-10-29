import type {
  AccountSecurity,
  InviteInfo,
  AdminProjectDTO,
  UserImportResponse,
  AdminOverview,
  AuditPerson,
  MoneyOverview,
  InboxCounts,
  TimesheetRule,
  TodosResponse,
  RecoveryCodesResponse,
  BillingInterval,
  DirectoryResponse,
  ApprovalType,
  ApprovalsBatchResponse,
  AppCategory,
  AppCategoryDTO,
  PersonalInsights,
  TeamInsights,
  WebhookDeliveryDTO,
  WebhookEndpointDTO,
  WebhookEventType,
  MemberVisibility,
  ChangePlanResponse,
  ActivityResponse,
  ApiErrorBody,
  AppUsageResponse,
  AuditEventDTO,
  CorrectionDTO,
  DeletionRequestDTO,
  DeviceDTO,
  EnrollmentCodeResponse,
  ExportDTO,
  LoginResponse,
  Me,
  MfaEnrollResponse,
  MyPolicyResponse,
  NotificationCategory,
  NotificationPreferencesResponse,
  NotificationsResponse,
  Page,
  PartialPolicySettings,
  PolicyListResponse,
  PolicyScopeDetail,
  ProjectDTO,
  ProjectReport,
  ScopeType,
  ScreenshotDTO,
  SessionDTO,
  SubscriptionDTO,
  TeamReport,
  TeamSummary,
  UserDTO,
  ViewUrlResponse,
  CorrectionValues,
  OrgRole,
  PlanId,
  BillRateDTO,
  ClientDTO,
  InvoiceDTO,
  InvoiceGrouping,
  InvoiceLineInput,
  InvoiceSummaryDTO,
  MyPayRateResponse,
  PayRateDTO,
  PayrollExportDTO,
  ProjectBudgetDTO,
  ProjectBudgetResponse,
  BudgetKind,
  BudgetResets,
} from '@rd/contracts';

/**
 * Typed client for the `/v1` web API (system design §5.4).
 *
 * Requests go to the same origin; Next rewrites `/v1/*` to the API so the HttpOnly
 * session cookie stays first-party. Every state-changing request carries
 * `x-rd-csrf: 1`.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, requestId: string | null, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof DOMException && e.name === 'AbortError') return new ApiError(0, 'aborted', 'Request cancelled', null);
  const message = e instanceof Error ? e.message : 'Something went wrong';
  return new ApiError(0, 'network_error', message, null);
}

type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Redirect to /login or /login/mfa on 401/403 auth errors (default true). */
  redirectOnAuth?: boolean;
}

export function buildPath(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function currentLocation(): string {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname + window.location.search;
}

function redirectForAuth(code: string): void {
  if (typeof window === 'undefined') return;
  const here = currentLocation();
  if (here.startsWith('/login')) return;
  const next = encodeURIComponent(here);
  // A full navigation (not router.push) drops every bit of client state from the old session.
  /* eslint-disable @next/next/no-location-assign-relative-destination */
  if (code === 'unauthenticated') window.location.assign(`/login?next=${next}`);
  else if (code === 'mfa_required') window.location.assign(`/login/mfa?next=${next}`);
  /* eslint-enable @next/next/no-location-assign-relative-destination */
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') headers['x-rd-csrf'] = '1';
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(buildPath(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'include',
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch (e) {
    throw toApiError(e);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!res.ok) {
    const err = parseErrorBody(res.status, json, res.headers.get('x-request-id'));
    if (opts.redirectOnAuth !== false && (err.code === 'unauthenticated' || err.code === 'mfa_required')) {
      redirectForAuth(err.code);
    }
    throw err;
  }
  return json as T;
}

export function parseErrorBody(status: number, json: unknown, headerRequestId: string | null = null): ApiError {
  const body = json as Partial<ApiErrorBody> | undefined;
  const e = body && typeof body === 'object' ? body.error : undefined;
  if (e && typeof e.code === 'string') {
    return new ApiError(status, e.code, e.message || e.code, e.request_id ?? headerRequestId, e.details);
  }
  const fallback: Record<number, string> = {
    400: 'validation_failed',
    401: 'unauthenticated',
    402: 'plan_upgrade_required',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
  };
  return new ApiError(
    status,
    fallback[status] ?? `http_${status}`,
    status >= 500 ? 'The server had a problem. Try again in a moment.' : `Request failed (${status})`,
    headerRequestId,
  );
}

/** Lists are documented as `{ items: [...] }`; accept a bare array too. */
export function unwrapList<T>(v: T[] | { items: T[] } | null | undefined): T[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Array.isArray(v.items) ? v.items : [];
}

const get = <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts);
const list = async <T>(path: string, opts?: RequestOptions) =>
  unwrapList(await request<T[] | { items: T[] }>('GET', path, opts));
const post = <T>(path: string, body?: unknown, opts?: RequestOptions) =>
  request<T>('POST', path, { ...opts, body: body ?? {} });
const put = <T>(path: string, body: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body });
const patch = <T>(path: string, body: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body });
const del = <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts);
/** For endpoints whose body we don't use (may be 204): resolves to `true` on success. */
const ok = (p: Promise<unknown>): Promise<true> => p.then(() => true as const);

export interface Range {
  from: string;
  to: string;
}

const enc = encodeURIComponent;

/** Base path for one person's data: `/v1/me` or `/v1/users/{id}`. */
export type PersonBase = '/v1/me' | `/v1/users/${string}`;
export const personBase = (userId: string | null): PersonBase => (userId ? `/v1/users/${enc(userId)}` : '/v1/me');

export interface CreateUserBody {
  email: string;
  display_name: string;
  org_role: OrgRole;
  tracking_enabled: boolean;
  timezone: string;
  password?: string;
}
export interface UpdateUserBody {
  display_name?: string;
  org_role?: OrgRole;
  tracking_enabled?: boolean;
  timezone?: string;
}
export interface TimeCorrectionBody {
  session_id?: string;
  requested: CorrectionValues;
  reason: string;
}
export interface AuditQuery {
  from?: string;
  to?: string;
  action?: string;
  actor_id?: string;
  /** Whose data the event was about. */
  subject_id?: string;
  cursor?: string;
}

export interface ClientBody {
  name: string;
  contact_email?: string | null;
  currency?: string;
  address?: string | null;
  archived?: boolean;
}
export interface BudgetBody {
  kind: BudgetKind;
  limit_hours?: number;
  limit_cents?: number;
  currency?: string;
  alert_thresholds: number[];
  stop_at_budget: boolean;
  resets: BudgetResets;
}
export interface InvoiceDraftBody {
  client_id: string;
  period_from: string;
  period_to: string;
  timezone?: string;
  group_by: InvoiceGrouping;
  tax_rate_bp: number;
  due_date?: string | null;
  notes?: string | null;
}

/** Stage 3 money (Pro): clients, rates, budgets, invoices, payroll. */
const money = {
  clients: (signal?: AbortSignal) => list<ClientDTO>('/v1/admin/clients', { signal }),
  createClient: (body: ClientBody) => post<ClientDTO>('/v1/admin/clients', body),
  updateClient: (id: string, body: Partial<ClientBody>) => patch<ClientDTO>(`/v1/admin/clients/${enc(id)}`, body),
  setProjectClient: (projectId: string, clientId: string | null) =>
    ok(put(`/v1/admin/projects/${enc(projectId)}/client`, { client_id: clientId })),
  payRates: (signal?: AbortSignal) => list<PayRateDTO>('/v1/admin/rates/pay', { signal }),
  createPayRate: (body: { user_id: string; amount_cents: number; currency: string; effective_from: string }) =>
    post<PayRateDTO>('/v1/admin/rates/pay', body),
  deletePayRate: (id: string) => ok(del(`/v1/admin/rates/pay/${enc(id)}`)),
  billRates: (signal?: AbortSignal) => list<BillRateDTO>('/v1/admin/rates/bill', { signal }),
  createBillRate: (body: { project_id: string; user_id: string | null; amount_cents: number; currency: string; effective_from: string }) =>
    post<BillRateDTO>('/v1/admin/rates/bill', body),
  deleteBillRate: (id: string) => ok(del(`/v1/admin/rates/bill/${enc(id)}`)),
  myPayRate: (signal?: AbortSignal) => get<MyPayRateResponse>('/v1/me/pay-rate', { signal }),
  budgets: (signal?: AbortSignal) => list<ProjectBudgetDTO>('/v1/admin/budgets', { signal }),
  projectBudget: (projectId: string, signal?: AbortSignal) =>
    get<ProjectBudgetResponse>(`/v1/projects/${enc(projectId)}/budget`, { signal }),
  putBudget: (projectId: string, body: BudgetBody) => put<ProjectBudgetResponse>(`/v1/projects/${enc(projectId)}/budget`, body),
  deleteBudget: (projectId: string) => ok(del(`/v1/projects/${enc(projectId)}/budget`)),
  invoices: (signal?: AbortSignal) => list<InvoiceSummaryDTO>('/v1/admin/invoices', { signal }),
  invoice: (id: string, signal?: AbortSignal) => get<InvoiceDTO>(`/v1/admin/invoices/${enc(id)}`, { signal }),
  createInvoice: (body: InvoiceDraftBody) => post<InvoiceDTO>('/v1/admin/invoices', body),
  updateInvoice: (id: string, body: { tax_rate_bp?: number; due_date?: string | null; notes?: string | null }) =>
    patch<InvoiceDTO>(`/v1/admin/invoices/${enc(id)}`, body),
  setInvoiceLines: (id: string, lines: InvoiceLineInput[]) => put<InvoiceDTO>(`/v1/admin/invoices/${enc(id)}/lines`, { lines }),
  issueInvoice: (id: string, dueDate?: string | null) =>
    post<InvoiceDTO>(`/v1/admin/invoices/${enc(id)}/issue`, dueDate !== undefined ? { due_date: dueDate } : {}),
  voidInvoice: (id: string, reason?: string) => post<InvoiceDTO>(`/v1/admin/invoices/${enc(id)}/void`, reason ? { reason } : {}),
  deleteInvoice: (id: string) => ok(del(`/v1/admin/invoices/${enc(id)}`)),
  /** Same-origin GET; the browser sends the session cookie and saves the CSV. */
  invoiceCsvUrl: (id: string) => `/v1/admin/invoices/${enc(id)}/csv`,
  markInvoicePaid: (id: string, paidOn: string, note?: string) =>
    post<InvoiceDTO>(`/v1/admin/invoices/${enc(id)}/paid`, note ? { paid_on: paidOn, note } : { paid_on: paidOn }),
  markInvoiceUnpaid: (id: string) => del<InvoiceDTO>(`/v1/admin/invoices/${enc(id)}/paid`),
  sendInvoice: (id: string, body: { to?: string; message?: string }) => post<InvoiceDTO>(`/v1/admin/invoices/${enc(id)}/send`, body),
  overview: (signal?: AbortSignal) => get<MoneyOverview>('/v1/money/overview', { signal }),
  payrollExports: (signal?: AbortSignal) => list<PayrollExportDTO>('/v1/admin/payroll-exports', { signal }),
  payrollExport: (id: string) => get<PayrollExportDTO>(`/v1/admin/payroll-exports/${enc(id)}`),
  createPayrollExport: (body: { period_from: string; period_to: string; timezone?: string; user_ids?: string[] }) =>
    post<PayrollExportDTO>('/v1/admin/payroll-exports', body),
};

export const rd = {
  money,
  auth: {
    login: (email: string, password: string) =>
      post<LoginResponse>('/v1/auth/login', { email, password }, { redirectOnAuth: false }),
    signup: (body: { org_name: string; display_name: string; email: string; password: string; accept_terms: true }) =>
      post<{ ok: true }>('/v1/signup', body, { redirectOnAuth: false }),
    verifySignup: (token: string) => post<{ ok: true }>('/v1/signup/verify', { token }, { redirectOnAuth: false }),
    mfaVerify: (code: string) => ok(post('/v1/auth/mfa/verify', { code }, { redirectOnAuth: false })),
    mfaEnroll: () => post<MfaEnrollResponse>('/v1/auth/mfa/enroll', {}, { redirectOnAuth: false }),
    mfaEnrollConfirm: (code: string) => post<RecoveryCodesResponse>('/v1/auth/mfa/enroll/confirm', { code }, { redirectOnAuth: false }),
    mfaRecovery: (recovery_code: string) =>
      post<{ ok: true; recovery_codes_left: number }>('/v1/auth/mfa/recovery', { recovery_code }, { redirectOnAuth: false }),
    logout: () => ok(post('/v1/auth/logout', {}, { redirectOnAuth: false })),
    // Links that arrive by email.
    invite: (token: string) => get<InviteInfo>(`/v1/invites/${enc(token)}`, { redirectOnAuth: false }),
    acceptInvite: (body: { token: string; password: string; timezone?: string }) =>
      ok(post('/v1/invites/accept', body, { redirectOnAuth: false })),
    requestPasswordReset: (email: string) => ok(post('/v1/auth/password-reset', { email }, { redirectOnAuth: false })),
    confirmPasswordReset: (token: string, password: string) =>
      ok(post('/v1/auth/password-reset/confirm', { token, password }, { redirectOnAuth: false })),
    confirmEmailChange: (token: string) => ok(post('/v1/auth/email-change/confirm', { token }, { redirectOnAuth: false })),
  },
  account: {
    security: (signal?: AbortSignal) => get<AccountSecurity>('/v1/me/security', { signal }),
    update: (body: { display_name?: string; timezone?: string }) => ok(patch('/v1/me', body)),
    changePassword: (current_password: string, new_password: string) => ok(post('/v1/me/password', { current_password, new_password })),
    changeEmail: (new_email: string, current_password: string) => ok(post('/v1/me/email', { new_email, current_password })),
    newRecoveryCodes: () => post<RecoveryCodesResponse>('/v1/auth/mfa/recovery-codes'),
    signOutOthers: () => post<{ signed_out: number }>('/v1/me/sessions/sign-out-others'),
  },
  me: (opts?: RequestOptions) => get<Me>('/v1/me', opts),
  person: {
    visibility: (userId: string, signal?: AbortSignal) => get<MemberVisibility>(`/v1/users/${enc(userId)}/visibility`, { signal }),
    sessions: (base: PersonBase, r: Range, signal?: AbortSignal) =>
      list<SessionDTO>(`${base}/sessions`, { query: { ...r }, signal }),
    activity: (base: PersonBase, r: Range, signal?: AbortSignal) =>
      get<ActivityResponse>(`${base}/activity`, { query: { ...r }, signal }),
    apps: (base: PersonBase, r: Range, signal?: AbortSignal) =>
      get<AppUsageResponse>(`${base}/apps`, { query: { ...r }, signal }),
    screenshots: (base: PersonBase, r: Range, signal?: AbortSignal) =>
      list<ScreenshotDTO>(`${base}/screenshots`, { query: { ...r }, signal }),
  },
  my: {
    corrections: (signal?: AbortSignal) => list<CorrectionDTO>('/v1/me/corrections', { signal }),
    proposeCorrection: (body: TimeCorrectionBody) => post<CorrectionDTO>('/v1/me/time-corrections', body),
    requestDeletion: (screenshotId: string, reason: string) =>
      post<DeletionRequestDTO>('/v1/me/deletion-requests', {
        target_type: 'screenshot',
        target_id: screenshotId,
        reason,
      }),
    notifications: (signal?: AbortSignal) => get<NotificationsResponse>('/v1/me/notifications', { signal }),
    unreadCount: (signal?: AbortSignal) => get<{ unread: number }>('/v1/me/notifications/unread-count', { signal }),
    markRead: (id: string) => ok(post(`/v1/me/notifications/${enc(id)}/read`)),
    markAllRead: () => post<{ marked: number }>('/v1/me/notifications/read-all'),
    notificationPreferences: (signal?: AbortSignal) => get<NotificationPreferencesResponse>('/v1/me/notification-preferences', { signal }),
    setNotificationPreferences: (items: { category: NotificationCategory; in_app: boolean; email: boolean }[]) =>
      put<NotificationPreferencesResponse>('/v1/me/notification-preferences', { items }),
    policy: (signal?: AbortSignal) => get<MyPolicyResponse>('/v1/me/policy', { signal }),
    accessLog: (signal?: AbortSignal) => list<AuditEventDTO>('/v1/me/access-log', { signal }),
    projects: (signal?: AbortSignal) => list<ProjectDTO>('/v1/me/projects', { signal }),
    directory: (signal?: AbortSignal) => get<DirectoryResponse>('/v1/me/directory', { signal }),
    insights: (r: Range, tz: string, signal?: AbortSignal) => get<PersonalInsights>('/v1/me/insights', { query: { ...r, tz }, signal }),
    todos: (signal?: AbortSignal) => get<TodosResponse>('/v1/me/todos', { signal }),
  },
  screenshotViewUrl: (id: string) => get<ViewUrlResponse>(`/v1/screenshots/${enc(id)}/view-url`),
  teams: {
    list: (signal?: AbortSignal) => list<TeamSummary>('/v1/teams', { signal }),
    report: (id: string, r: Range, tz: string, signal?: AbortSignal, projectId?: string | null) =>
      get<TeamReport>(`/v1/teams/${enc(id)}/report`, { query: { ...r, tz, ...(projectId ? { project_id: projectId } : {}) }, signal }),
    insights: (id: string, r: Range, tz: string, signal?: AbortSignal) =>
      get<TeamInsights>(`/v1/teams/${enc(id)}/insights`, { query: { ...r, tz }, signal }),
  },
  projects: {
    list: (signal?: AbortSignal) => list<ProjectDTO>('/v1/projects', { signal }),
    report: (id: string, r: Range, signal?: AbortSignal) =>
      get<ProjectReport>(`/v1/projects/${enc(id)}/report`, { query: { ...r }, signal }),
  },
  corrections: {
    pending: (signal?: AbortSignal) => list<CorrectionDTO>('/v1/corrections/pending', { signal }),
    approve: (id: string, note?: string) => ok(post(`/v1/corrections/${enc(id)}/approve`, note ? { note } : {})),
    reject: (id: string, note?: string) => ok(post(`/v1/corrections/${enc(id)}/reject`, note ? { note } : {})),
  },
  exports: {
    list: (signal?: AbortSignal) => list<ExportDTO>('/v1/exports', { signal }),
    get: (id: string) => get<ExportDTO>(`/v1/exports/${enc(id)}`),
    create: (body: {
      kind: 'sessions' | 'activity_daily';
      from: string;
      to: string;
      team_id?: string;
      user_id?: string;
    }) => post<ExportDTO>('/v1/exports', body),
  },
  admin: {
    users: (signal?: AbortSignal) => list<UserDTO>('/v1/admin/users', { signal }),
    createUser: (body: CreateUserBody) =>
      post<{ user: UserDTO; invite_sent: boolean }>('/v1/admin/users', body),
    resendInvite: (id: string) => post<{ invite_sent: true }>(`/v1/admin/users/${enc(id)}/invite`),
    resetMfa: (id: string) => ok(post(`/v1/admin/users/${enc(id)}/mfa/reset`)),
    /** Resolves to the updated user, or null when the API returns no body. */
    updateUser: (id: string, body: UpdateUserBody) =>
      patch<UserDTO | undefined>(`/v1/admin/users/${enc(id)}`, body).then((u) => u ?? null),
    deactivateUser: (id: string) => ok(post(`/v1/admin/users/${enc(id)}/deactivate`)),
    reactivateUser: (id: string) => post<UserDTO>(`/v1/admin/users/${enc(id)}/reactivate`),
    importUsers: (rows: readonly unknown[], dryRun: boolean) => post<UserImportResponse>('/v1/admin/users/import', { rows, dry_run: dryRun }),
    renameTeam: (id: string, name: string) => patch<{ id: string; name: string }>(`/v1/admin/teams/${enc(id)}`, { name }),
    archiveTeam: (id: string) => ok(post(`/v1/admin/teams/${enc(id)}/archive`)),
    updateProject: (id: string, body: { name?: string; client_ref?: string | null; status?: 'active' | 'archived' }) =>
      patch<ProjectDTO>(`/v1/admin/projects/${enc(id)}`, body),
    updateTask: (projectId: string, taskId: string, body: { name?: string; status?: 'active' | 'archived' }) =>
      ok(patch(`/v1/admin/projects/${enc(projectId)}/tasks/${enc(taskId)}`, body)),
    removeProjectMember: (projectId: string, userId: string) => ok(del(`/v1/admin/projects/${enc(projectId)}/members/${enc(userId)}`)),
    teams: (signal?: AbortSignal) => list<TeamSummary>('/v1/admin/teams', { signal }),
    createTeam: (name: string) => post<TeamSummary>('/v1/admin/teams', { name }),
    addTeamMember: (teamId: string, userId: string, role: 'member' | 'manager') =>
      ok(post(`/v1/admin/teams/${enc(teamId)}/members`, { user_id: userId, role })),
    removeTeamMember: (teamId: string, userId: string) =>
      ok(del(`/v1/admin/teams/${enc(teamId)}/members/${enc(userId)}`)),
    projects: (signal?: AbortSignal) => list<AdminProjectDTO>('/v1/admin/projects', { signal }),
    createProject: (name: string, clientRef?: string) =>
      post<ProjectDTO>('/v1/admin/projects', clientRef ? { name, client_ref: clientRef } : { name }),
    addTask: (projectId: string, name: string) => ok(post(`/v1/admin/projects/${enc(projectId)}/tasks`, { name })),
    addProjectMember: (projectId: string, userId: string, role: 'member' | 'manager') =>
      ok(post(`/v1/admin/projects/${enc(projectId)}/members`, { user_id: userId, role })),
    enrollmentCode: (userId: string) =>
      post<EnrollmentCodeResponse>('/v1/admin/enrollment-codes', { user_id: userId }),
    devices: (signal?: AbortSignal) => list<DeviceDTO>('/v1/admin/devices', { signal }),
    revokeDevice: (id: string) => ok(post(`/v1/admin/devices/${enc(id)}/revoke`)),
    deletionRequests: (signal?: AbortSignal) =>
      list<DeletionRequestDTO>('/v1/admin/deletion-requests', { signal }),
    approveDeletion: (id: string) => ok(post(`/v1/admin/deletion-requests/${enc(id)}/approve`)),
    rejectDeletion: (id: string) => ok(post(`/v1/admin/deletion-requests/${enc(id)}/reject`)),
    overview: (signal?: AbortSignal) => get<AdminOverview>('/v1/admin/overview', { signal }),
    timesheetRule: (signal?: AbortSignal) => get<TimesheetRule>('/v1/admin/timesheet-rule', { signal }),
    setTimesheetRule: (rule: TimesheetRule) => put<TimesheetRule>('/v1/admin/timesheet-rule', rule),
    appCategories: (signal?: AbortSignal) => list<AppCategoryDTO>('/v1/admin/app-categories', { signal }),
    setAppCategory: (body: { app_identifier: string; category: AppCategory; team_id?: string | null }) =>
      put<AppCategoryDTO>('/v1/admin/app-categories', body),
    deleteAppCategory: (id: string) => ok(del(`/v1/admin/app-categories/${enc(id)}`)),
    webhooks: (signal?: AbortSignal) => list<WebhookEndpointDTO>('/v1/admin/webhooks', { signal }),
    createWebhook: (body: { url: string; description?: string; events: WebhookEventType[] }) =>
      post<WebhookEndpointDTO>('/v1/admin/webhooks', body),
    deleteWebhook: (id: string) => ok(del(`/v1/admin/webhooks/${enc(id)}`)),
    testWebhook: (id: string) => ok(post(`/v1/admin/webhooks/${enc(id)}/test`)),
    webhookDeliveries: (id: string, signal?: AbortSignal) =>
      list<WebhookDeliveryDTO>(`/v1/admin/webhooks/${enc(id)}/deliveries`, { signal }),
  },
  policies: {
    list: (signal?: AbortSignal) => get<PolicyListResponse>('/v1/policies', { signal }),
    detail: (type: ScopeType, id: string, signal?: AbortSignal) =>
      get<PolicyScopeDetail>(`/v1/policies/${type}/${enc(id)}`, { signal }),
    publish: (
      type: ScopeType,
      id: string,
      body: { settings: PartialPolicySettings; change_note: string; confirm_expansion: boolean },
    ) => put<PolicyScopeDetail>(`/v1/policies/${type}/${enc(id)}`, body),
  },
  billing: {
    subscription: (signal?: AbortSignal) => get<SubscriptionDTO>('/v1/billing/subscription', { signal }),
    changePlan: (plan: PlanId, seats: number, interval?: BillingInterval) =>
      post<ChangePlanResponse>('/v1/billing/plan', interval ? { plan, seats, interval } : { plan, seats }),
    portal: () => post<{ url: string }>('/v1/billing/portal', {}),
  },
  approvals: {
    /** What's waiting on the signed-in reviewer, for the badge. */
    counts: (signal?: AbortSignal) => get<InboxCounts>('/v1/inbox/counts', { signal }),
    batch: (body: { action: 'approve' | 'reject'; note?: string; items: { type: ApprovalType; id: string }[] }) =>
      post<ApprovalsBatchResponse>('/v1/approvals/batch', body),
  },
  auditPeople: (signal?: AbortSignal) => list<AuditPerson>('/v1/audit-events/people', { signal }),
  /** Same-origin GET of the filtered log as CSV; the browser sends the session cookie. */
  auditExportUrl: (q: Omit<AuditQuery, 'cursor'>) => {
    const p = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
    return `/v1/audit-events/export${p.size ? `?${p}` : ''}`;
  },
  audit: (q: AuditQuery, signal?: AbortSignal) =>
    get<Page<AuditEventDTO>>('/v1/audit-events', { query: { ...q }, signal }),
};

/** Human copy for error codes the UI must handle (§5.4). */
export function describeError(e: ApiError): string {
  switch (e.code) {
    case 'unauthenticated':
      return 'Your session has ended. Sign in again.';
    case 'mfa_required':
      return 'This needs two-factor verification first.';
    case 'forbidden':
      return "You don't have access to this.";
    case 'not_found':
      return "We couldn't find that. It may have been removed, or you may not have access.";
    case 'validation_failed':
      return e.message || 'Some values are not valid.';
    case 'seat_limit_reached':
      return 'All licensed seats (including the overage allowance) are in use. Add seats in Billing first.';
    case 'plan_upgrade_required':
      return "Your plan doesn't include this. An org admin can change the plan in Billing.";
    case 'subscription_inactive':
      return 'Your organization’s subscription is inactive, so this is read-only.';
    case 'network_error':
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      return e.message || 'Something went wrong.';
  }
}
