'use client';

import Link from 'next/link';
import { Badge, Card } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import s from './todos.module.css';

/** My day: things only the person can do (submit the week, allow a permission). Renders nothing when there are none. */
export function TodoList() {
  const todos = useApi('me:todos', (signal) => rd.my.todos(signal));
  const items = todos.data?.items ?? [];
  if (!items.length) return null;
  return (
    <Card title="To do" subtitle="Only you can do these. They disappear once done.">
      <ul className={s.list}>
        {items.map((t) => (
          <li key={t.id} className={s.item}>
            <div className={s.text}>
              <span className={s.title}>
                {t.title} {t.overdue ? <Badge tone="warn">Overdue</Badge> : null}
              </span>
              <span className="small secondary">{t.body}</span>
            </div>
            <Link href={t.link} className={s.go}>
              Open →
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
