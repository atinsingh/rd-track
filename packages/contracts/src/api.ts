import { z } from 'zod';
import { timestamp, uuid } from './events';
import { partialPolicySettingsSchema, type FieldSource, type PolicySettings, type ScopeType } from './policy';
import type { CollectionChange } from './policy';
import { BILLING_INTERVALS, type BillingInterval, type Entitlement, type LicenseState, type PlanId, type SubscriptionStatus } from './plans';
import type { AppLocale } from './locale';
import type { BrowserFamily } from './agent-api';

/**
 * Web/API request schemas and response shapes (system design §5.4).
 * All wire fields are snake_case; timestamps are RFC 3339 UTC strings.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; request_id: string; details?: unknown };
}

/** `finance` (slice 4, G21) runs Money: rates, invoices, budgets and payroll, without full admin. */
export const ORG_ROLES = ['employee', 'org_admin', 'auditor', 'super_admin', 'finance'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

// ───────────────────────── auth ─────────────────────────

export const loginRequest = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(1).max(200),
});
export const mfaVerifyRequest = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
export const mfaEnrollConfirmRequest = mfaVerifyRequest;

export interface LoginResponse {
  /** true when the user must complete TOTP (enrolled) or enroll (privileged role without MFA). */
  mfa_required: boolean;
  mfa_enrolled: boolean;
}
export interface MfaEnrollResponse {
  secret_base32: string;
  otpauth_url: string;
}

export interface Me {
  user: {
    id: string;
    email: string;
    display_name: string;
    org_role: OrgRole;
    timezone: string;
    tracking_enabled: boolean;
    mfa_enabled: boolean;
    /** The person's language and formats (G27); null follows the organization's. */
    locale: AppLocale | null;
  };
  organization: {
    id: string;
    name: string;
    plan: PlanId;
    license: LicenseState;
    /** The organization's default language and formats; null follows each browser. */
    locale: AppLocale | null;
    /** The organization's own logo (G26), a short-lived link; null when none is set. */
    logo_url: string | null;
  };
  mfa_verified: boolean;
  managed_team_ids: string[];
  managed_project_ids: string[];
  entitlements: Entitlement[];
}

// ───────────────────────── time & activity ─────────────────────────

export const rangeQuery = z.object({
  from: timestamp,
  to: timestamp,
});

export type SessionState = 'active' | 'paused' | 'stopped';
export interface SessionDTO {
  id: string;
  user_id: string;
  device_id: string | null;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  task_name: string | null;
  state: SessionState;
  source: 'agent' | 'manual';
  corrected: boolean;
  started_at: string;
  ended_at: string | null;
  tracked_seconds: number;
  active_seconds: number;
  idle_seconds: number;
  paused_seconds: number;
  /** Idle time the person removed or moved on return (Stage 4 F1). `keep` is not listed. */
  idle_adjustments: IdleAdjustmentDTO[];
}

export interface IdleAdjustmentDTO {
  id: string;
  idle_started_at: string;
  idle_ended_at: string;
  seconds: number;
  decision: 'discard' | 'reassign';
  /** applied: in effect · pending: a move waiting for approval · rejected: no effect */
  status: 'applied' | 'pending' | 'rejected';
  /** `week_locked`, `unknown_project` */
  status_reason: string | null;
  /** Target project of a move. */
  project_name: string | null;
}

export interface ActivityBucketDTO {
  bucket_start: string;
  active_seconds: number;
  idle_seconds: number;
  keyboard_count: number;
  mouse_count: number;
  data_quality: 'ok' | 'partial' | 'permission_missing';
}
export interface IntervalDTO {
  from: string;
  to: string;
  reason: string;
}
export interface ActivityTotals {
  tracked_seconds: number;
  active_seconds: number;
  idle_seconds: number;
  /** null when there is no measurable time */
  activity_percent: number | null;
  manual_seconds: number;
  paused_seconds: number;
  gap_seconds: number;
}
export interface ActivityResponse {
  from: string;
  to: string;
  buckets: ActivityBucketDTO[];
  gaps: IntervalDTO[];
  pauses: IntervalDTO[];
  totals: ActivityTotals;
}

