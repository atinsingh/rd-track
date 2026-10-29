import {
  PLANS,
  collectionExpansions,
  hasEntitlement,
  partialPolicySettingsSchema,
  resolvePolicy,
  type CollectionChange,
  type DevicePolicyResponse,
  type MyPolicyResponse,
  type PartialPolicySettings,
  type PlanId,
  type PolicyListResponse,
  type PolicyScopeDetail,
  type PolicyScopeDTO,
  type PolicyScopeInput,
  type PolicyVersionDTO,
  type ResolvedPolicy,
  type ScopeType,
  type SignedPolicyPayload,
} from '@rd/contracts';
import type { Deps, DeviceActor, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { signEd25519 } from '../../lib/crypto';
import { errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { currentPlan, currentSubscription } from '../billing/service';
import { notify } from '../engine/notify';

interface ScopeRow {
  scope_type: ScopeType;
  scope_id: string;
  name: string | null;
  settings: PartialPolicySettings;
}

export async function orgRevision(q: Queryable, orgId: string): Promise<number> {
  const r = await one<{ policy_revision: number }>(q, 'SELECT policy_revision FROM organizations WHERE id = $1', [orgId]);
  return r?.policy_revision ?? 0;
}

export function planScope(plan: PlanId): PolicyScopeInput {
  return { scope_type: 'plan', scope_id: plan, name: `${PLANS[plan].name} plan`, settings: PLANS[plan].policyScope };
}

/** Current policy documents for the scopes that apply to a user (+ project, + device). */
export async function loadScopes(
  q: Queryable,
  orgId: string,
  userId: string,
  opts: { projectId?: string | null; deviceId?: string | null } = {},
): Promise<PolicyScopeInput[]> {
  const rows = await many<ScopeRow>(
    q,
    `SELECT p.scope_type, p.scope_id, pv.settings,
            CASE p.scope_type
              WHEN 'organization' THEN (SELECT name FROM organizations WHERE id = p.scope_id)
              WHEN 'team' THEN (SELECT name FROM teams WHERE id = p.scope_id)
              WHEN 'project' THEN (SELECT name FROM projects WHERE id = p.scope_id)
              WHEN 'device' THEN (SELECT name FROM devices WHERE id = p.scope_id)
            END AS name
     FROM policies p
     JOIN policy_versions pv ON pv.policy_id = p.id AND pv.version = p.current_version
     WHERE p.organization_id = $1 AND (
       p.scope_type = 'organization'
       OR (p.scope_type = 'team' AND p.scope_id IN (
             SELECT team_id FROM team_memberships WHERE user_id = $2 AND valid_to IS NULL))
       OR (p.scope_type = 'project' AND p.scope_id = $3)
       OR (p.scope_type = 'device' AND p.scope_id = $4))`,
    [orgId, userId, opts.projectId ?? null, opts.deviceId ?? null],
  );
  return rows.map((r) => ({ scope_type: r.scope_type, scope_id: r.scope_id, name: r.name ?? undefined, settings: r.settings }));
}

export async function resolveFor(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  userId: string,
  opts: { projectId?: string | null; deviceId?: string | null } = {},
): Promise<ResolvedPolicy> {
  const plan = await currentPlan(q, orgId, deps.now());
  const scopes = await loadScopes(q, orgId, userId, opts);
  return resolvePolicy([...scopes, planScope(plan)]);
}

// ───────────── signed delivery to agents (POL-04) ─────────────

export async function signedPolicyForDevice(
  deps: Deps,
  q: Queryable,
  device: DeviceActor,
  projectId: string | null,
): Promise<DevicePolicyResponse> {
  if (projectId) {
    const p = await one(q, 'SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2', [projectId, device.organizationId]);
    if (!p) throw errors.notFound('Project');
  }
  const resolved = await resolveFor(deps, q, device.organizationId, device.userId, { projectId, deviceId: device.deviceId });
  const payload: SignedPolicyPayload = {
    organization_id: device.organizationId,
    user_id: device.userId,
    device_id: device.deviceId,
    project_id: projectId,
    revision: await orgRevision(q, device.organizationId),
    issued_at: deps.now().toISOString(),
    settings: resolved.settings,
  };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const key = deps.config.policySigningKey;
  return {
    payload_b64: bytes.toString('base64'),
    signature_b64: signEd25519(key.privateKey, bytes).toString('base64'),
    key_id: key.keyId,
  };
}

// ───────────── admin listing & detail ─────────────

async function currentVersion(q: Queryable, orgId: string, scopeType: ScopeType, scopeId: string): Promise<PolicyVersionDTO | null> {
  return one<PolicyVersionDTO>(
    q,
    `SELECT pv.version, pv.org_revision, pv.settings, pv.change_note, pv.expands_collection,
            u.display_name AS published_by, pv.published_at
     FROM policies p JOIN policy_versions pv ON pv.policy_id = p.id AND pv.version = p.current_version
     JOIN users u ON u.id = pv.published_by
     WHERE p.organization_id = $1 AND p.scope_type = $2 AND p.scope_id = $3`,
    [orgId, scopeType, scopeId],
  );
}

async function scopeName(q: Queryable, orgId: string, scopeType: ScopeType, scopeId: string): Promise<string> {
  const table = { organization: 'organizations', team: 'teams', project: 'projects', device: 'devices' }[scopeType];
  const orgCol = scopeType === 'organization' ? 'id' : 'organization_id';
  const r = await one<{ name: string }>(q, `SELECT name FROM ${table} WHERE id = $1 AND ${orgCol} = $2`, [scopeId, orgId]);
  if (!r) throw errors.notFound('Policy scope');
  return r.name;
}

export async function listPolicies(q: Queryable, orgId: string): Promise<PolicyListResponse> {
  const rows = await many<{ scope_type: ScopeType; scope_id: string; scope_name: string }>(
    q,
    `SELECT 'organization' AS scope_type, id AS scope_id, name AS scope_name, 0 AS ord FROM organizations WHERE id = $1
     UNION ALL SELECT 'team', id, name, 1 FROM teams WHERE organization_id = $1
     UNION ALL SELECT 'project', id, name, 2 FROM projects WHERE organization_id = $1 AND status = 'active'
     UNION ALL SELECT 'device', d.id, d.name || ' (' || u.display_name || ')', 3
       FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.organization_id = $1 AND EXISTS (
         SELECT 1 FROM policies p WHERE p.scope_type = 'device' AND p.scope_id = d.id)
     ORDER BY ord, scope_name`,
    [orgId],
  );
  const scopes: PolicyScopeDTO[] = [];
  for (const r of rows) {
    scopes.push({ ...r, current: await currentVersion(q, orgId, r.scope_type, r.scope_id) });
  }
  return { org_revision: await orgRevision(q, orgId), scopes };
}

/** Users the scope's policy applies to (current members; project members for project scopes). */
async function affectedUsers(q: Queryable, orgId: string, scopeType: ScopeType, scopeId: string): Promise<string[]> {
  const sql = {
    organization: `SELECT id FROM users WHERE organization_id = $1 AND status = 'active' AND $2::uuid IS NOT NULL`,
    team: `SELECT m.user_id AS id FROM team_memberships m JOIN users u ON u.id = m.user_id
           WHERE m.organization_id = $1 AND m.team_id = $2 AND m.valid_to IS NULL AND u.status = 'active'`,
    project: `SELECT DISTINCT id FROM (
                SELECT m.user_id AS id FROM project_memberships m WHERE m.organization_id = $1 AND m.project_id = $2 AND m.valid_to IS NULL
                UNION SELECT s.user_id FROM work_sessions s WHERE s.organization_id = $1 AND s.project_id = $2
                  AND s.started_at > now() - interval '30 days') x
              WHERE id IN (SELECT id FROM users WHERE status = 'active')`,
    device: `SELECT user_id AS id FROM devices WHERE organization_id = $1 AND id = $2`,
  }[scopeType];
  return (await many<{ id: string }>(q, sql, [orgId, scopeId])).map((r) => r.id);
}

function scopeContext(scopeType: ScopeType, scopeId: string) {
  return {
    projectId: scopeType === 'project' ? scopeId : null,
    deviceId: scopeType === 'device' ? scopeId : null,
  };
}

/** Fields the plan forces to a value, so the editor can show "Not in your plan". */
function planLockedFields(plan: PlanId): string[] {
  const out: string[] = [];
  const s = PLANS[plan].policyScope;
  if (s.screenshots?.enabled === false) out.push('screenshots.enabled');
  if (s.apps?.capture_domains === false) out.push('apps.capture_domains');
  if (s.apps?.capture_window_titles === false) out.push('apps.capture_window_titles');
  return out;
}

export async function scopeDetail(
  deps: Pick<Deps, 'now'>,
  q: Queryable,
  orgId: string,
  scopeType: ScopeType,
  scopeId: string,
): Promise<PolicyScopeDetail> {
  const name = await scopeName(q, orgId, scopeType, scopeId);
  const plan = await currentPlan(q, orgId, deps.now());
  const history = await many<PolicyVersionDTO>(
    q,
    `SELECT pv.version, pv.org_revision, pv.settings, pv.change_note, pv.expands_collection,
            u.display_name AS published_by, pv.published_at
     FROM policies p JOIN policy_versions pv ON pv.policy_id = p.id JOIN users u ON u.id = pv.published_by
     WHERE p.organization_id = $1 AND p.scope_type = $2 AND p.scope_id = $3
     ORDER BY pv.version DESC LIMIT 50`,
    [orgId, scopeType, scopeId],
  );
  // Effective for this scope in context: organization + this scope + plan.
  const docs = await many<{ scope_type: ScopeType; scope_id: string; settings: PartialPolicySettings }>(
    q,
    `SELECT p.scope_type, p.scope_id, pv.settings FROM policies p
     JOIN policy_versions pv ON pv.policy_id = p.id AND pv.version = p.current_version
     WHERE p.organization_id = $1 AND (p.scope_type = 'organization' OR (p.scope_type = $2 AND p.scope_id = $3))`,
    [orgId, scopeType, scopeId],
  );
  const orgName = await scopeName(q, orgId, 'organization', orgId);
  const scopes: PolicyScopeInput[] = docs.map((d) => ({
    ...d,
    name: d.scope_type === 'organization' ? orgName : name,
  }));
  const effective = resolvePolicy([...scopes, planScope(plan)]);
  return {
    scope: { scope_type: scopeType, scope_id: scopeId, scope_name: name, current: history[0] ?? null },
    history,
    effective,
    plan_locked_fields: planLockedFields(plan),
    affected_users: (await affectedUsers(q, orgId, scopeType, scopeId)).length,
  };
}

// ───────────── publishing (POL-03, POL-05) ─────────────

export async function publishPolicy(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  scopeType: ScopeType,
  scopeId: string,
  input: { settings: PartialPolicySettings; change_note: string; confirm_expansion: boolean },
  requestId?: string,
): Promise<PolicyScopeDetail> {
  const orgId = actor.organizationId;
  const settings = partialPolicySettingsSchema.parse(input.settings);
  await scopeName(q, orgId, scopeType, scopeId); // 404 for other tenants' scopes
  if (scopeType === 'organization' && scopeId !== orgId) throw errors.notFound('Policy scope');

  const sub = await currentSubscription(q, orgId, deps.now());
  const plan = sub.status === 'trialing' ? 'pro' : sub.plan;
  if (scopeType !== 'organization' && !hasEntitlement(plan, 'scoped_policies')) {
    throw errors.paymentRequired('Team, project and device policies are part of the Pro plan.');
  }
  if (settings.screenshots?.enabled === true && !hasEntitlement(plan, 'screenshots')) {
    throw errors.paymentRequired('Screenshots are part of the Pro plan.');
  }
  if (settings.apps?.capture_domains === true && !hasEntitlement(plan, 'domains')) {
    throw errors.paymentRequired('Website domains are part of the Pro plan.');
  }

  // Lock the organization row: publishes are serialized and revisions are gap-free.
  await q.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);

  const users = await affectedUsers(q, orgId, scopeType, scopeId);
  const ctx = scopeContext(scopeType, scopeId);
  const changes = new Map<string, CollectionChange>();
  const expandedFor: string[] = [];
  for (const userId of users) {
    const before = await loadScopes(q, orgId, userId, ctx);
    const after = [
      ...before.filter((s) => !(s.scope_type === scopeType && s.scope_id === scopeId)),
      { scope_type: scopeType, scope_id: scopeId, settings },
    ];
    const pScope = planScope(plan);
    const diff = collectionExpansions(resolvePolicy([...before, pScope]).settings, resolvePolicy([...after, pScope]).settings);
    if (diff.length > 0) {
      expandedFor.push(userId);
      for (const c of diff) changes.set(c.field, c);
    }
  }
  if (expandedFor.length > 0 && !input.confirm_expansion) {
    throw errors.conflict('expansion_requires_confirmation', 'This change collects more data about employees.', {
      affected_users: expandedFor.length,
      changes: [...changes.values()],
    });
  }

  const policy = await one<{ id: string; current_version: number }>(
    q,
    `INSERT INTO policies (organization_id, scope_type, scope_id) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, scope_type, scope_id) DO UPDATE SET scope_id = EXCLUDED.scope_id
     RETURNING id, current_version`,
    [orgId, scopeType, scopeId],
  );
  const version = policy!.current_version + 1;
  const rev = await one<{ policy_revision: number }>(
    q,
    'UPDATE organizations SET policy_revision = policy_revision + 1 WHERE id = $1 RETURNING policy_revision',
    [orgId],
  );
  await q.query(
    `INSERT INTO policy_versions (policy_id, organization_id, version, org_revision, settings, change_note, expands_collection, published_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [policy!.id, orgId, version, rev!.policy_revision, settings, input.change_note, expandedFor.length > 0, actor.userId],
  );
  await q.query('UPDATE policies SET current_version = $2 WHERE id = $1', [policy!.id, version]);

  await notify(q, orgId, expandedFor, {
    kind: 'policy_expansion',
    category: 'privacy',
    title: 'What is collected about you has changed',
    body: `${actor.displayName} published a policy change: ${input.change_note}. See "What's collected" for details.`,
    link: '/me/privacy',
  });
  await audit(q, {
    organizationId: orgId,
    actor,
    action: 'policy.publish',
    targetType: `policy:${scopeType}`,
    targetId: scopeId,
    requestId,
    metadata: {
      version,
      org_revision: rev!.policy_revision,
      expands_collection: expandedFor.length > 0,
      notified_users: expandedFor.length,
      changed_fields: [...changes.keys()],
    },
  });
  return scopeDetail(deps, q, orgId, scopeType, scopeId);
}

// ───────────── employee view (UX §3.3) ─────────────

export async function myPolicy(deps: Deps, q: Queryable, actor: UserActor): Promise<MyPolicyResponse> {
  const orgId = actor.organizationId;
  const base = await resolveFor(deps, q, orgId, actor.userId);
  const projects = await many<{ id: string; name: string }>(
    q,
    `SELECT DISTINCT p.id, p.name FROM projects p
     WHERE p.organization_id = $1 AND p.status = 'active' AND (
       p.id IN (SELECT project_id FROM project_memberships WHERE user_id = $2 AND valid_to IS NULL)
       OR p.id IN (SELECT project_id FROM work_sessions WHERE user_id = $2 AND started_at > now() - interval '30 days'))
     ORDER BY p.name`,
    [orgId, actor.userId],
  );
  const perProject: MyPolicyResponse['projects'] = [];
  for (const p of projects) {
    const r = await resolveFor(deps, q, orgId, actor.userId, { projectId: p.id });
    if (JSON.stringify(r.settings) !== JSON.stringify(base.settings)) {
      perProject.push({ project_id: p.id, project_name: p.name, settings: r.settings });
    }
  }
  const last = await one<{ published_at: string; published_by: string }>(
    q,
    `SELECT pv.published_at, u.display_name AS published_by FROM policy_versions pv JOIN users u ON u.id = pv.published_by
     WHERE pv.organization_id = $1 ORDER BY pv.org_revision DESC LIMIT 1`,
    [orgId],
  );
  const anyScreens = base.settings.screenshots.enabled || perProject.some((p) => p.settings.screenshots.enabled);
  const managers = await many<{ user_id: string; display_name: string }>(
    q,
    `SELECT DISTINCT u.id AS user_id, u.display_name FROM team_memberships me
     JOIN team_memberships mm ON mm.team_id = me.team_id AND mm.role = 'manager' AND mm.valid_to IS NULL
     JOIN users u ON u.id = mm.user_id
     WHERE me.user_id = $1 AND me.valid_to IS NULL AND mm.user_id <> $1`,
    [actor.userId],
  );
  const pms = await many<{ user_id: string; display_name: string; project_name: string }>(
    q,
    `SELECT DISTINCT u.id AS user_id, u.display_name, p.name AS project_name FROM project_memberships me
     JOIN project_memberships mm ON mm.project_id = me.project_id AND mm.role = 'manager' AND mm.valid_to IS NULL
     JOIN users u ON u.id = mm.user_id JOIN projects p ON p.id = me.project_id
     WHERE me.user_id = $1 AND me.valid_to IS NULL AND mm.user_id <> $1`,
    [actor.userId],
  );
  const v = base.settings.viewers;
  const managerSees = ['time'];
  if (v.manager_can_view_activity) managerSees.push('computer activity');
  if (v.manager_can_view_apps) managerSees.push('app names');
  if (anyScreens && (v.manager_can_view_screenshots || perProject.some((p) => p.settings.viewers.manager_can_view_screenshots))) {
    managerSees.push('screenshots where policy allows');
  }
  return {
    org_revision: await orgRevision(q, orgId),
    published_at: last?.published_at ?? null,
    published_by: last?.published_by ?? null,
    base,
    projects: perProject,
    viewers: [
      ...managers.map((m) => ({ ...m, relation: 'team_manager' as const, sees: managerSees })),
      ...pms.map((m) => ({
        user_id: m.user_id,
        display_name: m.display_name,
        relation: 'project_manager' as const,
        sees: [`time on ${m.project_name}`],
      })),
    ],
  };
}
