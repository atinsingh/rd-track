import { hostname } from 'node:os';
import { loadConfig } from './config';
import type { Deps } from './context';
import { createPool } from './db/pool';
import { claim, complete, fail } from './jobs/queue';
import { handleJob, scheduleRecurring } from './jobs/runner';
import { createObjectStore } from './storage/factory';

const config = loadConfig();
const deps: Deps = {
  pool: createPool(config.databaseUrl),
  config,
  store: createObjectStore(config),
  now: () => new Date(),
};
const workerId = `${hostname()}:${process.pid}`;
let stopping = false;

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), worker: workerId, msg, ...extra }));
}

async function loop() {
  let lastSchedule = 0;
  while (!stopping) {
    if (Date.now() - lastSchedule > 60_000) {
      await scheduleRecurring(deps).catch((e) => log('schedule failed', { error: (e as Error).message }));
      lastSchedule = Date.now();
    }
    const job = await claim(deps.pool, workerId).catch(() => null);
    if (!job) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const started = Date.now();
    try {
      await handleJob(deps, job);
      await complete(deps.pool, job.id);
      log('job done', { id: job.id, kind: job.kind, ms: Date.now() - started });
    } catch (err) {
      // Job payloads are ids only; the message never carries tenant content.
      await fail(deps.pool, job, (err as Error).message);
      log('job failed', { id: job.id, kind: job.kind, attempt: job.attempts, error: (err as Error).message });
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

log('worker started');
loop()
  .then(() => deps.pool.end())
  .then(() => log('worker stopped'));
