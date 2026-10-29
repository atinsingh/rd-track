import type { AuditEventDTO, Page } from '@rd/contracts';
import type { Actor } from '../../context';
import { many, type Queryable } from '../../db/pool';

/**
 * Append-only audit trail (AUD-01/02). Metadata must never contain screenshot
 * bytes, tokens, typed content or full URLs — only ids, counts and outcomes.
 */
export interface AuditEntry {
  organizationId: string | null;
  actor: Actor | { kind: 'system' };
  action: string;
  targetType?: string;
  targetId?: string;
  targetUserId?: string;
  result?: 'success' | 'denied' | 'error';
  requestId?: string;
  metadata?: Record<string, unknown>;
}

function actorFields(a: AuditEntry['actor']): [string, string | null] {
  switch (a.kind) {
    case 'user':
      return ['user', a.userId];
    case 'device':
      return ['device', a.deviceId];
    case 'platform':
      return ['platform', a.platformAdminId];
    case 'directory':
      return ['directory', a.tokenId];
    case 'system':
      return ['system', null];
  }
}

export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  const [actorType, actorId] = actorFields(e.actor);
  const metadata = { ...(e.metadata ?? {}) };
  if (e.actor.kind === 'user') metadata.actor_role = e.actor.orgRole;
  await q.query(
    `INSERT INTO audit_logs
       (organization_id, actor_type, actor_id, action, target_type, target_id, target_user_id, result, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.organizationId,
      actorType,
      actorId,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.targetUserId ?? null,
      e.result ?? 'success',
      e.requestId ?? null,
      metadata,
    ],
  );
}

const SELECT = `
  SELECT a.id::text, a.actor_type, a.actor_id, a.action, a.target_type, a.target_id, a.target_user_id,
         a.result, a.request_id, a.metadata, a.created_at,
         CASE a.actor_type WHEN 'user' THEN u.display_name WHEN 'device' THEN d.name
           WHEN 'platform' THEN 'RoundDigital support · ' || pa.display_name
           WHEN 'directory' THEN 'Directory sync' ELSE NULL END AS actor_name
  FROM audit_logs a
  LEFT JOIN users u ON a.actor_type = 'user' AND u.id = a.actor_id
  LEFT JOIN devices d ON a.actor_type = 'device' AND d.id = a.actor_id
  LEFT JOIN platform_admins pa ON a.actor_type = 'platform' AND pa.id = a.actor_id`;

export async function listAudit(
  q: Queryable,
  orgId: string,
  f: { from?: string; to?: string; action?: string; actorId?: string; subjectId?: string; cursor?: string; limit?: number },
  maxLimit = 500,
): Promise<Page<AuditEventDTO>> {
  const limit = Math.min(f.limit ?? 100, maxLimit);
  const rows = await many<AuditEventDTO>(
    q,
    `${SELECT}
     WHERE a.organization_id = $1
       AND ($2::timestamptz IS NULL OR a.created_at >= $2)
       AND ($3::timestamptz IS NULL OR a.created_at < $3)
       AND ($4::text IS NULL OR a.action LIKE $4 || '%')
       AND ($5::uuid IS NULL OR a.actor_id = $5)
       AND ($6::bigint IS NULL OR a.id < $6)
       AND ($8::uuid IS NULL OR a.target_user_id = $8)
     ORDER BY a.id DESC LIMIT $7`,
    [orgId, f.from ?? null, f.to ?? null, f.action ?? null, f.actorId ?? null, f.cursor ?? null, limit + 1, f.subjectId ?? null],
  );
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? items[items.length - 1]!.id : null };
}

/** "Who viewed my data": access by *other* people to this employee's data. */
export async function accessLogFor(q: Queryable, orgId: string, userId: string): Promise<AuditEventDTO[]> {
  return many<AuditEventDTO>(
    q,
    `${SELECT}
     WHERE a.organization_id = $1 AND a.target_user_id = $2
       AND NOT (a.actor_type = 'user' AND a.actor_id = $2)
     ORDER BY a.id DESC LIMIT 200`,
    [orgId, userId],
  );
}
