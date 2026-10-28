'use client';

import { useState } from 'react';
import { APP_CATEGORIES, APP_CATEGORY_LABELS, type AppCategory } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { SelectField, TextField } from '@/components/ui/Field';
import { Badge, Banner, Card, PageHeader, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from '../admin.module.css';

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
