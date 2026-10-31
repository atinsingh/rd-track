'use client';

import Link from 'next/link';
import type { ChildDTO } from '@rd/contracts';
import { AgeLine, BudgetMeter, ColorDot, NowLines } from '@/components/family/ChildBits';
import s from '@/components/family/family.module.css';
import { ButtonLink } from '@/components/ui/Button';
import { Resource } from '@/components/ui/DataState';
import { Card, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { formatDayLabel, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';

/** One child today: screen time against the day's budget, what's in force now, devices. */
function ChildCard({ child }: { child: ChildDTO }) {
  const t = useT();
  const { timezone } = useMe();
  const today = useApi(`family:today:${child.id}`, (signal) => rd.family.today(child.id, signal));
  return (
    <Card className={s.childCard} label={child.display_name}>
      <div className={s.childHead}>
        <ColorDot color={child.color} size={14} />
        <h2 className={s.childName}>
          <Link href={`/family/children/${child.id}`}>{child.display_name}</Link>
        </h2>
        <AgeLine child={child} />
      </div>
      <Resource {...today} label={t('fam.today.loading', { name: child.display_name })}>
        {(d) => (
          <>
            <BudgetMeter today={d} />
            <NowLines today={d} tz={timezone} />
          </>
        )}
      </Resource>
      <div className={s.cardLinks}>
        <Link href={`/family/children/${child.id}`} className="small">
          {t('fam.today.open', { name: child.display_name })}
        </Link>
      </div>
    </Card>
  );
}

/** The family's day: one card per child. */
export default function FamilyToday() {
  const t = useT();
  const { me, timezone } = useMe();
  const children = useApi('family:children', (signal) => rd.family.children(signal));
  return (
    <>
      <PageHeader
        eyebrow={t('fam.today.eyebrow', { date: formatDayLabel(todayInTz(timezone)) })}
        title={me.organization.name}
        description={t('fam.today.description')}
        actions={
          children.data && children.data.length > 0 ? (
            <ButtonLink href="/family/children/new" variant="primary">
              {t('fam.today.addChild')}
            </ButtonLink>
          ) : null
        }
      />
      <Resource {...children} label={t('fam.today.loadingFamily')}>
        {(list) =>
          list.length === 0 ? (
            <Card className={s.empty}>
              <h2>{t('fam.today.emptyTitle')}</h2>
              <p className="secondary">{t('fam.today.emptyBody')}</p>
              <div className={s.formButtons}>
                <ButtonLink href="/family/children/new" variant="primary">
                  {t('fam.today.addChild')}
                </ButtonLink>
                <Link href="/family/rules" className="small">
                  {t('fam.today.seeRules')}
                </Link>
              </div>
            </Card>
          ) : (
            <div className={s.childGrid}>
              {list.map((c) => (
                <ChildCard key={c.id} child={c} />
              ))}
            </div>
          )
        }
      </Resource>
      <p className={s.promise}>{t('fam.today.promise')}</p>
    </>
  );
}
