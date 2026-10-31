import type { Queryable } from '../../db/pool';
import { toCsv } from '../../lib/csv';

const cell = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

/** Every matching row of a table as CSV with its real column names, minus `drop`. Table names are constants, never input. */
export async function tableCsv(q: Queryable, table: string, where: string, args: unknown[], drop: string[] = []): Promise<{ csv: string; rows: number }> {
  const r = await q.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY 1`, args);
  const cols = r.fields.map((f) => f.name).filter((c) => !drop.includes(c));
  return { csv: toCsv(cols, r.rows.map((row: Record<string, unknown>) => cols.map((c) => cell(row[c])))), rows: r.rowCount ?? 0 };
}
