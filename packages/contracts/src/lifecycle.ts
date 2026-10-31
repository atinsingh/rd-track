import { z } from 'zod';

// Data lifecycle (slice 5b/5c, G17–G18): exports, closing an organization, erasure.

/** Closing an organization deletes it this many days later, unless an org admin cancels. */
export const CLOSE_GRACE_DAYS = 30;
/** Encrypted database backups age out within this many days of a deletion. */
export const BACKUP_RETENTION_DAYS = 35;
/** Export files are downloadable for this long. */
export const DATA_EXPORT_HOURS = 24;

export interface DataExportDTO {
  id: string;
  kind: 'organization' | 'person';
  subject_user_id: string | null;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  size_bytes: number | null;
  file_count: number | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
  /** Short-lived link while ready and not expired. */
  download_url: string | null;
}

export interface OrganizationLifecycle {
  name: string;
  deletion_scheduled_at: string | null;
  deletion_requested_at: string | null;
  deletion_requested_by_name: string | null;
}

/** Closing needs the organization's exact name typed in. */
export const closeOrganizationRequest = z.strictObject({ confirm_name: z.string().min(1).max(200) });

export interface DeletionCertificateDTO {
  id: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  requested_by_email: string | null;
  requested_at: string | null;
  deleted_at: string;
  rows_deleted: Record<string, number>;
  objects_deleted: number;
  backups_expire_by: string;
  /** SHA-256 of the certificate's canonical text, so a copy can be checked. */
  digest: string;
}

// ───────────── erasure (5c, G18) ─────────────

export const erasureRequest = z.strictObject({ reason: z.string().trim().max(1000).optional() });
export const erasureDecision = z.strictObject({ reason: z.string().trim().min(3).max(1000) });

export interface ErasureRequestDTO {
  id: string;
  user_id: string;
  user_name: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'declined' | 'completed';
  created_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decline_reason: string | null;
  completed_at: string | null;
  /** Counts of what was deleted, and of what a legal hold kept. */
  result: { deleted: Record<string, number>; kept_for_legal_hold: Record<string, number> } | null;
}
