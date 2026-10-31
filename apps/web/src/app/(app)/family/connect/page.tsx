'use client';

import Link from 'next/link';
import s from '@/components/family/family.module.css';
import { buttonClass } from '@/components/ui/Button';
import { Resource } from '@/components/ui/DataState';
import { Banner, Card, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useApi } from '@/lib/useApi';

/** How a parent connects a child's computer: install, sign in as the parent, pick the child. */
export default function FamilyConnect() {
  const t = useT();
  const downloads = useApi('agent:downloads', (signal) => rd.my.agentDownloads(signal));
  const children = useApi('family:children', (signal) => rd.family.children(signal));
  const steps = [
    { title: t('fam.connect.s1'), body: t('fam.connect.s1b') },
    { title: t('fam.connect.s2'), body: t('fam.connect.s2b') },
    { title: t('fam.connect.s3'), body: t('fam.connect.s3b') },
    { title: t('fam.connect.s4'), body: t('fam.connect.s4b') },
  ];
  return (
    <>
      <PageHeader eyebrow={t('fam.nav.group')} title={t('fam.connect.title')} description={t('fam.connect.description')} />
      {children.data && children.data.length === 0 ? (
        <Banner title={t('fam.connect.noChildren')} actions={<Link href="/family/children/new">{t('fam.today.addChild')}</Link>}>
          {t('fam.connect.noChildrenBody')}
        </Banner>
      ) : null}
      <div className={s.detailGrid}>
        <Card title={t('fam.connect.how')}>
          <ol className={s.steps}>
            {steps.map((st, i) => (
              <li key={st.title}>
                <span className={s.stepNum} aria-hidden="true">
                  {i + 1}
                </span>
                <span>
                  <strong>{st.title}</strong>
                  <span className="small secondary">{st.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </Card>
        <Card title={t('fam.connect.download')}>
          <Resource {...downloads} label={t('fam.connect.loadingDownloads')}>
            {(d) =>
              d.available && d.files.length ? (
                <ul className={s.downloads}>
                  {d.files.map((f) => (
                    <li key={f.url}>
                      <a className={buttonClass('secondary', 'sm')} href={f.url}>
                        {f.label}
                      </a>
                      <span className="small secondary">{f.kind}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small secondary">{t('fam.connect.noDownloads')}</p>
              )
            }
          </Resource>
          <p className="small secondary">{t('fam.connect.childSees')}</p>
          <p className="small secondary">{t('fam.connect.phones')}</p>
        </Card>
      </div>
    </>
  );
}
