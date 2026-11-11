import type { ActivityBucketDTO, IntervalDTO } from '@rd/contracts';
import { formatPercent } from './format';
import { t } from './i18n';

/**
 * Builds the "My day" activity timeline (UX §3.1): one column per N minutes
 * (default 5) from minute buckets, pauses and data gaps.
 *
 * Gaps are never idle: paused, asleep/offline and permission-missing time are their
 * own column kinds and are not part of the activity share.
 */

export type ColumnKind = 'activity' | 'paused' | 'offline' | 'permission' | 'none';
export type DataQuality = ActivityBucketDTO['data_quality'];

export interface TimelineColumn {
  /** epoch ms, inclusive */
  start: number;
  /** epoch ms, exclusive */
  end: number;
  kind: ColumnKind;
  activeSeconds: number;
  idleSeconds: number;
  pausedSeconds: number;
  offlineSeconds: number;
  permissionSeconds: number;
  /** active seconds as a share of the column length, 0..1 (bar height) */
  share: number;
  /** worst data quality among buckets in the column; null when there are none */
  quality: DataQuality | null;
}

export interface TimelineInput {
  /** window start/end, epoch ms */
  from: number;
  to: number;
  columnMinutes?: number;
  buckets: readonly ActivityBucketDTO[];
  pauses: readonly IntervalDTO[];
  gaps: readonly IntervalDTO[];
}

const QUALITY_RANK: Record<DataQuality, number> = { ok: 0, partial: 1, permission_missing: 2 };

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

interface ParsedInterval {
  from: number;
  to: number;
  reason: string;
}

function parseIntervals(list: readonly IntervalDTO[]): ParsedInterval[] {
  const out: ParsedInterval[] = [];
  for (const i of list) {
    const from = Date.parse(i.from);
    const to = Date.parse(i.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) out.push({ from, to, reason: i.reason });
  }
  return out;
}

export function buildTimelineColumns(input: TimelineInput): TimelineColumn[] {
  const colMs = (input.columnMinutes ?? 5) * 60_000;
  const colSeconds = colMs / 1000;
  if (!(input.to > input.from) || colMs <= 0) return [];
  const count = Math.ceil((input.to - input.from) / colMs);

  const cols: TimelineColumn[] = Array.from({ length: count }, (_, i) => {
    const start = input.from + i * colMs;
    return {
      start,
      end: Math.min(start + colMs, input.to),
      kind: 'none' as ColumnKind,
      activeSeconds: 0,
      idleSeconds: 0,
      pausedSeconds: 0,
      offlineSeconds: 0,
      permissionSeconds: 0,
      share: 0,
      quality: null,
    };
  });

  for (const b of input.buckets) {
    const t = Date.parse(b.bucket_start);
    if (!Number.isFinite(t) || t < input.from || t >= input.to) continue;
    const col = cols[Math.floor((t - input.from) / colMs)];
    if (!col) continue;
    if (col.quality === null || QUALITY_RANK[b.data_quality] > QUALITY_RANK[col.quality]) col.quality = b.data_quality;
    if (b.data_quality === 'permission_missing') {
      // Not measurable: excluded from the activity denominator (system design §6.3).
      col.permissionSeconds += 60;
    } else {
      col.activeSeconds += Math.max(0, b.active_seconds);
      col.idleSeconds += Math.max(0, b.idle_seconds);
    }
  }

  const pauses = parseIntervals(input.pauses);
  const gaps = parseIntervals(input.gaps);
  for (const col of cols) {
    for (const p of pauses) col.pausedSeconds += overlap(col.start, col.end, p.from, p.to) / 1000;
    for (const g of gaps) {
      const s = overlap(col.start, col.end, g.from, g.to) / 1000;
      if (s === 0) continue;
      if (g.reason === 'permission_missing') col.permissionSeconds += s;
      else col.offlineSeconds += s;
    }
  }

  for (const col of cols) {
    col.permissionSeconds = Math.min(col.permissionSeconds, colSeconds);
    const measured = col.activeSeconds + col.idleSeconds;
    // Dominant category wins; ties prefer measured > paused > offline > permission.
    const ranked: [ColumnKind, number][] = [
      ['activity', measured],
      ['paused', col.pausedSeconds],
      ['offline', col.offlineSeconds],
      ['permission', col.permissionSeconds],
    ];
    let best: [ColumnKind, number] = ['none', 0];
    for (const r of ranked) if (r[1] > best[1]) best = r;
    col.kind = best[0];
    col.share = Math.min(1, Math.max(0, col.activeSeconds / colSeconds));
  }
  return cols;
}

/**
 * Display window for a day: from the earlier of `defaultStartHour` and the first
 * data, to the later of `defaultEndHour` and the last data, in whole hours from
 * the day start. Day-relative hours assume no DST shift inside the window.
 */
export function timelineWindow(
  dayStart: number,
  dayEnd: number,
  dataTimes: readonly number[],
  defaultStartHour = 8,
  defaultEndHour = 18,
): { from: number; to: number } {
  const H = 3_600_000;
  let from = dayStart + defaultStartHour * H;
  let to = Math.min(dayEnd, dayStart + defaultEndHour * H);
  for (const t of dataTimes) {
    if (!Number.isFinite(t)) continue;
    const c = Math.min(Math.max(t, dayStart), dayEnd);
    if (c < from) from = dayStart + Math.floor((c - dayStart) / H) * H;
    if (c > to) to = Math.min(dayEnd, dayStart + Math.ceil((c - dayStart) / H) * H);
  }
  return { from, to };
}

export interface TimelineRun {
  kind: ColumnKind;
  start: number;
  end: number;
  activeSeconds: number;
  idleSeconds: number;
}

/** Consecutive columns of the same kind merged, without leading/trailing "none". */
export function timelineRuns(cols: readonly TimelineColumn[]): TimelineRun[] {
  const runs: TimelineRun[] = [];
  for (const c of cols) {
    const last = runs[runs.length - 1];
    if (last && last.kind === c.kind && last.end === c.start) {
      last.end = c.end;
      last.activeSeconds += c.activeSeconds;
      last.idleSeconds += c.idleSeconds;
    } else {
      runs.push({ kind: c.kind, start: c.start, end: c.end, activeSeconds: c.activeSeconds, idleSeconds: c.idleSeconds });
    }
  }
  while (runs[0]?.kind === 'none') runs.shift();
  while (runs[runs.length - 1]?.kind === 'none') runs.pop();
  return runs;
}

/** How each kind of column reads, in the current language. */
export const kindLabel = (k: ColumnKind): string => t(`timeline.kind.${k}`);

/** Plain-language text alternative for the whole chart. */
export function describeTimeline(runs: readonly TimelineRun[], fmtTime: (ms: number) => string): string {
  if (runs.length === 0) return t('timeline.none');
  const parts = runs.map((r) => {
    const span = t('timeline.span', { from: fmtTime(r.start), to: fmtTime(r.end) });
    if (r.kind === 'activity') {
      const m = r.activeSeconds + r.idleSeconds;
      const pct = m > 0 ? Math.round((r.activeSeconds / m) * 100) : null;
      return pct === null ? t('timeline.inSession', { span }) : t('timeline.inSessionPct', { span, pct: formatPercent(pct) });
    }
    return `${span} ${kindLabel(r.kind).toLowerCase()}`;
  });
  return t('timeline.summary', { parts: parts.join('; ') });
}
