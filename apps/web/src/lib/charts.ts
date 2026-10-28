import type { DailyProjectRow } from '@rd/contracts';

/**
 * Stacked daily hours by project. Data colours are three lightness steps
 * (UX §5); projects beyond the top three are grouped as "Other projects" and drawn
 * hatched, so no series relies on hue.
 */

export type SeriesFill = 'data-1' | 'data-2' | 'data-3' | 'other';

export interface Series {
  id: string;
  name: string;
  fill: SeriesFill;
  seconds: number;
}

export interface StackedDay {
  date: string;
  total: number;
  segments: { seriesId: string; seconds: number }[];
}

export interface StackedChart {
  series: Series[];
  days: StackedDay[];
  max: number;
}

const FILLS: SeriesFill[] = ['data-1', 'data-2', 'data-3'];
const OTHER = '__other__';

export function stackDaily(daily: readonly DailyProjectRow[], maxSeries = 3): StackedChart {
  const totals = new Map<string, { name: string; seconds: number }>();
  const idOf = (p: { project_id: string | null }) => p.project_id ?? '__none__';
  for (const d of daily)
    for (const p of d.projects) {
      const id = idOf(p);
      const t = totals.get(id) ?? { name: p.project_name || 'No project', seconds: 0 };
      t.seconds += p.seconds;
      totals.set(id, t);
    }
  const ranked = [...totals.entries()].sort((a, b) => b[1].seconds - a[1].seconds || a[1].name.localeCompare(b[1].name));
  const needOther = ranked.length > maxSeries;
  const keep = needOther ? ranked.slice(0, maxSeries - 1) : ranked;
  const kept = new Set(keep.map(([id]) => id));

  const series: Series[] = keep.map(([id, t], i) => ({ id, name: t.name, fill: FILLS[i] ?? 'data-3', seconds: t.seconds }));
  if (needOther) {
    const otherSeconds = ranked.filter(([id]) => !kept.has(id)).reduce((s, [, t]) => s + t.seconds, 0);
    series.push({ id: OTHER, name: 'Other projects', fill: 'other', seconds: otherSeconds });
  }

  const days: StackedDay[] = daily.map((d) => {
    const bySeries = new Map<string, number>();
    for (const p of d.projects) {
      const id = kept.has(idOf(p)) ? idOf(p) : OTHER;
      bySeries.set(id, (bySeries.get(id) ?? 0) + p.seconds);
    }
    const segments = series
      .map((s) => ({ seriesId: s.id, seconds: bySeries.get(s.id) ?? 0 }))
      .filter((s) => s.seconds > 0);
    return { date: d.date, total: segments.reduce((s, x) => s + x.seconds, 0), segments };
  });
  return { series, days, max: days.reduce((m, d) => Math.max(m, d.total), 0) };
}
