import type {
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
  NotificationDTO,
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
  cursor?: string;
}

export const rd = {
  auth: {
    login: (email: string, password: string) =>
      post<LoginResponse>('/v1/auth/login', { email, password }, { redirectOnAuth: false }),
    signup: (body: { org_name: string; display_name: string; email: string; password: string }) =>
      post<{ ok: true }>('/v1/signup', body, { redirectOnAuth: false }),
    verifySignup: (token: string) => post<{ ok: true }>('/v1/signup/verify', { token }, { redirectOnAuth: false }),
    mfaVerify: (code: string) => ok(post('/v1/auth/mfa/verify', { code }, { redirectOnAuth: false })),
    mfaEnroll: () => post<MfaEnrollResponse>('/v1/auth/mfa/enroll', {}, { redirectOnAuth: false }),
    mfaEnrollConfirm: (code: string) => ok(post('/v1/auth/mfa/enroll/confirm', { code }, { redirectOnAuth: false })),
    logout: () => ok(post('/v1/auth/logout', {}, { redirectOnAuth: false })),
  },
  me: (opts?: RequestOptions) => get<Me>('/v1/me', opts),
  person: {
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
    notifications: (signal?: AbortSignal) => list<NotificationDTO>('/v1/me/notifications', { signal }),
    markRead: (id: string) => ok(post(`/v1/me/notifications/${enc(id)}/read`)),
    policy: (signal?: AbortSignal) => get<MyPolicyResponse>('/v1/me/policy', { signal }),
    accessLog: (signal?: AbortSignal) => list<AuditEventDTO>('/v1/me/access-log', { signal }),
    projects: (signal?: AbortSignal) => list<ProjectDTO>('/v1/me/projects', { signal }),
  },
  screenshotViewUrl: (id: string) => get<ViewUrlResponse>(`/v1/screenshots/${enc(id)}/view-url`),
  teams: {
    list: (signal?: AbortSignal) => list<TeamSummary>('/v1/teams', { signal }),
    report: (id: string, r: Range, tz: string, signal?: AbortSignal) =>
      get<TeamReport>(`/v1/teams/${enc(id)}/report`, { query: { ...r, tz }, signal }),
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
      post<{ user: UserDTO; initial_password?: string }>('/v1/admin/users', body),
    /** Resolves to the updated user, or null when the API returns no body. */
    updateUser: (id: string, body: UpdateUserBody) =>
      patch<UserDTO | undefined>(`/v1/admin/users/${enc(id)}`, body).then((u) => u ?? null),
    deactivateUser: (id: string) => ok(post(`/v1/admin/users/${enc(id)}/deactivate`)),
    teams: (signal?: AbortSignal) => list<TeamSummary>('/v1/admin/teams', { signal }),
    createTeam: (name: string) => post<TeamSummary>('/v1/admin/teams', { name }),
    addTeamMember: (teamId: string, userId: string, role: 'member' | 'manager') =>
      ok(post(`/v1/admin/teams/${enc(teamId)}/members`, { user_id: userId, role })),
    removeTeamMember: (teamId: string, userId: string) =>
      ok(del(`/v1/admin/teams/${enc(teamId)}/members/${enc(userId)}`)),
    projects: (signal?: AbortSignal) => list<ProjectDTO>('/v1/admin/projects', { signal }),
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
    changePlan: (plan: PlanId, seats: number) => post<ChangePlanResponse>('/v1/billing/plan', { plan, seats }),
    portal: () => post<{ url: string }>('/v1/billing/portal', {}),
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
