import type { OrgRole } from '@rd/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceActor, DirectoryActor, PlatformActor, UserActor } from './context';
import { errors } from './lib/errors';

export type AuthMode = 'user' | 'device' | 'platform' | 'directory' | 'public';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Every route must declare how it authenticates. */
    auth?: AuthMode;
    /** Reachable by a privileged user who has not completed MFA yet. */
    allowWithoutMfa?: boolean;
  }
  interface FastifyRequest {
    user?: UserActor;
    device?: DeviceActor;
    platform?: PlatformActor;
    directory?: DirectoryActor;
    /** The API token's caller (F5), set as soon as the token is recognised, for the audit. */
    apiCaller?: UserActor;
  }
}

export const SESSION_COOKIE = 'rd_session';
export const PLATFORM_COOKIE = 'rd_platform';

export function userOf(req: FastifyRequest): UserActor {
  if (!req.user) throw errors.unauthenticated();
  return req.user;
}

export function deviceOf(req: FastifyRequest): DeviceActor {
  if (!req.device) throw errors.unauthenticated('Device credential required');
  return req.device;
}

export function platformOf(req: FastifyRequest): PlatformActor {
  if (!req.platform) throw errors.unauthenticated();
  return req.platform;
}

export function directoryOf(req: FastifyRequest): DirectoryActor {
  if (!req.directory) throw errors.unauthenticated();
  return req.directory;
}

export function requireRole(req: FastifyRequest, roles: readonly OrgRole[]): UserActor {
  const u = userOf(req);
  if (!roles.includes(u.orgRole)) throw errors.forbidden();
  return u;
}

export const ADMIN_ROLES: readonly OrgRole[] = ['org_admin', 'super_admin'];
export const AUDIT_ROLES: readonly OrgRole[] = ['org_admin', 'super_admin', 'auditor'];
/** Money (rates, budgets, invoices, payroll): admins and the finance role (slice 4, G21). */
export const MONEY_ROLES: readonly OrgRole[] = ['org_admin', 'super_admin', 'finance'];

export function setSessionCookie(reply: FastifyReply, name: string, token: string, secure: boolean, maxAgeSec: number) {
  reply.setCookie(name, token, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: maxAgeSec });
}

export function clearSessionCookie(reply: FastifyReply, name: string) {
  reply.clearCookie(name, { path: '/' });
}
