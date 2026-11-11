'use client';

import Link from 'next/link';
import { Badge, Card } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { t } from '@/lib/i18n';
import s from './todos.module.css';

/** My day: things only the person can do (submit the week, allow a permission). Renders nothing when there are none. */
export function TodoList() {
  const todos = useApi('me:todos', (signal) => rd.my.todos(signal));
  const items = todos.data?.items ?? [];
  if (!items.length) return null;
  return (
    <Card title={t('todo.title')} subtitle={t('todo.subtitle')}>
      <ul className={s.list}>
        {items.map((todo) => (
          <li key={todo.id} className={s.item}>
            <div className={s.text}>
              <span className={s.title}>
                {todo.title} {todo.overdue ? <Badge tone="warn">{t('todo.overdue')}</Badge> : null}
              </span>
              <span className="small secondary">{todo.body}</span>
            </div>
            <Link href={todo.link} className={s.go}>
              {t('todo.open')}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
