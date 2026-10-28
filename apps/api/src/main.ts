import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';
import { createEmailSender } from './email/sender';
import { createObjectStore } from './storage/factory';

const config = loadConfig();
if (process.env.MIGRATE_ON_START === 'true') await migrate(config.databaseUrl);

const pool = createPool(config.databaseUrl);
const app = await buildApp(
  {
    pool,
    config,
    store: createObjectStore(config),
    email: createEmailSender(config),
    now: () => new Date(),
  },
  { logger: true },
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