export interface AppUsageRow {
  app_identifier: string;
  app_name: string;
  domain: string | null;
  seconds: number;
  /** Team/org work-app category (ACT-07); null when uncategorized. */
  category: 'core_work' | 'supporting' | 'communication' | 'break' | null;
}
export interface AppUsageResponse {
  from: string;
  to: string;
  apps: AppUsageRow[];
}

// ───────────────────────── screenshots ─────────────────────────

export interface ScreenshotDTO {
  id: string;
  session_id: string;
  user_id: string;
  captured_at: string;
  status: 'pending' | 'verifying' | 'stored' | 'deleted' | 'failed';
  width: number | null;
  height: number | null;
  retention_after: string;
  deletion_request_status: 'pending' | 'approved' | 'rejected' | null;
  /** App in front at capture time, when app names are collected. */
  app_name: string | null;
}
export interface ViewUrlResponse {
  url: string;
  expires_at: string;
}

export const uploadIntentRequest = z.strictObject({
  session_id: uuid,
  content_type: z.enum(['image/webp', 'image/jpeg']),
});
export interface UploadIntentResponse {
  screenshot_id: string;
  upload_url: string;
  upload_headers: Record<string, string>;
  expires_at: string;
}
export const screenshotCompleteRequest = z.strictObject({
  screenshot_id: uuid,
  captured_at: timestamp,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(1).max(10 * 1024 * 1024),
  width: z.number().int().min(1).max(8000),
  height: z.number().int().min(1).max(8000),
});

export const deletionRequestCreate = z.strictObject({
  target_type: z.literal('screenshot'),
  target_id: uuid,
  reason: z.string().min(3).max(1000),
});
export interface DeletionRequestDTO {
  id: string;
  requester_id: string;
  requester_name: string;
  target_type: 'screenshot';
  target_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed';
  reviewer_id: string | null;
  created_at: string;
  completed_at: string | null;
}

// ───────────────────────── corrections ─────────────────────────

const correctionValues = z.strictObject({
  started_at: timestamp,
  ended_at: timestamp,
  project_id: uuid.nullable(),
  task_id: uuid.nullable().optional(),
});
export const timeCorrectionRequest = z.strictObject({
  /** omit for a new manual time entry */
  session_id: uuid.optional(),
  requested: correctionValues,
  reason: z.string().min(3).max(1000),
});
export type CorrectionValues = z.infer<typeof correctionValues>;
export interface CorrectionDTO {
  id: string;
  user_id: string;
  user_name: string;
  session_id: string | null;
  kind: 'edit' | 'manual_add' | 'idle_reassign';
  original: CorrectionValues | null;
  requested: CorrectionValues;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  /** Names of the projects in `original` and `requested`, so a reviewer who doesn't manage them still reads names. */
  project_names: Record<string, string>;
}
export const reviewRequest = z.strictObject({ note: z.string().max(1000).optional() });

// ───────────────────────── reports ─────────────────────────

/** Names for the ⌘K palette: the people in teams you manage and the projects you manage. Names only, no data. */
export interface DirectoryPerson {
  user_id: string;
  display_name: string;
  team_id: string;
  team_name: string;
}
export interface DirectoryResponse {
  people: DirectoryPerson[];
  projects: { id: string; name: string }[];
}

