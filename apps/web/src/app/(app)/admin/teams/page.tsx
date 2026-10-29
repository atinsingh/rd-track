'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { AdminProjectDTO, TeamSummary, UserDTO } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, Empty, Resource } from '@/components/ui/DataState';
import { SelectField, TextField } from '@/components/ui/Field';
import { Badge, Card, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { byName, plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from '../admin.module.css';

type Role = 'member' | 'manager';

/** The admin team list may include members (not yet in the shared contract types). */
type AdminTeam = TeamSummary & { members?: { user_id: string; display_name: string; role: Role }[] };

function AddMemberForm({ users, exclude, onAdd, label }: { users: UserDTO[]; exclude: Set<string>; onAdd: (userId: string, role: Role) => Promise<boolean>; label: string }) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('member');
  const options = users.filter((u) => u.status === 'active' && !exclude.has(u.id)).sort(byName);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (userId && (await onAdd(userId, role))) setUserId('');
  };
  return (
    <form className={s.inlineForm} onSubmit={submit}>
      <SelectField label={`Add to ${label}`} value={userId} onChange={(e) => setUserId(e.target.value)}>
        <option value="">Choose a person…</option>
        {options.map((u) => (
          <option key={u.id} value={u.id}>
            {u.display_name} · {u.email}
          </option>
        ))}
      </SelectField>
      <SelectField label="As" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        <option value="member">Member</option>
        <option value="manager">Manager</option>
      </SelectField>
      <Button type="submit" disabled={!userId}>
        Add
      </Button>
    </form>
  );
}

/** Rename in place: a small form behind a button, so a slip never renames anything. */
function RenameForm({ label, value, onSave, extra }: { label: string; value: string; onSave: (name: string) => Promise<boolean>; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(value);
  if (!open)
    return (
      <Button size="sm" variant="quiet" onClick={() => setOpen(true)}>
        Rename…
      </Button>
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && (await onSave(name.trim()))) setOpen(false);
  };
  return (
    <form className={s.inlineForm} onSubmit={submit}>
      <TextField label={label} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus />
      {extra}
      <Button type="submit" variant="primary" disabled={!name.trim()}>
        Save
      </Button>
      <Button onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  );
}

