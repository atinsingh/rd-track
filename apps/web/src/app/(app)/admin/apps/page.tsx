'use client';

import { useState } from 'react';
import { APP_CATEGORIES, APP_CATEGORY_LABELS, APP_PRESETS, type AppCategory, type AppCategoryDTO, type AppPresetId, type TeamSummary } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { Checkbox, SelectField, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from '../admin.module.css';

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
      setDone(`${r.applied} rules saved as ${APP_CATEGORY_LABELS[category]}.`);
      onApplied();
    }
  };
  return (
    <Card title={`Preset · ${preset.label}`} subtitle={preset.description}>
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
                  hint={rule ? `Now ${APP_CATEGORY_LABELS[rule.category]}` : undefined}
                  checked={chosen.has(i)}
                  onChange={() => toggle(i)}
                />
              );
            })}
          </fieldset>
        ))}
      </div>
      <div className={s.inlineForm}>
        <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value as AppCategory)}>
          {APP_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {APP_CATEGORY_LABELS[c]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Applies to" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">Whole organization</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              Team · {t.name}
            </option>
          ))}
        </SelectField>
        <Button variant="primary" onClick={apply} disabled={chosen.size === 0 || action.busy}>
          {action.busy ? 'Saving…' : `Apply ${chosen.size} rules`}
        </Button>
      </div>
      <p className="small muted">Ticked apps get this category, replacing a rule they already have in the same scope. You can change or remove each one below.</p>
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
  if (!access.isAdmin) return <NoAccess what="Work-app categories are managed by org admins." />;

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
        eyebrow="Admin · Insights"
        title="Work apps"
        description="Group the apps people use into categories. Each person sees their own time by category on their insights page and apps report."
      />
      <Banner tag="NOTE">
        Categories describe the app, not the person. Team rules override organization-wide rules for members of that team. Use the
        app identifier the agent reports (for example <span className="mono">com.microsoft.VSCode</span> on macOS or{' '}
        <span className="mono">Code.exe</span> on Windows) — matching ignores case.
      </Banner>
      <Card title="Add or change a rule">
        <form className={s.inlineForm} onSubmit={submit}>
          <TextField label="App identifier" value={app} onChange={(e) => setApp(e.target.value)} required maxLength={255} />
          <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value as AppCategory)}>
            {APP_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {APP_CATEGORY_LABELS[c]}
              </option>
            ))}
          </SelectField>
          <SelectField label="Applies to" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">Whole organization</option>
            {(teams.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                Team · {t.name}
              </option>
            ))}
          </SelectField>
          <Button type="submit" variant="primary" disabled={!app.trim() || save.busy}>
            {save.busy ? 'Saving…' : 'Save rule'}
          </Button>
        </form>
        <ActionError error={save.error} />
      </Card>
      {(Object.keys(APP_PRESETS) as AppPresetId[]).map((id) => (
        <Preset key={id} id={id} teams={teams.data ?? []} rules={categories.data ?? []} onApplied={categories.reload} />
      ))}
      <Card title="Rules">
        <ActionError error={remove.error} />
        <Resource {...categories} label="Loading work-app rules">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No rules yet">Until you add some, every app shows as “Not categorized”.</Empty>
            ) : (
              <TableBox label="Work-app rules">
                <table className={tableClass} style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th scope="col">App</th>
                      <th scope="col">Category</th>
                      <th scope="col">Applies to</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.app_identifier}</td>
                        <td>
                          <Badge tone={c.category === 'core_work' ? 'solid' : 'outline'}>{APP_CATEGORY_LABELS[c.category]}</Badge>
                        </td>
                        <td>{c.team_name ? `Team · ${c.team_name}` : 'Whole organization'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <Button size="sm" variant="quiet" onClick={() => del(c.id)} aria-label={`Remove rule for ${c.app_identifier}`}>
                            Remove
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
