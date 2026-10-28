import pg from 'pg';

// Return timestamptz as ISO strings and bigint/count as numbers; we never exceed 2^53.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/** Anything that can run a query: the pool or a transaction client. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });
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
