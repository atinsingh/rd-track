import { z } from 'zod';
import type { BudgetKind, BudgetStatus, InvoiceDTO, InvoiceSummaryDTO } from './money';

// Client portal (Stage 4 F9, Pro): a read-only view for an agency's clients. Contacts sign
// in on their own (not as users of the organization) and see only their own projects'
// hours, budgets and issued invoices — never activity, apps or screenshots.

export const clientContactCreate = z.strictObject({
  email: z.email().max(320),
  display_name: z.string().trim().min(1).max(200),
});
export interface ClientContactDTO {
  id: string;
  client_id: string;
  email: string;
  display_name: string;
  /** invited: hasn't chosen a password yet; revoked: can no longer sign in. */
  status: 'invited' | 'active' | 'revoked';
  invited_at: string | null;
  last_sign_in_at: string | null;
  created_at: string;
}
/** `PUT /v1/admin/clients/{id}/portal` */
export const clientPortalSettingsRequest = z.strictObject({ show_people: z.boolean() });

export const clientLoginRequest = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(1).max(200),
});
export const clientLinkAcceptRequest = z.strictObject({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(200),
});
export interface ClientLinkInfo {
  email: string;
  display_name: string;
  client_name: string;
  organization_name: string;
  /** False when the contact already has a password: accepting the link replaces it. */
  first_time: boolean;
}

export interface ClientPortalMe {
  contact: { id: string; display_name: string; email: string };
  client: { id: string; name: string; currency: string; show_people: boolean };
  organization: { name: string; logo_url: string | null };
}

export interface ClientPortalProject {
  id: string;
  name: string;
  seconds: number;
  daily: { date: string; seconds: number }[];
  /** Who worked on it and for how long, when the agency shows people; null otherwise. */
  people: { name: string; seconds: number }[] | null;
  budget: {
    kind: BudgetKind;
    limit_hours: number | null;
    limit_cents: number | null;
    currency: string | null;
    used_seconds: number;
    used_cents: number | null;
    used_percent: number;
    status: BudgetStatus;
    period: { key: string; from: string | null; to: string | null };
  } | null;
}
export interface ClientPortalReport {
  from: string;
  to: string;
  tz: string;
  total_seconds: number;
  projects: ClientPortalProject[];
}

/** Issued and void invoices only; drafts stay with the agency. */
export type ClientPortalInvoiceSummary = Omit<InvoiceSummaryDTO, 'sent_at' | 'created_at'>;
export type ClientPortalInvoice = Omit<InvoiceDTO, 'sent_at' | 'sent_to' | 'payment_note' | 'unrated_seconds' | 'created_at'>;
