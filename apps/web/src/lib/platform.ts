import type { DeletionCertificateDTO, PlanId, PlatformMe, PlatformTenantDetail, PlatformTenantDTO, SupportGrantDTO, SupportSection } from '@rd/contracts';
import { request } from './api';

/**
 * The operator console's API (slice 5a). A separate realm with its own cookie, so a
 * failed sign-in never bounces to the tenant login: the console layout handles it.
 */
const opts = { redirectOnAuth: false } as const;
const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, { ...opts, signal });
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, { ...opts, body });
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, { ...opts, body });
const enc = encodeURIComponent;

export interface NewTenant {
  name: string;
  slug: string;
  admin_email: string;
  admin_name: string;
  plan?: PlanId;
  seats?: number;
}

export const platform = {
  login: (email: string, password: string) => post<{ mfa_required: boolean; mfa_enrolled: boolean }>('/platform/v1/auth/login', { email, password }),
  verify: (code: string) => post<{ ok: true }>('/platform/v1/auth/mfa/verify', { code }),
  logout: () => post<{ ok: true }>('/platform/v1/auth/logout'),
  me: (signal?: AbortSignal) => get<PlatformMe>('/platform/v1/me', signal),
  tenants: async (signal?: AbortSignal) => (await get<{ items: PlatformTenantDTO[] }>('/platform/v1/organizations', signal)).items,
  tenant: (id: string, signal?: AbortSignal) => get<PlatformTenantDetail>(`/platform/v1/organizations/${enc(id)}`, signal),
  createTenant: (body: NewTenant) => post<{ organization_id: string; admin_invite_sent: boolean }>('/platform/v1/organizations', body),
  updateSubscription: (id: string, body: { plan?: PlanId; seats?: number; status?: PlatformTenantDTO['status']; price_per_seat_cents?: number | null }) =>
    patch<unknown>(`/platform/v1/organizations/${enc(id)}/subscription`, body),
  grants: async (signal?: AbortSignal) => (await get<{ items: SupportGrantDTO[] }>('/platform/v1/support-grants', signal)).items,
  requestSupport: (id: string, reason: string, hours: number) => post<SupportGrantDTO>(`/platform/v1/organizations/${enc(id)}/support-grants`, { reason, hours }),
  endSupport: (grantId: string) => post<SupportGrantDTO>(`/platform/v1/support-grants/${enc(grantId)}/end`),
  certificates: async (signal?: AbortSignal) => (await get<{ items: DeletionCertificateDTO[] }>('/platform/v1/deletion-certificates', signal)).items,
  supportRead: <T>(id: string, section: SupportSection, signal?: AbortSignal) => get<T>(`/platform/v1/organizations/${enc(id)}/support/${section}`, signal),
};