function TeamItem({ team, users, onChanged }: { team: AdminTeam; users: UserDTO[]; onChanged: () => void }) {
  const action = useAction();
  const members = (
    team.members
      ? team.members.map((m) => ({
          user: users.find((u) => u.id === m.user_id) ?? ({ id: m.user_id, display_name: m.display_name } as UserDTO),
          role: m.role,
        }))
      : users
          .filter((u) => u.teams.some((t) => t.id === team.id))
          .map((u) => ({ user: u, role: u.teams.find((t) => t.id === team.id)!.role }))
  ).sort((a, b) => byName(a.user, b.user));
  const add = async (userId: string, role: Role) => {
    const r = await action.run(() => rd.admin.addTeamMember(team.id, userId, role));
    if (r) onChanged();
    return !!r;
  };
  const remove = async (userId: string) => {
    const r = await action.run(() => rd.admin.removeTeamMember(team.id, userId));
    if (r) onChanged();
  };
  const rename = async (name: string) => {
    const r = await action.run(() => rd.admin.renameTeam(team.id, name));
    if (r) onChanged();
    return !!r;
  };
  const archive = async () => {
    if (await action.run(() => rd.admin.archiveTeam(team.id))) onChanged();
  };
  return (
    <li className={s.item}>
      <details>
        <summary>
          <span className={s.summaryName}>{team.name}</span>
          <span className="small muted">
            {plural(team.member_count, 'member')} · {members.filter((m) => m.role === 'manager').map((m) => m.user.display_name).join(', ') || 'no manager'}
          </span>
        </summary>
        <div className={s.detail}>
          {members.length === 0 ? (
            <p className="secondary">No members yet.</p>
          ) : (
            <ul className={s.members}>
              {members.map(({ user, role }) => (
                <li key={user.id} className={s.member}>
                  <span>
                    {user.display_name} {role === 'manager' ? <Badge>Manager</Badge> : null}
                  </span>
                  <Button size="sm" variant="danger" onClick={() => remove(user.id)} disabled={action.busy} aria-label={`Remove ${user.display_name} from ${team.name}`}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <AddMemberForm users={users} exclude={new Set(members.map((m) => m.user.id))} onAdd={add} label={team.name} />
          <p className="small muted">Moving someone between teams keeps their history: the old membership is closed, a new one opens.</p>
          <div className={s.rowActions}>
            <RenameForm label="Team name" value={team.name} onSave={rename} />
            <Button size="sm" variant="quiet" onClick={archive} disabled={action.busy || members.length > 0} title={members.length ? 'Remove everyone first' : undefined}>
              Archive team
            </Button>
          </div>
          {members.length > 0 ? <p className="small muted">A team can be archived once nobody is in it, so no one silently loses their manager.</p> : null}
          <ActionError error={action.error} />
        </div>
      </details>
    </li>
  );
}

function ProjectItem({ project, users, onChanged }: { project: AdminProjectDTO; users: UserDTO[]; onChanged: () => void }) {
  const action = useAction();
  const [task, setTask] = useState('');
  const [clientRef, setClientRef] = useState(project.client_ref ?? '');
  const archived = project.status === 'archived';
  const run = async (fn: () => Promise<unknown>) => {
    const r = await action.run(fn);
    if (r) onChanged();
    return !!r;
  };
  const addTask = async (e: FormEvent) => {
    e.preventDefault();
    const name = task.trim();
    if (name && (await run(() => rd.admin.addTask(project.id, name)))) setTask('');
  };
  const managers = project.members.filter((m) => m.role === 'manager').map((m) => m.display_name);
  return (
    <li className={s.item}>
      <details>
        <summary>
          <span className={s.summaryName}>
            {project.name} {archived ? <Badge>Archived</Badge> : null}
          </span>
          <span className="small muted">
            {project.client_ref ? `${project.client_ref} · ` : ''}
            {plural(project.tasks.length, 'task')} · {plural(project.members.length, 'member')}
            {managers.length ? ` · managed by ${managers.join(', ')}` : ''}
          </span>
        </summary>
        <div className={s.detail}>
          {archived ? (
            <p className="secondary">Archived: nobody can pick it for new time. Everything recorded on it stays.</p>
          ) : (
            <>
              <div className={s.chips} aria-label="Tasks">
                {project.tasks.length ? (
                  project.tasks.map((t) => (
                    <span key={t.id} className={s.chip}>
                      <Badge>{t.name}</Badge>
                      <Button
                        size="sm"
                        variant="quiet"
                        aria-label={`Archive task ${t.name}`}
                        title="Archive: leaves the picker, keeps its time"
                        onClick={() => void run(() => rd.admin.updateTask(project.id, t.id, { status: 'archived' }))}
                        disabled={action.busy}
                      >
                        ×
                      </Button>
                    </span>
                  ))
                ) : (
                  <span className="secondary">No tasks yet.</span>
                )}
              </div>
              <form className={s.inlineForm} onSubmit={addTask}>
                <TextField label="New task" value={task} maxLength={200} onChange={(e) => setTask(e.target.value)} />
                <Button type="submit" disabled={!task.trim() || action.busy}>
                  Add task
                </Button>
              </form>
              {project.members.length ? (
                <ul className={s.members} aria-label={`People on ${project.name}`}>
                  {project.members.map((m) => (
                    <li key={m.user_id} className={s.member}>
                      <span>
                        {m.display_name} {m.role === 'manager' ? <Badge>Manager</Badge> : null}
                      </span>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void run(() => rd.admin.removeProjectMember(project.id, m.user_id))}
                        disabled={action.busy}
                        aria-label={`Remove ${m.display_name} from ${project.name}`}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">No members: everyone can book time to it.</p>
              )}
              <AddMemberForm
                users={users}
                exclude={new Set(project.members.filter((m) => m.role === 'manager').map((m) => m.user_id))}
                onAdd={(userId, role) => run(() => rd.admin.addProjectMember(project.id, userId, role))}
                label={project.name}
              />
              <p className="small muted">Project managers see time on this project only — no computer activity or screenshots.</p>
            </>
          )}
          <div className={s.rowActions}>
            {!archived ? (
              <RenameForm
                label="Project name"
                value={project.name}
                onSave={(name) => run(() => rd.admin.updateProject(project.id, { name, client_ref: clientRef.trim() || null }))}
                extra={<TextField label="Client reference" value={clientRef} maxLength={200} onChange={(e) => setClientRef(e.target.value)} />}
              />
            ) : null}
            <Button size="sm" variant="quiet" onClick={() => void run(() => rd.admin.updateProject(project.id, { status: archived ? 'active' : 'archived' }))} disabled={action.busy}>
              {archived ? 'Restore project' : 'Archive project'}
            </Button>
          </div>
          <ActionError error={action.error} />
        </div>
      </details>
    </li>
  );
}

function CreateForm({ label, onCreate, withClient }: { label: string; onCreate: (name: string, client?: string) => Promise<boolean>; withClient?: boolean }) {
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await onCreate(name.trim(), client.trim() || undefined)) {
      setName('');
      setClient('');
    }
  };
  return (
    <form className={s.inlineForm} onSubmit={submit}>
      <TextField label={`New ${label} name`} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      {withClient ? <TextField label="Client reference (optional)" value={client} maxLength={200} onChange={(e) => setClient(e.target.value)} /> : null}
      <Button type="submit" variant="primary" disabled={!name.trim()}>
        Create {label}
      </Button>
    </form>
  );
}

export default function TeamsAndProjectsPage() {
  const { access } = useMe();
  const enabled = access.isAdmin;
  const teams = useApi(enabled ? 'admin:teams' : null, (signal) => rd.admin.teams(signal) as Promise<AdminTeam[]>);
  const projects = useApi(enabled ? 'admin:projects' : null, (signal) => rd.admin.projects(signal));
  const users = useApi(enabled ? 'admin:users' : null, (signal) => rd.admin.users(signal));
  const createTeam = useAction();
  const createProject = useAction();
  if (!enabled) return <NoAccess what="Teams and projects are managed by org admins." />;

  const refreshTeams = () => {
    teams.reload();
    users.reload();
  };

  return (
    <>
      <PageHeader
        eyebrow="Admin · Structure"
        title="Teams and projects"
        description="Teams decide who manages whom. Projects group time and can carry their own collection policy."
      />
      <Card title="Teams">
        <CreateForm
          label="team"
          onCreate={async (name) => {
            const r = await createTeam.run(() => rd.admin.createTeam(name));
            if (r) teams.mutate((prev) => [...(prev ?? []), r]);
            return !!r;
          }}
        />
        <ActionError error={createTeam.error} />
        <Resource {...teams} label="Loading teams">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No teams yet" />
            ) : (
              <ul className={s.list}>
                {[...list]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((t) => (
                    <TeamItem key={t.id} team={t} users={users.data ?? []} onChanged={refreshTeams} />
                  ))}
              </ul>
            )
          }
        </Resource>
      </Card>
      <Card title="Projects">
        <CreateForm
          label="project"
          withClient
          onCreate={async (name, client) => {
            const r = await createProject.run(() => rd.admin.createProject(name, client));
            if (r) projects.mutate((prev) => [...(prev ?? []), { ...r, members: [] }]);
            return !!r;
          }}
        />
        <ActionError error={createProject.error} />
        <Resource {...projects} label="Loading projects">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No projects yet" />
            ) : (
              <ul className={s.list}>
                {/* Active first, then archived, each by name. */}
                {[...list]
                  .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1))
                  .map((p) => (
                    <ProjectItem key={p.id} project={p} users={users.data ?? []} onChanged={projects.reload} />
                  ))}
              </ul>
            )
          }
        </Resource>
      </Card>
    </>
  );
}
