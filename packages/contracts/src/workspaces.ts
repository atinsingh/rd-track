import { z } from 'zod';
import type { InvoiceSummaryDTO, ProjectBudgetDTO } from './money';

// Role workspaces (engine slice 4, docs/design/07-product-review.md §4): what each role's
// home is assembled from. Counts and totals only; no activity levels anywhere.

// ───────────── org admin: setup and health ─────────────

/** Steps an org admin takes after signup (G16). Done-ness is computed from the data, never ticked by hand. */
export const SETUP_STEPS = [
  'turn_on_mfa',
  'review_policy',
  'invite_people',
  'create_team',
  'connect_computer',
  'timesheet_deadline',
  'choose_plan',
] as const;
export type SetupStepKey = (typeof SETUP_STEPS)[number];
export interface SetupStep {
  key: SetupStepKey;
  done: boolean;
  /** Nice to have; the checklist counts as complete without it. */
  optional: boolean;
}

/** Teams smaller than this show a member count but no hours in the organization summary. */
export const TEAM_SUMMARY_MIN_PEOPLE = 5;

export interface OrgWeekSummary {
  /** Monday of the week, in the admin's time zone. */
  week: string;
  tracked_seconds: number;
  previous_week_seconds: number;
  people_tracked: number;
  teams: { id: string; name: string; members: number; tracked_seconds: number | null }[];
}

export interface AdminOverview {
  setup: SetupStep[];
  people: { active: number; invited: number; tracking_off: number; without_reviewer: number };
  devices: { active: number; stale: number; permission_issues: number; never_synced: number };
  week: OrgWeekSummary;
}

// ───────────── finance: period close ─────────────

export interface UnbilledClient {
  client_id: string;
  client_name: string;
  /** First day not yet on an issued invoice (at most 90 days back). */
  since: string;
  seconds: number;
}

export interface MoneyOverview {
  /** The pay period: this calendar month in the viewer's time zone. */
  period: { from: string; to: string };
  /** Timesheets for weeks starting in the period; null when the plan has no timesheets. */
  timesheets: { approved: number; submitted: number; sent_back: number; approved_seconds: number } | null;
  /** Drafts and issued invoices not yet marked paid, oldest first. */
  open_invoices: InvoiceSummaryDTO[];
  paid_this_period: { count: number; by_currency: { currency: string; total_cents: number }[] };
  unbilled: UnbilledClient[];
  /** Budgets at 80% or more of their limit. */
  budgets: ProjectBudgetDTO[];
}

// ───────────── getting the agent (G10, G12) ─────────────

export interface AgentDownload {
  os: 'macos' | 'windows';
  label: string;
  /** What kind of file, for people who care: "Disk image", "Installer", "MSI for IT". */
  kind: string;
  url: string;
}
export interface AgentDownloadsResponse {
  available: boolean;
  version: string | null;
  files: AgentDownload[];
}

// ───────────── desktop app updates (G10) ─────────────

/** prompt: people restart when it suits them; auto: installed when no session runs; hold: none offered. */
export const AGENT_UPDATE_MODES = ['prompt', 'auto', 'hold'] as const;
export type AgentUpdateMode = (typeof AGENT_UPDATE_MODES)[number];
export const agentUpdateSettingsRequest = z.strictObject({ mode: z.enum(AGENT_UPDATE_MODES) });
export interface AgentUpdateSettings {
  mode: AgentUpdateMode;
  /** The version published for this service (`AGENT_VERSION`), if any. */
  latest_version: string | null;
  /** Connected computers per app version, newest first. */
  versions: { version: string; devices: number; current: boolean }[];
}
/** `GET /v1/device/update`: Tauri's dynamic update format, plus how this organization applies it. */
export interface DeviceUpdateResponse {
  version: string;
  url: string;
  signature: string;
  notes: string;
  pub_date: string | null;
  mode: 'prompt' | 'auto';
}

// ───────────── branding and MDM deployment (G26) ─────────────

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const logoUploadRequest = z.strictObject({
  content_type: z.enum(LOGO_CONTENT_TYPES),
  size_bytes: z.number().int().min(1).max(LOGO_MAX_BYTES),
});
export interface LogoUploadResponse {
  upload_id: string;
  url: string;
  headers: Record<string, string>;
}
export const logoSetRequest = z.strictObject({ upload_id: z.uuid() });
export interface BrandingDTO {
  logo_url: string | null;
  logo_updated_at: string | null;
}

/** A key for the deployment file IT puts on managed computers (Pro, `mdm`). */
export const deploymentKeyCreateRequest = z.strictObject({ name: z.string().trim().min(1).max(100) });
export interface DeploymentKeyDTO {
  id: string;
  name: string;
  hint: string;
  created_by_name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
export interface DeploymentKeyCreated extends DeploymentKeyDTO {
  /** Shown once. */
  key: string;
  /** The server address to put in the deployment file. */
  server_url: string;
}
/** What the deployment file holds: `deployment.json` in the app's system-wide folder. */
export interface DeploymentFile {
  server: string;
  deployment_key: string;
}
/** `POST /v1/devices/enrollment-requests` (public): emails a one-time code to the person, if they can connect. */
export const emailCodeRequest = z.strictObject({
  deployment_key: z.string().min(20).max(200),
  email: z.email().max(320),
});

/** The scheme the desktop app registers; `rdtrack://enroll?server=…&code=…` fills its sign-in form. */
export const AGENT_LINK_SCHEME = 'rdtrack';
export function enrollmentLink(server: string, code: string): string {
  return `${AGENT_LINK_SCHEME}://enroll?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
}

// ───────────── auditor ─────────────

export interface AuditPerson {
  id: string;
  display_name: string;
  status: 'active' | 'deactivated' | 'invited';
}

export const auditQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  action: z.string().max(100).optional(),
  /** Who did it. */
  actor_id: z.uuid().optional(),
  /** Whose data it was about. */
  subject_id: z.uuid().optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
});
export type AuditFilters = z.infer<typeof auditQuery>;

/** At most this many rows go into one audit CSV; narrow the dates for more. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;
