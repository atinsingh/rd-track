'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { NotificationDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { rd } from '@/lib/api';
import { cx } from '@/lib/cx';
import { announceNotificationsChanged, onApprovalsChanged, onNotificationsChanged } from '@/lib/events';
import { useT } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { ago, bellLabel, groupNotifications } from '@/lib/notifications';
import { useApi } from '@/lib/useApi';
import s from './bell.module.css';

const POLL_MS = 60_000;

/** The engine's in-app channel: an unread count in the rail and a panel of recent notifications. */
export function NotificationBell() {
  const { timezone: tz } = useMe();
  const t = useT();
  const [open, setOpen] = useState(false);
  // "12 min ago" is measured from when the panel opened.
  const [openedAt, setOpenedAt] = useState(0);
  const count = useApi('notifications:unread', (signal) => rd.my.unreadCount(signal));
  const list = useApi(open ? 'notifications:list' : null, (signal) => rd.my.notifications(signal));
  const { reload: reloadCount } = count;
  const { reload: reloadList } = list;

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') reloadCount();
    };
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
    const offN = onNotificationsChanged(() => {
      reloadCount();
      reloadList();
    });
    // A decision on an approval usually notifies someone; this person may be next.
    const offA = onApprovalsChanged(reloadCount);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      offN();
      offA();
    };
  }, [reloadCount, reloadList]);

  const unread = count.data?.unread ?? 0;
  const { label, badge } = bellLabel(unread);

  const read = async (n: NotificationDTO) => {
    if (n.read_at) return;
    list.mutate((prev) => prev && { ...prev, items: prev.items.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) });
    count.mutate((prev) => prev && { unread: Math.max(0, prev.unread - 1) });
    try {
      await rd.my.markRead(n.id);
    } finally {
      announceNotificationsChanged();
    }
  };
  const readAll = async () => {
    await rd.my.markAllRead();
    announceNotificationsChanged();
  };

  return (
    <>
      <button
        type="button"
        className={s.bell}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => {
          setOpenedAt(Date.now());
          setOpen(true);
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" strokeLinejoin="round" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
        {badge ? (
          <span className={s.badge} aria-hidden="true">
            {badge}
          </span>
        ) : null}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        variant="sheet"
        title={t('notifications.title')}
        description={unread ? t('notifications.unread', { n: unread }) : t('notifications.caughtUp')}
        footer={
          <>
            <Link href="/me/settings" className={s.settings} onClick={() => setOpen(false)}>
              {t('notifications.settings')}
            </Link>
            <Button size="sm" disabled={!unread} onClick={() => void readAll()}>
              {t('notifications.markAll')}
            </Button>
          </>
        }
      >
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {!list.data && !list.error ? <Loading label={t('notifications.loading')} /> : null}
        {list.data && list.data.items.length === 0 ? (
          <p className="secondary">{t('notifications.empty')}</p>
        ) : null}
        {list.data
          ? groupNotifications(list.data.items).map((g) => (
              <section key={g.label} className={s.group} aria-label={g.label}>
                <h3 className={s.groupLabel}>{g.label}</h3>
                <ul className={s.list}>
                  {g.items.map((n) => {
                    const content = (
                      <>
                        <span className={s.title}>{n.title}</span>
                        <span className={s.body}>{n.body}</span>
                        <span className={s.when}>
                          <time dateTime={n.created_at}>{ago(n.created_at, openedAt, tz)}</time>
                          {!n.read_at ? <span className="visually-hidden">{t('notifications.unreadSuffix')}</span> : null}
                        </span>
                      </>
                    );
                    return (
                      <li key={n.id} className={cx(s.item, !n.read_at && s.unread)}>
                        {n.link ? (
                          <Link
                            href={n.link}
                            className={s.itemLink}
                            onClick={() => {
                              void read(n);
                              setOpen(false);
                            }}
                          >
                            {content}
                          </Link>
                        ) : (
                          <button type="button" className={s.itemLink} onClick={() => void read(n)}>
                            {content}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          : null}
      </Dialog>
    </>
  );
}