export interface TeamSummary {
  id: string;
  name: string;
  member_count: number;
}
export interface MemberReportRow {
  user_id: string;
  display_name: string;
  tracked_seconds: number;
  active_seconds: number;
  idle_seconds: number;
  activity_percent: number | null;
  gap_seconds: number;
  paused_seconds: number;
  manual_seconds: number;
  days_active: number;
  notes: string[];
}
export interface DailyProjectRow {
  date: string;
  projects: { project_id: string | null; project_name: string; seconds: number }[];
}
export interface TeamReport {
  team: TeamSummary;
  from: string;
  to: string;
  members: MemberReportRow[];
  daily: DailyProjectRow[];
  /** what the requesting manager may see for this team under policy */
  visibility: { activity: boolean; apps: boolean; screenshots: boolean };
}
/** GET /v1/users/{id}/visibility: what the requester may see about this person. */
export interface MemberVisibility {
  time: boolean;
  activity: boolean;
  apps: boolean;
  screenshots: boolean;
}
export interface ProjectReport {
  project: { id: string; name: string };
  from: string;
  to: string;
  members: { user_id: string; display_name: string; seconds: number }[];
  daily: { date: string; seconds: number }[];
}

// ───────────────────────── exports ─────────────────────────

export const exportCreateRequest = z.strictObject({
  kind: z.enum(['sessions', 'activity_daily']),
  from: timestamp,
  to: timestamp,
  team_id: uuid.optional(),
  user_id: uuid.optional(),
});
export interface ExportDTO {
  id: string;
  kind: 'sessions' | 'activity_daily';
  from: string;
  to: string;
  team_id: string | null;
  user_count: number;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  row_count: number | null;
  created_at: string;
  expires_at: string | null;
  download_url: string | null;
}

// ───────────────────────── admin ─────────────────────────

export const createUserRequest = z.strictObject({
  email: z.email().max(320),
  display_name: z.string().min(1).max(200),
  org_role: z.enum(ORG_ROLES).default('employee'),
  tracking_enabled: z.boolean().default(true),
  timezone: z.string().min(1).max(64).default('UTC'),
  /**
   * For scripted provisioning only. Omit it and the person gets an invite email to choose
   * their own password; nobody else ever sees it.
   */
  password: z.string().min(12).max(200).optional(),
});
export const updateUserRequest = z.strictObject({
  display_name: z.string().min(1).max(200).optional(),
  org_role: z.enum(ORG_ROLES).optional(),
  tracking_enabled: z.boolean().optional(),
  timezone: z.string().min(1).max(64).optional(),
});
export interface UserDTO {
  id: string;
  email: string;
  display_name: string;
  org_role: OrgRole;
  status: 'active' | 'deactivated';
  tracking_enabled: boolean;
  mfa_enabled: boolean;
  timezone: string;
  teams: { id: string; name: string; role: 'member' | 'manager' }[];
  created_at: string;
  /** Invited and hasn't chosen a password yet. */
  invite_pending: boolean;
  invited_at: string | null;
}

export const createTeamRequest = z.strictObject({ name: z.string().min(1).max(200) });
export const teamMemberRequest = z.strictObject({
  user_id: uuid,
  role: z.enum(['member', 'manager']).default('member'),
});
export const createProjectRequest = z.strictObject({
  name: z.string().min(1).max(200),
  client_ref: z.string().max(200).optional(),
});
export const createTaskRequest = z.strictObject({ name: z.string().min(1).max(200) });
export const projectMemberRequest = teamMemberRequest;

// ───────── People and Teams pages (slice 4b, G14–G15) ─────────

const structureName = z.string().trim().min(1).max(200);
export const teamUpdateRequest = z.strictObject({ name: structureName });
export const projectUpdateRequest = z.strictObject({
  name: structureName.optional(),
  client_ref: z.string().trim().max(200).nullable().optional(),
  /** Archived projects leave everyone's project picker; their time stays on record. */
  status: z.enum(['active', 'archived']).optional(),
});
export const taskUpdateRequest = z.strictObject({ name: structureName.optional(), status: z.enum(['active', 'archived']).optional() });

