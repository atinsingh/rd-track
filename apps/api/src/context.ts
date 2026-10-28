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
}

export interface UserActor {
  kind: 'user';
  userId: string;
  organizationId: string;
  orgRole: OrgRole;
  displayName: string;
  sessionId: string;
  mfaVerified: boolean;
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

export type Actor = UserActor | DeviceActor | PlatformActor;

export const PRIVILEGED_ROLES: readonly OrgRole[] = ['org_admin', 'super_admin'];

export function isAdmin(a: UserActor): boolean {
  return a.orgRole === 'org_admin' || a.orgRole === 'super_admin';
}
