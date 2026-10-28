'use client';

import { useState, type FormEvent } from 'react';
import type { ProjectDTO, TeamSummary, UserDTO } from '@rd/contracts';
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

function TeamItem({ team, users, onChanged }: { team: TeamSummary; users: UserDTO[]; onChanged: () => void }) {
  const action = useAction();
  const members = users
    .filter((u) => u.teams.some((t) => t.id === team.id))
    .map((u) => ({ user: u, role: u.teams.find((t) => t.id === team.id)!.role }))
    .sort((a, b) => byName(a.user, b.user));
  const add = async (userId: string, role: Role) => {
    const r = await action.run(() => rd.admin.addTeamMember(team.id, userId, role));
    if (r) onChanged();
    return !!r;
  };
  const remove = async (userId: string) => {
    const r = await action.run(() => rd.admin.removeTeamMember(team.id, userId));
    if (r) onChanged();
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
          <ActionError error={action.error} />
        </div>
      </details>
    </li>
  );
}

function ProjectItem({ project, users, onChanged }: { project: ProjectDTO; users: UserDTO[]; onChanged: () => void }) {
  const action = useAction();
  const [task, setTask] = useState('');
  const [added, setAdded] = useState<string | null>(null);
  const addTask = async (e: FormEvent) => {
    e.preventDefault();
    const name = task.trim();
    if (!name) return;
    const r = await action.run(() => rd.admin.addTask(project.id, name));
    if (r) {
      setTask('');
      onChanged();
    }
  };
  const addMember = async (userId: string, role: Role) => {
    const r = await action.run(() => rd.admin.addProjectMember(project.id, userId, role));
    if (r) setAdded(users.find((u) => u.id === userId)?.display_name ?? 'Person');
    return !!r;
  };
  return (
    <li className={s.item}>
      <details>
        <summary>
          <span className={s.summaryName}>{project.name}</span>
          <span className="small muted">
            {project.client_ref ? `${project.client_ref} · ` : ''}
            {plural(project.tasks.length, 'task')}
            {project.status === 'archived' ? ' · archived' : ''}
          </span>
        </summary>
        <div className={s.detail}>
          <div className={s.chips} aria-label="Tasks">
            {project.tasks.length ? project.tasks.map((t) => <Badge key={t.id}>{t.name}</Badge>) : <span className="secondary">No tasks yet.</span>}
          </div>
          <form className={s.inlineForm} onSubmit={addTask}>
            <TextField label="New task" value={task} maxLength={200} onChange={(e) => setTask(e.target.value)} />
            <Button type="submit" disabled={!task.trim() || action.busy}>
              Add task
            </Button>
          </form>
          <AddMemberForm users={users} exclude={new Set()} onAdd={addMember} label={project.name} />
          {added ? (
            <p role="status" className="small">
              {added} added to {project.name}.
            </p>
          ) : null}
          <p className="small muted">Project managers see time on this project only — no computer activity or screenshots.</p>
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
  const teams = useApi(enabled ? 'admin:teams' : null, (signal) => rd.admin.teams(signal));
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
            if (r) projects.mutate((prev) => [...(prev ?? []), r]);
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
                {[...list]
                  .sort((a, b) => a.name.localeCompare(b.name))
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
