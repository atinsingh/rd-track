import pg from 'pg';
import { currentScope } from './tenant-scope';

// Return timestamptz as ISO strings and bigint/count as numbers; we never exceed 2^53.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/** Anything that can run a query: the pool or a transaction client. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

type ScopedClient = pg.PoolClient & { rdScope?: string };

/**
 * A pg pool that tags every connection with the current tenant scope before use, so
 * row-level security sees the right organization. The setting is cached per connection
 * and only re-sent when the scope changes.
 */
export class Pool implements Queryable {
  private readonly pg: pg.Pool;
  constructor(config: pg.PoolConfig) {
    this.pg = new pg.Pool(config);
  }

  private async scoped(client: ScopedClient): Promise<ScopedClient> {
    const scope = currentScope();
    if (client.rdScope !== scope) {
      try {
        await client.query(`SELECT set_config('rd.org_id', $1, false)`, [scope]);
        client.rdScope = scope;
      } catch (err) {
        client.release(err as Error);
        throw err;
      }
    }
    return client;
  }

  async connect(): Promise<pg.PoolClient> {
    return this.scoped((await this.pg.connect()) as ScopedClient);
  }

  // Same default row type as pg.Pool, so callers can read ad-hoc columns.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    const client = await this.connect();
    try {
      return await client.query<R>(text, values);
    } finally {
      client.release();
    }
  }

  end(): Promise<void> {
    return this.pg.end();
  }
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });
}

/** Run `fn` in a transaction; commits on success, rolls back on throw. */
export async function withTx<T>(pool: Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<R extends pg.QueryResultRow>(q: Queryable, text: string, values?: unknown[]): Promise<R | null> {
  const r = await q.query<R>(text, values);
  return r.rows[0] ?? null;
}

export async function many<R extends pg.QueryResultRow>(q: Queryable, text: string, values?: unknown[]): Promise<R[]> {
  return (await q.query<R>(text, values)).rows;
}
