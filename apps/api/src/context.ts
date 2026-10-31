import type { OrgRole } from '@rd/contracts';
import type { Config } from './config';
import type { Pool } from './db/pool';
import type { EmailSender } from './email/sender';
import type { ObjectStore } from './storage/object-store';

/** Everything a module needs; built once in `app.ts` / `worker.ts`. */
export interface Deps {
  pool: Pool;
  config: Config;
  store: ObjectStore;
  email: EmailSender;
  now: () => Date;
  /** Outbound HTTP for webhooks; tests substitute a fake. */
  fetch?: typeof fetch;
  /** DNS TXT lookups for SSO domain verification; tests substitute a fake. */
  resolveTxt?: (name: string) => Promise<string[][]>;
}

export interface UserActor {
  kind: 'user';
  userId: string;
  organizationId: string;
  orgRole: OrgRole;
  displayName: string;
  sessionId: string;
  mfaVerified: boolean;
  /** Set when the call came with an API token (F5): the user is the token's creator. */
  token?: { id: string; name: string; kind: 'organization' | 'personal'; scopes: string[] };
}

export interface DeviceActor {
  kind: 'device';
  deviceId: string;
  userId: string;
  organizationId: string;
}

export interface PlatformActor {
  kind: 'platform';
  platformAdminId: string;
  mfaVerified: boolean;
}

/** The organization's directory (SCIM), acting through one of its tokens. */
export interface DirectoryActor {
  kind: 'directory';
  tokenId: string;
  organizationId: string;
}

/** A client's contact signed in to the read-only client portal (Stage 4 F9). */
export interface ClientActor {
  kind: 'client';
  contactId: string;
  clientId: string;
  organizationId: string;
  displayName: string;
}

export type Actor = UserActor | DeviceActor | PlatformActor | DirectoryActor | ClientActor;

/** Someone changing an organization's people and teams: an admin, or its directory. */
export type OrgActor = UserActor | DirectoryActor;

/** Roles that must use MFA when it is required for admins: they reach pay rates or everyone's data. */
export const PRIVILEGED_ROLES: readonly OrgRole[] = ['org_admin', 'super_admin', 'finance'];

export function isAdmin(a: UserActor): boolean {
  return a.orgRole === 'org_admin' || a.orgRole === 'super_admin';
}
