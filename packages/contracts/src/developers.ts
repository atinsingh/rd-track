import { z } from 'zod';

// API tokens (Stage 4 F5, Pro: `api_access`). Tokens see what their creator could see —
// never more — and only on the endpoints listed in the API reference (/v1/docs).

export const API_TOKEN_SCOPES = ['read', 'write', 'payroll'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
export const API_TOKEN_KINDS = ['organization', 'personal'] as const;
export type ApiTokenKind = (typeof API_TOKEN_KINDS)[number];

/** Longest lifetimes: organization tokens a year, personal tokens 90 days. */
export const API_TOKEN_MAX_DAYS: Record<ApiTokenKind, number> = { organization: 365, personal: 90 };
/** The owner is reminded this many days before a token expires. */
export const API_TOKEN_EXPIRY_NOTICE_DAYS = 7;

export const apiTokenRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(API_TOKEN_KINDS),
    /** Organization tokens: `read`, optionally `write` and `payroll`. Personal tokens are always read-only. */
    scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1).max(3).optional(),
    expires_in_days: z.number().int().min(1).max(365),
  })
  .refine((t) => t.expires_in_days <= API_TOKEN_MAX_DAYS[t.kind], { message: 'Personal tokens last at most 90 days', path: ['expires_in_days'] })
  .refine((t) => t.kind === 'personal' || (t.scopes ?? []).includes('read'), { message: 'Organization tokens need the read scope', path: ['scopes'] })
  .refine((t) => t.kind === 'organization' || !t.scopes || (t.scopes.length === 1 && t.scopes[0] === 'read'), {
    message: 'Personal tokens are read-only',
    path: ['scopes'],
  });
export type ApiTokenRequest = z.infer<typeof apiTokenRequest>;

export interface ApiTokenDTO {
  id: string;
  name: string;
  kind: ApiTokenKind;
  scopes: ApiTokenScope[];
  /** Whose access the token carries: its creator. */
  owner_id: string;
  owner_name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  expired: boolean;
}

/** Returned once, at creation. */
export interface ApiTokenCreated extends ApiTokenDTO {
  token: string;
}

/** One endpoint in the API reference. */
export interface ApiEndpointDoc {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  section: string;
  summary: string;
  /** The scope a token needs: `read` for GET, `write` otherwise, plus `payroll` for pay data. */
  scopes: ApiTokenScope[];
  /** Personal tokens may call it (the caller's own data). */
  personal: boolean;
}
