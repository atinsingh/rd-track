import type { Deps } from '../context';
import { remindExpiringTokens } from '../modules/api-tokens/service';
import { withTx } from '../db/pool';
import { SYSTEM_SCOPE, withScope } from '../db/tenant-scope';
import { certificateEmail } from '../email/templates';
import { runBillingLifecycle, snapshotSeats } from '../modules/billing/service';
import { publish } from '../modules/engine/events';
import { sendNotificationEmail } from '../modules/engine/notify';
import { runDeviceHealth, runTimesheetRules } from '../modules/engine/work';
import { generateExport } from '../modules/exports/service';
import { processIngestJob } from '../modules/ingestion/processor';
import { erasePerson } from '../modules/lifecycle/person';
import { certificateText, dueForDeletion, generateDataExport, purgeOrganization } from '../modules/lifecycle/service';
import { checkAllBudgets } from '../modules/money/budgets';
import { generatePayrollExport } from '../modules/money/payroll';
import { runRetention } from '../modules/retention/service';
import { runAccruals } from '../modules/scheduling/time-off';
import { deleteScreenshot, verifyScreenshot } from '../modules/screenshots/service';
import { deliver, markFailed } from '../modules/webhooks/service';
import { claim, complete, enqueue, fail, requeueStale, type Job } from './queue';

/** Tenant jobs run scoped to their organization; cross-tenant jobs (retention) run as system. */
export function handleJob(deps: Deps, job: Job): Promise<void> {
  return withScope(job.organization_id ?? SYSTEM_SCOPE, () => runJob(deps, job));
}

async function runJob(deps: Deps, job: Job): Promise<void> {
  const p = job.payload as Record<string, string>;
  switch (job.kind) {
    case 'ingest.process':
      await processIngestJob(deps, job.payload as { device_id: string; event_ids: string[]; offset_ms: number });
      return;
    case 'screenshot.verify':
      await withTx(deps.pool, (tx) => verifyScreenshot(deps, tx, p.screenshot_id!));
      return;
    case 'screenshot.delete':
      await withTx(deps.pool, async (tx) => {
        await deleteScreenshot(deps, tx, p.screenshot_id!, 'employee_request');
        if (p.request_id) {
          const done = await tx.query<{ organization_id: string; requester_id: string }>(
            `UPDATE deletion_requests SET status = 'completed', completed_at = now() WHERE id = $1 AND status <> 'completed'
             RETURNING organization_id, requester_id`,
            [p.request_id],
          );
          const r = done.rows[0];
          if (r) await publish(tx, { organizationId: r.organization_id, type: 'deletion_request.completed', subjectUserId: r.requester_id, data: { request_id: p.request_id } });
        }
      });
      return;
    case 'export.generate':
      await withTx(deps.pool, (tx) => generateExport(deps, tx, p.export_id!));
      return;
    case 'payroll.generate':
      await withTx(deps.pool, (tx) => generatePayrollExport(deps, tx, p.payroll_export_id!));
      return;
    case 'budgets.check':
      await checkAllBudgets(deps);
      return;
    case 'retention.run':
      await runRetention(deps);
      return;
    case 'webhook.deliver':
      try {
        await deliver(deps, deps.pool, p.delivery_id!, deps.fetch);
      } catch (err) {
        // The queue retries with backoff; on the last attempt record the failure for admins.
        if (job.attempts >= job.max_attempts) await markFailed(deps.pool, p.delivery_id!);
        throw err;
      }
      return;
    case 'seats.snapshot':
      await snapshotSeats(deps.pool, deps.now());
      return;
    case 'time_off.accrue':
      await runAccruals(deps);
      return;
    case 'notification.email':
      await withTx(deps.pool, (tx) => sendNotificationEmail(deps, tx, p.notification_id!));
      return;
    case 'billing.lifecycle':
      await runBillingLifecycle(deps);
      return;
    case 'data_export.generate':
      await withTx(deps.pool, (tx) => generateDataExport(deps, tx, p.data_export_id!));
      return;
    case 'person.erase': {
      // The confirmation goes to the address captured before it was replaced, after commit.
      const mail = await withTx(deps.pool, (tx) => erasePerson(deps, tx, p.erasure_request_id!));
      if (mail) await deps.email.send(mail);
      return;
    }
    case 'organizations.purge':
      await purgeDue(deps);
      return;
    case 'rules.run':
      await runTimesheetRules(deps);
      await runDeviceHealth(deps);
      await remindExpiringTokens(deps);
      return;
    default:
      throw new Error(`Unknown job kind ${job.kind}`);
  }
}

/**
 * Deletes organizations whose closing date has come (slice 5b), each in its own
 * transaction, then emails the certificate to the admins captured before deletion.
 */
export async function purgeDue(deps: Deps): Promise<number> {
  const due = await withScope(SYSTEM_SCOPE, () => dueForDeletion(deps, deps.pool));
  for (const orgId of due) {
    const { certificate, recipients } = await withScope(SYSTEM_SCOPE, () => withTx(deps.pool, (tx) => purgeOrganization(deps, tx, orgId)));
    for (const to of recipients) await deps.email.send(certificateEmail(to, certificate, certificateText(certificate)));
  }
  return due.length;
}

/** Runs every ready job until the queue is empty. Returns how many ran (tests use this). */
export async function drainJobs(deps: Deps, workerId = 'drain'): Promise<number> {
  let n = 0;
  for (;;) {
    const job = await claim(deps.pool, workerId);
    if (!job) return n;
    try {
      await handleJob(deps, job);
      await complete(deps.pool, job.id);
    } catch (err) {
      await fail(deps.pool, job, (err as Error).message);
    }
    n++;
  }
}

/** Keeps exactly one future occurrence of each periodic job queued. */
export async function scheduleRecurring(deps: Deps): Promise<void> {
  const schedule: [Job['kind'], number][] = [
    ['retention.run', 3600_000],
    ['seats.snapshot', 3600_000],
    // Idempotent per period, so running it often only makes the monthly accrual timely.
    ['time_off.accrue', 6 * 3600_000],
    ['budgets.check', 600_000],
    ['billing.lifecycle', 3600_000],
    ['rules.run', 3600_000],
    ['organizations.purge', 3600_000],
  ];
  for (const [kind, everyMs] of schedule) {
    const r = await deps.pool.query(`SELECT 1 FROM jobs WHERE kind = $1 AND status IN ('queued', 'running') LIMIT 1`, [kind]);
    if (r.rowCount === 0) await enqueue(deps.pool, kind, {}, { runAt: new Date(deps.now().getTime() + everyMs) });
  }
  await requeueStale(deps.pool);
}
