import type { z } from 'zod';
import { errors } from './errors';

/** Parse input with a Zod schema; failures become 400 validation_failed with field paths only (no values). */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw errors.validation(
      'Request validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

/** Inclusive-exclusive time range with a sane upper bound on its length. */
export function parseRange(q: { from?: unknown; to?: unknown }, maxDays = 93): { from: string; to: string } {
  const from = typeof q.from === 'string' ? new Date(q.from) : null;
  const to = typeof q.to === 'string' ? new Date(q.to) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw errors.validation('from and to must be RFC 3339 timestamps with from < to');
  }
  if (to.getTime() - from.getTime() > maxDays * 86_400_000) {
    throw errors.validation(`Range may not exceed ${maxDays} days`);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}
