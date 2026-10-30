/**
 * Prepares an organization for the agent end-to-end run and prints JSON:
 * { code, project_id, user_id, organization_id }. Used by scripts/e2e-agent.sh and
 * scripts/e2e-browser.sh (E2E_DOMAINS=1: the project records website domains).
 */
import { loadConfig } from '../../src/config';
import type { Deps } from '../../src/context';
import { createPool, one } from '../../src/db/pool';
import { migrate } from '../../src/db/migrate';
import { enrollmentCode, normalizeEnrollmentCode, sha256Hex } from '../../src/lib/crypto';
import { createOrganization } from '../../src/modules/platform/routes';
import { MemoryObjectStore } from '../../src/storage/object-store';
import { ConsoleEmailSender } from '../../src/email/sender';

const config = loadConfig();
await migrate(config.databaseUrl, () => undefined);
const pool = createPool(config.databaseUrl);
const deps: Deps = { pool, config, store: new MemoryObjectStore(), email: new ConsoleEmailSender(), now: () => new Date() };

const org = await createOrganization(
  deps,
  pool,
  { name: 'E2E Inc', slug: `e2e-${Date.now()}`, region: 'ca-central-1', admin_email: `admin+${Date.now()}@e2e.test`, admin_name: 'E2E Admin', plan: 'pro', seats: 5 },
  { kind: 'system' },
);
const orgId = org.organization_id;
const user = await one<{ id: string }>(
  pool,
  `INSERT INTO users (organization_id, email, display_name, tracking_enabled) VALUES ($1, $2, 'E2E Employee', true) RETURNING id`,
  [orgId, `emp+${Date.now()}@e2e.test`],
);
const project = await one<{ id: string }>(pool, `INSERT INTO projects (organization_id, name) VALUES ($1, 'E2E Project') RETURNING id`, [orgId]);
const policy = await one<{ id: string }>(
  pool,
  `INSERT INTO policies (organization_id, scope_type, scope_id, current_version) VALUES ($1, 'project', $2, 1) RETURNING id`,
  [orgId, project!.id],
);
await pool.query(`UPDATE organizations SET policy_revision = 1 WHERE id = $1`, [orgId]);
await pool.query(
  `INSERT INTO policy_versions (policy_id, organization_id, version, org_revision, settings, change_note, expands_collection, published_by)
   VALUES ($1, $2, 1, 1, $3, 'e2e: screenshots on', true, $4)`,
  [
    policy!.id,
    orgId,
    {
      screenshots: { enabled: true, interval_minutes: 10, max_width_px: 640 },
      idle: { threshold_seconds: 60 },
      // scripts/e2e-browser.sh: the project records website domains (Pro).
      ...(process.env.E2E_DOMAINS === '1' ? { apps: { capture_domains: true } } : {}),
    },
    org.admin_user_id,
  ],
);
const code = enrollmentCode();
await pool.query(
  `INSERT INTO enrollment_codes (organization_id, user_id, code_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`,
  [orgId, user!.id, sha256Hex(normalizeEnrollmentCode(code)), org.admin_user_id],
);
console.log(JSON.stringify({ code, project_id: project!.id, user_id: user!.id, organization_id: orgId }));
await pool.end();
