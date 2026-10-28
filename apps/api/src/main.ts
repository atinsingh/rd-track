import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';
import { MemoryObjectStore, S3ObjectStore } from './storage/object-store';

const config = loadConfig();
if (process.env.MIGRATE_ON_START === 'true') await migrate(config.databaseUrl);

const pool = createPool(config.databaseUrl);
const app = await buildApp(
  {
    pool,
    config,
    store: process.env.STORAGE === 'memory' ? new MemoryObjectStore() : new S3ObjectStore(config.storage),
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