/** The admin view of a project adds who is on it. */
export interface AdminProjectDTO extends ProjectDTO {
  members: { user_id: string; display_name: string; role: 'member' | 'manager' }[];
}

/** One CSV row of people to invite. Rows are checked one by one, so one bad row never blocks the rest. */
export const userImportRow = z.strictObject({
  email: z.email().max(320),
  display_name: z.string().trim().min(1).max(200),
  org_role: z.enum(ORG_ROLES).default('employee'),
  timezone: z.string().min(1).max(64).default('UTC'),
  tracking_enabled: z.boolean().default(true),
  /** A team to join as a member; created if it doesn't exist yet. */
  team: z.string().trim().min(1).max(200).optional(),
});
export type UserImportRow = z.input<typeof userImportRow>;
export const USER_IMPORT_MAX_ROWS = 500;
export const userImportRequest = z.strictObject({
  rows: z.array(z.unknown()).min(1).max(USER_IMPORT_MAX_ROWS),
  /** Check every row (format, duplicates, existing people, seats) without inviting anyone. */
  dry_run: z.boolean().default(false),
});
export interface UserImportResult {
  /** 1-based, matching the file's data rows. */
  row: number;
  email: string | null;
  ok: boolean;
  code?: string;
  message?: string;
  user_id?: string;
  team?: 'joined' | 'created';
}
export interface UserImportResponse {
  dry_run: boolean;
  ok: number;
  failed: number;
  results: UserImportResult[];
}
export interface ProjectDTO {
  id: string;
  name: string;
  client_ref: string | null;
  /** The client it's billed to (Money), so expenses on it can be billed too. */
  client_name: string | null;
  status: 'active' | 'archived';
  tasks: { id: string; name: string }[];
}

export const enrollmentCodeRequest = z.strictObject({ user_id: uuid });
export interface EnrollmentCodeResponse {
  code: string;
  expires_at: string;
  user_id: string;
}
export type PermissionState = 'granted' | 'denied' | 'not_required' | 'unknown';
export interface DeviceDTO {
  id: string;
  user_id: string;
  user_name: string;
  name: string;
  os: 'windows' | 'macos' | 'linux';
  os_version: string;
  agent_version: string;
  credential_status: 'active' | 'revoked';
  enrolled_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  last_sync_at: string | null;
  applied_policy_revision: number | null;
  current_policy_revision: number;
  permissions: Record<string, PermissionState>;
  clock_skew_detected: boolean;
  sequence_gaps: number;
  /** Browsers on this computer with the Track extension (website domains, Pro). */
  browser_extensions: BrowserFamily[];
}

// ───────────────────────── policies ─────────────────────────

export const policyUpdateRequest = z.strictObject({
  settings: partialPolicySettingsSchema,
  change_note: z.string().min(3).max(2000),
  confirm_expansion: z.boolean().default(false),
});
export interface PolicyVersionDTO {
  version: number;
  org_revision: number;
  settings: z.infer<typeof partialPolicySettingsSchema>;
  change_note: string;
  expands_collection: boolean;
  published_by: string;
  published_at: string;
}
export interface PolicyScopeDTO {
  scope_type: ScopeType;
  scope_id: string;
  scope_name: string;
  current: PolicyVersionDTO | null;
}
export interface PolicyListResponse {
  org_revision: number;
  scopes: PolicyScopeDTO[];
}
/** GET /v1/policies/{scope_type}/{scope_id}: the scope's own document plus the effective
 * result of organization (+ this scope) + plan, with per-field sources for "because …". */
