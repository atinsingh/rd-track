'use client';

import { useState } from 'react';
import { APP_CATEGORIES, APP_PRESETS, type AppCategory, type AppCategoryDTO, type AppPresetId, type TeamSummary } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Checkbox, SelectField, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { t, tPlural } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from '../admin.module.css';

/** A category's name in the reader's language. */
const categoryLabel = (c: AppCategory) => t(`ins.cat.${c}`);

/** A ready-made set of rules (Stage 4 F9): pick the category, leave out what you don't want. */
function Preset({ id, teams, rules, onApplied }: { id: AppPresetId; teams: TeamSummary[]; rules: AppCategoryDTO[]; onApplied: () => void }) {
  const preset = APP_PRESETS[id];
  const all = preset.apps.flatMap((a) => [...a.identifiers]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(all));
  const [category, setCategory] = useState<AppCategory>('core_work');
  const [teamId, setTeamId] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();
  const existing = (identifier: string) =>
    rules.find((r) => r.app_identifier.toLowerCase() === identifier.toLowerCase() && (r.team_id ?? '') === teamId);
  const toggle = (identifier: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(identifier)) next.delete(identifier);
      else next.add(identifier);
      return next;
    });
  const apply = async () => {
    setDone(null);
    const identifiers = all.filter((i) => chosen.has(i));
    const r = await action.run(() =>
      rd.admin.applyAppPreset({ preset: id, category, team_id: teamId || null, identifiers: identifiers.length === all.length ? undefined : identifiers }),
    );
    if (r) {
      setDone(tPlural(r.applied, 'adm.apps.saved.one', 'adm.apps.saved.other', { category: categoryLabel(category) }));
      onApplied();
    }
  };
  return (
    <Card title={t('adm.apps.preset', { name: t(`adm.apps.preset.${id}`) })} subtitle={t(`adm.apps.preset.${id}.desc`)}>
      <div className={s.presetApps}>
        {preset.apps.map((a) => (
          <fieldset key={a.name} className={s.presetApp}>
            <legend>{a.name}</legend>
            {a.identifiers.map((i) => {
              const rule = existing(i);
              return (
                <Checkbox
                  key={i}
                  label={<span className="mono small">{i}</span>}
                  hint={rule ? t('adm.apps.now', { category: categoryLabel(rule.category) }) : undefined}
                  checked={chosen.has(i)}
                  onChange={() => toggle(i)}
                />
              );
            })}
          </fieldset>
        ))}
      </div>
      <div className={s.inlineForm}>
        <SelectField label={t('adm.apps.category')} value={category} onChange={(e) => setCategory(e.target.value as AppCategory)}>
          {APP_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('adm.apps.appliesTo')} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">{t('adm.apps.wholeOrg')}</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {t('adm.apps.team', { name: team.name })}
            </option>
          ))}
        </SelectField>
        <Button variant="primary" onClick={apply} disabled={chosen.size === 0 || action.busy}>
          {action.busy ? t('common.saving') : tPlural(chosen.size, 'adm.apps.apply.one', 'adm.apps.apply.other')}
        </Button>
      </div>
      <p className="small muted">{t('adm.apps.tickedNote')}</p>
      {done ? <p role="status">{done}</p> : null}
      <ActionError error={action.error} />
    </Card>
  );
}

export default function WorkAppsPage() {
  const { access } = useMe();
  const categories = useApi(access.isAdmin ? 'admin:app-categories' : null, (signal) => rd.admin.appCategories(signal));
  const teams = useApi(access.isAdmin ? 'admin:teams' : null, (signal) => rd.admin.teams(signal));
  const [app, setApp] = useState('');
  const [category, setCategory] = useState<AppCategory>('core_work');
  const [teamId, setTeamId] = useState('');
  const save = useAction();
  const remove = useAction();
  if (!access.isAdmin) return <NoAccess what={t('adm.apps.noAccess')} />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await save.run(() => rd.admin.setAppCategory({ app_identifier: app.trim(), category, team_id: teamId || null }));
    if (r) {
      setApp('');
      categories.reload();
    }
  };
  const del = async (id: string) => {
    if (await remove.run(() => rd.admin.deleteAppCategory(id))) categories.mutate((prev) => prev?.filter((c) => c.id !== id));
  };

  return (
    <>
      <PageHeader
        eyebrow={t('adm.apps.eyebrow')}
        title={t('adm.apps.title')}
        description={t('adm.apps.description')}
      />
      <Banner tag="NOTE">
        {t('adm.apps.note1')} <span className="mono">com.microsoft.VSCode</span> {t('adm.apps.note2')} <span className="mono">Code.exe</span>{' '}
        {t('adm.apps.note3')}
      </Banner>
      <Card title={t('adm.apps.addRule')}>
        <form className={s.inlineForm} onSubmit={submit}>
          <TextField label={t('adm.apps.identifier')} value={app} onChange={(e) => setApp(e.target.value)} required maxLength={255} />
          <SelectField label={t('adm.apps.category')} value={category} onChange={(e) => setCategory(e.target.value as AppCategory)}>
            {APP_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </SelectField>
          <SelectField label={t('adm.apps.appliesTo')} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">{t('adm.apps.wholeOrg')}</option>
            {(teams.data ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {t('adm.apps.team', { name: team.name })}
              </option>
            ))}
          </SelectField>
          <Button type="submit" variant="primary" disabled={!app.trim() || save.busy}>
            {save.busy ? t('common.saving') : t('adm.apps.saveRule')}
          </Button>
        </form>
        <ActionError error={save.error} />
      </Card>
      {(Object.keys(APP_PRESETS) as AppPresetId[]).map((id) => (
        <Preset key={id} id={id} teams={teams.data ?? []} rules={categories.data ?? []} onApplied={categories.reload} />
      ))}
      <Card title={t('adm.apps.rules')}>
        <ActionError error={remove.error} />
        <Resource {...categories} label={t('adm.apps.loading')}>
          {(list) =>
            list.length === 0 ? (
              <Empty title={t('adm.apps.none')}>{t('adm.apps.noneBody')}</Empty>
            ) : (
              <TableBox label={t('adm.apps.table')}>
                <table className={tableClass} style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('adm.apps.colApp')}</th>
                      <th scope="col">{t('adm.apps.category')}</th>
                      <th scope="col">{t('adm.apps.appliesTo')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('adm.common.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.app_identifier}</td>
                        <td>
                          <Badge tone={c.category === 'core_work' ? 'solid' : 'outline'}>{categoryLabel(c.category)}</Badge>
                        </td>
                        <td>{c.team_name ? t('adm.apps.team', { name: c.team_name }) : t('adm.apps.wholeOrg')}</td>
                        <td style={{ textAlign: 'right' }}>
                          <Button size="sm" variant="quiet" onClick={() => del(c.id)} aria-label={t('adm.apps.removeFor', { app: c.app_identifier })}>
                            {t('adm.apps.remove')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableBox>
            )
          }
        </Resource>
      </Card>
    </>
  );
}
