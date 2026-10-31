import type {
  ClientContactDTO,
  ClientLinkInfo,
  ClientPortalInvoice,
  ClientPortalInvoiceSummary,
  ClientPortalMe,
  ClientPortalReport,
} from '@rd/contracts';
import { request, type Range } from './api';

/**
 * The client portal's API (Stage 4 F9). Its own sign-in and cookie, so a signed-out
 * client never lands on the staff login: the portal layout sends them to /client/login.
 */
const opts = { redirectOnAuth: false } as const;
const get = <T>(path: string, signal?: AbortSignal, query?: Record<string, string>) => request<T>('GET', path, { ...opts, signal, query });
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, { ...opts, body });
const enc = encodeURIComponent;

export const clientPortal = {
  login: (email: string, password: string) => post<{ ok: true }>('/v1/client-portal/auth/login', { email, password }),
  linkInfo: (token: string, signal?: AbortSignal) => get<ClientLinkInfo>('/v1/client-portal/auth/link', signal, { token }),
  acceptLink: (token: string, password: string) => post<{ ok: true }>('/v1/client-portal/auth/link', { token, password }),
  logout: () => post<{ ok: true }>('/v1/client-portal/auth/logout'),
  me: (signal?: AbortSignal) => get<ClientPortalMe>('/v1/client-portal/me', signal),
  report: (r: Range, tz: string, signal?: AbortSignal) => get<ClientPortalReport>('/v1/client-portal/report', signal, { ...r, tz }),
  invoices: async (signal?: AbortSignal) => (await get<{ items: ClientPortalInvoiceSummary[] }>('/v1/client-portal/invoices', signal)).items,
  invoice: (id: string, signal?: AbortSignal) => get<ClientPortalInvoice>(`/v1/client-portal/invoices/${enc(id)}`, signal),
};

/** The agency's side: who at a client can sign in, and what they see. */
export const clientAccess = {
  contacts: async (clientId: string, signal?: AbortSignal) =>
    (await request<{ items: ClientContactDTO[] }>('GET', `/v1/admin/clients/${enc(clientId)}/contacts`, { signal })).items,
  invite: (clientId: string, email: string, displayName: string) =>
    request<ClientContactDTO>('POST', `/v1/admin/clients/${enc(clientId)}/contacts`, { body: { email, display_name: displayName } }),
  sendLink: (contactId: string) => request<{ ok: true }>('POST', `/v1/admin/client-contacts/${enc(contactId)}/send-link`, { body: {} }),
  revoke: (contactId: string) => request<ClientContactDTO>('POST', `/v1/admin/client-contacts/${enc(contactId)}/revoke`, { body: {} }),
  setShowPeople: (clientId: string, showPeople: boolean) =>
    request<{ show_people: boolean }>('PUT', `/v1/admin/clients/${enc(clientId)}/portal`, { body: { show_people: showPeople } }),
};
