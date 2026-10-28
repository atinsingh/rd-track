import { describe, expect, it } from 'vitest';
import type { ActivityBucketDTO } from '@rd/contracts';
import { buildTimelineColumns, describeTimeline, timelineRuns, timelineWindow } from './timeline';

const T0 = Date.parse('2026-10-28T08:00:00Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const bucket = (minute: number, active: number, idle: number, q: ActivityBucketDTO['data_quality'] = 'ok'): ActivityBucketDTO => ({
  bucket_start: iso(minute),
  active_seconds: active,
  idle_seconds: idle,
  keyboard_count: 10,
  mouse_count: 10,
  data_quality: q,
});

describe('buildTimelineColumns', () => {
  it('makes one column per 5 minutes and sums minute buckets', () => {
    const cols = buildTimelineColumns({
      from: T0,
      to: T0 + 30 * 60_000,
      buckets: [bucket(0, 60, 0), bucket(1, 30, 30), bucket(2, 0, 60), bucket(7, 60, 0)],
      pauses: [],
      gaps: [],
    });
    expect(cols).toHaveLength(6);
    expect(cols[0]).toMatchObject({ kind: 'activity', activeSeconds: 90, idleSeconds: 90, quality: 'ok' });
    expect(cols[0]!.share).toBeCloseTo(90 / 300);
    expect(cols[1]).toMatchObject({ kind: 'activity', activeSeconds: 60 });
    expect(cols[2]).toMatchObject({ kind: 'none', share: 0, quality: null });
  });

  it('draws pauses and gaps as their own bands, never as idle', () => {
    const cols = buildTimelineColumns({
      from: T0,
      to: T0 + 20 * 60_000,
      buckets: [bucket(0, 60, 0)],
      pauses: [{ from: iso(5), to: iso(10), reason: 'user' }],
      gaps: [
        { from: iso(10), to: iso(15), reason: 'suspended' },
        { from: iso(15), to: iso(20), reason: 'permission_missing' },
      ],
    });
    expect(cols.map((c) => c.kind)).toEqual(['activity', 'paused', 'offline', 'permission']);
    for (const c of cols.slice(1)) {
      expect(c.idleSeconds).toBe(0);
      expect(c.share).toBe(0);
    }
    expect(cols[1]!.pausedSeconds).toBe(300);
  });

  it('excludes permission-missing minutes from measured time', () => {
    const cols = buildTimelineColumns({
      from: T0,
      to: T0 + 5 * 60_000,
      buckets: [bucket(0, 0, 0, 'permission_missing'), bucket(1, 0, 0, 'permission_missing'), bucket(2, 40, 20)],
      pauses: [],
      gaps: [],
    });
    expect(cols[0]).toMatchObject({ kind: 'permission', activeSeconds: 40, idleSeconds: 20, permissionSeconds: 120, quality: 'permission_missing' });
  });

  it('uses the dominant category when a column is mixed', () => {
    const cols = buildTimelineColumns({
      from: T0,
      to: T0 + 5 * 60_000,
      buckets: [bucket(0, 60, 0)],
      pauses: [{ from: iso(1), to: iso(5), reason: 'user' }],
      gaps: [],
    });
    expect(cols[0]!.kind).toBe('paused');
    expect(cols[0]!.share).toBeCloseTo(60 / 300);
  });

  it('ignores buckets outside the window and clips intervals', () => {
    const cols = buildTimelineColumns({
      from: T0,
      to: T0 + 10 * 60_000,
      buckets: [bucket(-1, 60, 0), bucket(10, 60, 0)],
      pauses: [{ from: iso(-60), to: iso(2), reason: 'user' }],
      gaps: [],
    });
    expect(cols[0]!.activeSeconds).toBe(0);
    expect(cols[0]!.pausedSeconds).toBe(120);
    expect(cols[1]!.kind).toBe('none');
  });

  it('returns nothing for an empty window', () => {
    expect(buildTimelineColumns({ from: T0, to: T0, buckets: [], pauses: [], gaps: [] })).toEqual([]);
  });
});

describe('timelineRuns and describeTimeline', () => {
  it('merges same-kind columns and trims empty ends', () => {
    const cols = buildTimelineColumns({
      from: T0,
      to: T0 + 40 * 60_000,
      buckets: [bucket(5, 60, 0), bucket(10, 30, 30)],
      pauses: [{ from: iso(15), to: iso(25), reason: 'user' }],
      gaps: [],
    });
    const runs = timelineRuns(cols);
    expect(runs.map((r) => r.kind)).toEqual(['activity', 'paused']);
    expect(runs[0]).toMatchObject({ start: T0 + 5 * 60_000, end: T0 + 15 * 60_000, activeSeconds: 90, idleSeconds: 30 });
    const text = describeTimeline(runs, (ms) => new Date(ms).toISOString().slice(11, 16));
    expect(text).toBe('Activity timeline: 08:05 to 08:15 in a session, 75% computer activity; 08:15 to 08:25 paused.');
  });

  it('describes an empty day', () => {
    expect(describeTimeline([], () => '')).toBe('No sessions in this period.');
  });
});

describe('timelineWindow', () => {
  const day = Date.parse('2026-10-28T00:00:00Z');
  const H = 3_600_000;
  it('defaults to 08–18', () => {
    expect(timelineWindow(day, day + 24 * H, [])).toEqual({ from: day + 8 * H, to: day + 18 * H });
  });
  it('extends to whole hours around early and late data', () => {
    expect(timelineWindow(day, day + 24 * H, [day + 6.5 * H, day + 20.25 * H])).toEqual({
      from: day + 6 * H,
      to: day + 21 * H,
    });
  });
});
