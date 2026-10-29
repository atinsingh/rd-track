import { describe, expect, it } from 'vitest';
import type { NotificationDTO } from '@rd/contracts';
import { ago, bellLabel, groupNotifications } from './notifications';

const n = (id: string, created_at: string, read = false): NotificationDTO => ({
  id,
  kind: 'k',
  category: 'approvals',
  title: id,
  body: '',
  link: null,
  created_at,
  read_at: read ? created_at : null,
});

describe('notification helpers', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  it('says how long ago', () => {
    expect(ago('2026-10-29T11:59:30Z', now, 'UTC')).toBe('just now');
    expect(ago('2026-10-29T11:48:00Z', now, 'UTC')).toBe('12 min ago');
    expect(ago('2026-10-29T09:00:00Z', now, 'UTC')).toBe('3 h ago');
    expect(ago('2026-10-28T09:00:00Z', now, 'UTC')).toBe('yesterday');
    expect(ago('2026-10-20T09:00:00Z', now, 'UTC')).toBe('20 Oct');
  });
  it('puts unread first, each group newest first', () => {
    const g = groupNotifications([n('a', '2026-10-29T08:00:00Z', true), n('b', '2026-10-29T09:00:00Z'), n('c', '2026-10-29T10:00:00Z')]);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ['New', ['c', 'b']],
      ['Earlier', ['a']],
    ]);
    expect(groupNotifications([])).toEqual([]);
  });
  it('labels the bell', () => {
    expect(bellLabel(0)).toEqual({ label: 'Notifications', badge: null });
    expect(bellLabel(3)).toEqual({ label: 'Notifications, 3 unread', badge: '3' });
    expect(bellLabel(12).badge).toBe('9+');
  });
});