export interface PolicyScopeDetail {
  scope: PolicyScopeDTO;
  history: PolicyVersionDTO[];
  effective: { settings: PolicySettings; sources: Record<string, FieldSource[]> };
  /** fields the current plan blocks, e.g. "screenshots.enabled" on Standard */
  plan_locked_fields: string[];
  affected_users: number;
}
export interface ExpansionConflict {
  affected_users: number;
  changes: CollectionChange[];
}
export interface MyPolicyResponse {
  org_revision: number;
  published_at: string | null;
  published_by: string | null;
  /** base policy (no project) and per-project effective policies where they differ */
  base: { settings: PolicySettings; sources: Record<string, FieldSource[]> };
  projects: { project_id: string; project_name: string; settings: PolicySettings }[];
  viewers: { user_id: string; display_name: string; relation: 'team_manager' | 'project_manager'; sees: string[] }[];
}

// ───────────────────────── audit & notifications ─────────────────────────

export interface AuditEventDTO {
  id: string;
  actor_type: 'user' | 'device' | 'system' | 'platform' | 'directory' | 'api_token';
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_user_id: string | null;
  result: 'success' | 'denied' | 'error';
  request_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ───────────────────────── billing ─────────────────────────

export interface SubscriptionDTO {
  plan: PlanId;
  plan_name: string;
  status: SubscriptionStatus;
  license: LicenseState;
  seats: number;
  billable_seats: number;
  viewer_seats: number;
  seat_ceiling: number;
  billing_interval: BillingInterval;
  /** Per seat per month on this term. */
  price_per_seat_cents: number;
  /** Seats × price, per month. */
  estimated_monthly_cents: number;
  /** What one invoice comes to: the monthly estimate, or 12 months of it on an annual term. */
  estimated_invoice_cents: number;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  current_period_end: string | null;
  billing_provider: 'manual' | 'stripe';
  cancel_at_period_end: boolean;
  entitlements: Entitlement[];
}
/** POST /v1/billing/plan: with Stripe, a new paid subscription returns a hosted Checkout URL. */
export interface ChangePlanResponse {
  subscription: SubscriptionDTO;
  checkout_url: string | null;
}

// ───────────────────────── signup ─────────────────────────

export const signupRequest = z.strictObject({
  org_name: z.string().trim().min(2).max(200),
  display_name: z.string().trim().min(1).max(200),
  email: z.email().max(320),
  password: z.string().min(12).max(200),
  /** The subscription terms and data processing agreement (TERMS_VERSION). */
  accept_terms: z.literal(true, { error: 'Accept the terms and the data processing agreement to continue.' }),
});
export const signupVerifyRequest = z.strictObject({ token: z.string().min(20).max(200) });
export const changePlanRequest = z.strictObject({
  plan: z.enum(['free', 'standard', 'pro']),
  seats: z.number().int().min(0).max(100_000),
  /** Omitted: keep the current term (month for a new paid plan). */
  interval: z.enum(BILLING_INTERVALS).optional(),
});

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ───────────── Stage 4 F2: batch approvals ─────────────

export const APPROVAL_TYPES = ['correction', 'timesheet', 'time_off', 'deletion_request', 'expense'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];
export const MAX_BATCH_APPROVALS = 100;

/**
 * Approve or send back several requests at once. Each item is checked exactly as if it
 * were reviewed on its own (your own requests, scope, plan, state) and succeeds or
 * fails independently. Sending back needs a note, as it does one at a time.
 */
export const approvalsBatchRequest = z
  .strictObject({
    action: z.enum(['approve', 'reject']),
    note: z.string().trim().max(1000).optional(),
    items: z
      .array(z.strictObject({ type: z.enum(APPROVAL_TYPES), id: uuid }))
      .min(1)
      .max(MAX_BATCH_APPROVALS),
  })
  .refine((b) => b.action === 'approve' || (b.note ?? '').length >= 3, { message: 'A note of at least 3 characters is required to send back', path: ['note'] });

export interface ApprovalsBatchResult {
  type: ApprovalType;
  id: string;
  ok: boolean;
  /** On failure: the same error code a single review would return. */
  code?: string;
  message?: string;
}
export interface ApprovalsBatchResponse {
  approved: number;
  rejected: number;
  failed: number;
  results: ApprovalsBatchResult[];
}
