'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { ChildDTO } from '@rd/contracts';
import { AgeLine, BudgetMeter, ChildForm, ColorDot, LastSeen, NowLines, OS_NAME } from '@/components/family/ChildBits';
import { RulesForm } from '@/components/family/RulesForm';
import s from '@/components/family/family.module.css';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ActionError, Resource } from '@/components/ui/DataState';
import { TextField } from '@/components/ui/Field';
import { Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { cx } from '@/lib/cx';
import { announceFamilyChanged } from '@/lib/events';
import { minutesLabel } from '@/lib/family';
import { useT } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { useAction, useApi } from '@/lib/useApi';

const TABS = ['today', 'rules', 'sees', 'settings'] as const;
type Tab = (typeof TABS)[number];

function Today({ child }: { child: ChildDTO }) {
  const t = useT();
  const { timezone } = useMe();
  const today = useApi(`family:today:${child.id}`, (signal) => rd.family.today(child.id, signal));
  return (
    <Resource {...today} label={t('fam.today.loading', { name: child.display_name })}>
      {(d) => (
        <div className={s.detailGrid}>
          <Card title={t('fam.child.screenTime')}>
            <BudgetMeter today={d} />
            <NowLines today={d} tz={timezone} />
          </Card>
          <Card title={t('fam.child.topApps')}>
            {d.apps.length === 0 ? (
              <p className="small secondary">{t('fam.child.noApps', { name: child.display_name })}</p>
            ) : (
              <ol className={s.appList}>
                {d.apps.map((a) => (
                  <li key={a.name}>
                    <span>{a.name}</span>
                    <span className="mono small">{minutesLabel(a.minutes)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title={t('fam.child.devices')} className={s.wide}>
            {d.devices.length === 0 ? (
              <p className="small secondary">
                {t('fam.child.noDevices', { name: child.display_name })} <a href="/family/connect">{t('fam.nav.connect')}</a>
              </p>
            ) : (
              <TableBox label={t('fam.child.devices')}>
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th>{t('fam.child.device')}</th>
                      <th>{t('fam.child.system')}</th>
                      <th>{t('fam.child.lastSeen')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.devices.map((dev) => (
                      <tr key={dev.id}>
                        <td>
                          {dev.name}
                          {dev.online ? <span className={cx('small', s.online)}> · {t('fam.child.online')}</span> : null}
                        </td>
                        <td>{OS_NAME[dev.os] ?? dev.os}</td>
                        <td>
                          <LastSeen at={dev.last_seen_at} tz={timezone} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            )}
          </Card>
        </div>
      )}
    </Resource>
  );
}

function Rules({ child }: { child: ChildDTO }) {
  const t = useT();
  const family = useApi('family:rules', (signal) => rd.family.rules(signal));
  const mine = useApi(`family:rules:${child.id}`, (signal) => rd.family.childRules(child.id, signal));
  return (
    <>
      <p className={cx('secondary', s.tabIntro)}>{t('fam.child.rulesIntro', { name: child.display_name })}</p>
      <Resource {...family} label={t('fam.rules.loading')}>
        {(f) => (
          <Resource {...mine} label={t('fam.rules.loading')}>
            {(dto) => (
              <RulesForm
                key={dto.revision}
                dto={dto}
                base={f.resolved}
                childName={child.display_name}
                save={(doc) => rd.family.setChildRules(child.id, doc)}
              />
            )}
          </Resource>
        )}
      </Resource>
    </>
  );
}

/** The screen the child's own app shows: the same words, the same rules. */
function Sees({ child }: { child: ChildDTO }) {
  const t = useT();
  const view = useApi(`family:sees:${child.id}`, (signal) => rd.family.transparency(child.id, signal));
  return (
    <Resource {...view} label={t('fam.sees.loading')}>
      {(v) => (
        <div className={s.sees}>
          <p className={cx('secondary', s.tabIntro)}>{t('fam.sees.intro', { name: child.display_name })}</p>
          <Card tone="ink" className={s.seesCard} label={t('fam.sees.title', { name: child.display_name })}>
            <p className={s.seesKicker}>{t('fam.sees.kicker')}</p>
            <h2 className={s.seesTitle}>{v.teen ? t('fam.sees.headTeen') : t('fam.sees.head')}</h2>
            <h3 className={s.seesSub}>{t('fam.sees.canSee')}</h3>
            <ul className={s.seesList}>
              {v.can_see.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <h3 className={s.seesSub}>{t('fam.sees.never')}</h3>
            <ul className={cx(s.seesList, s.seesNever)}>
              {v.never_sees.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p className={s.seesFoot}>{v.rules.allow_requests ? t('fam.sees.canAsk') : t('fam.sees.talk')}</p>
          </Card>
        </div>
      )}
    </Resource>
  );
}

function Settings({ child, reload }: { child: ChildDTO; reload: () => void }) {
  const t = useT();
  const router = useRouter();
  const remove = useAction();
  const [confirm, setConfirm] = useState('');
  return (
    <div className={s.detailGrid}>
      <Card title={t('fam.child.profile')}>
        <ChildForm
          key={`${child.display_name}-${child.birth_year}-${child.birth_month}-${child.region}-${child.color}`}
          initial={{ display_name: child.display_name, birth_year: child.birth_year, birth_month: child.birth_month, region: child.region, color: child.color }}
          submitLabel={t('common.save')}
          busyLabel={t('common.saving')}
          onSubmit={async (input) => {
            await rd.family.updateChild(child.id, input);
            announceFamilyChanged();
            reload();
          }}
        />
      </Card>
      <Card title={t('fam.child.removeTitle', { name: child.display_name })}>
        <p className="small secondary">{t('fam.child.removeBody', { name: child.display_name })}</p>
        <TextField
          label={t('fam.child.removeConfirm', { name: child.display_name })}
          value={confirm}
          autoComplete="off"
          onChange={(e) => setConfirm(e.target.value)}
        />
        <ActionError error={remove.error} />
        <div className={s.formButtons}>
          <Button
            variant="danger"
            disabled={confirm.trim() !== child.display_name || remove.busy}
            onClick={async () => {
              const ok = await remove.run(() => rd.family.removeChild(child.id));
              if (ok) {
                announceFamilyChanged();
                router.push('/family');
              }
            }}
          >
            {remove.busy ? t('fam.child.removing') : t('fam.child.remove', { name: child.display_name })}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function ChildPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get('tab');
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'today';
  const children = useApi('family:children', (signal) => rd.family.children(signal));
  const child = children.data?.find((c) => c.id === id);
  const go = (next: Tab) => router.replace(next === 'today' ? `/family/children/${id}` : `/family/children/${id}?tab=${next}`, { scroll: false });

  if (children.data && !child)
    return (
      <Banner tone="warn" title={t('fam.child.notFound')} actions={<ButtonLink href="/family">{t('fam.nav.today')}</ButtonLink>}>
        {t('fam.child.notFoundBody')}
      </Banner>
    );

  return (
    <Resource {...children} label={t('fam.today.loadingFamily')}>
      {() =>
        child ? (
          <>
            <PageHeader
              eyebrow={t('fam.nav.group')}
              title={
                <span className={s.titleWithDot}>
                  <ColorDot color={child.color} size={16} />
                  {child.display_name}
                </span>
              }
              description={<AgeLine child={child} />}
            />
            <div role="tablist" aria-label={t('fam.child.tabs', { name: child.display_name })} className={s.tabs}>
              {TABS.map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={s.tab} onClick={() => go(k)}>
                  {k === 'sees' ? t('fam.child.tab.sees', { name: child.display_name }) : t(`fam.child.tab.${k}`)}
                </button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === 'today' ? <Today child={child} /> : null}
              {tab === 'rules' ? <Rules child={child} /> : null}
              {tab === 'sees' ? <Sees child={child} /> : null}
              {tab === 'settings' ? <Settings child={child} reload={children.reload} /> : null}
            </div>
          </>
        ) : null
      }
    </Resource>
  );
}
