'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import type { ExpansionConflict, PolicyListResponse, PolicyScopeDetail, ScopeType } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError, ErrorState, Loading } from '@/components/ui/DataState';
import { InlineSelect, Segmented, TextArea, inputClass } from '@/components/ui/Field';
import { Badge, Banner, PageHeader, formActionsClass } from '@/components/ui/Layout';
import { rd, toApiError, type ApiError } from '@/lib/api';
import { plural } from '@/lib/format';
import { useMe } from '@/lib/me';
import {
  POLICY_FIELDS,
  describeChange,
  describeSources,
  diffPartials,
  formFromPartial,
  formatFieldValue,
  partialFromForm,
  readField,
  type FieldInput,
  type FieldMeta,
  type PolicyForm,
} from '@/lib/policyForm';
import { formatDateTime, timeZoneOptions, weekdaysShort } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';
import s from './policies.module.css';

interface ScopeRef {
  type: ScopeType;
  id: string;
  name: string;
}

const TYPE_LABEL: Record<ScopeType, string> = { organization: 'Organization', team: 'Team', project: 'Project', device: 'Device' };

function countSet(settings: unknown): number {
  return POLICY_FIELDS.filter((f) => readField(settings as never, f.key) !== undefined).length;
}

// ───────────────────────── scope tree ─────────────────────────

function ScopeTree({
  list,
  teams,
  projects,
  devices,
  orgId,
  orgName,
  selected,
  onSelect,
  scopedAllowed,
}: {
  list: PolicyListResponse;
  teams: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  devices: { id: string; name: string }[];
  orgId: string;
  orgName: string;
  selected: ScopeRef;
  onSelect: (r: ScopeRef) => void;
  scopedAllowed: boolean;
}) {
  const byKey = new Map(list.scopes.map((x) => [`${x.scope_type}:${x.scope_id}`, x]));
  const merge = (type: ScopeType, extra: { id: string; name: string }[]): ScopeRef[] => {
    const out = new Map<string, ScopeRef>();
    for (const x of list.scopes) if (x.scope_type === type) out.set(x.scope_id, { type, id: x.scope_id, name: x.scope_name });
    for (const e of extra) if (!out.has(e.id)) out.set(e.id, { type, id: e.id, name: e.name });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const orgScope = list.scopes.find((x) => x.scope_type === 'organization');
  const groups: { label: string; type: ScopeType; items: ScopeRef[]; empty: string }[] = [
    {
      label: 'Organization',
      type: 'organization',
      items: [{ type: 'organization', id: orgScope?.scope_id ?? orgId, name: orgScope?.scope_name ?? orgName }],
      empty: '',
    },
    { label: 'Teams', type: 'team', items: merge('team', teams), empty: 'No teams' },
    { label: 'Projects', type: 'project', items: merge('project', projects), empty: 'No projects' },
    { label: 'Devices', type: 'device', items: merge('device', []), empty: 'No device overrides' },
  ];
  const deviceChoices = devices.filter((d) => !byKey.has(`device:${d.id}`));

  return (
    <nav className={s.tree} aria-label="Policy scopes">
      {groups.map((g) => (
        <div key={g.label} className={s.treeGroup}>
          <span className={s.treeLabel} id={`scope-${g.type}`}>
            {g.label}
            {g.type !== 'organization' && !scopedAllowed ? ' · Pro' : ''}
          </span>
          {g.items.length === 0 ? (
            <span className={s.treeEmpty}>{g.empty}</span>
          ) : (
            <ul className={s.treeList} aria-labelledby={`scope-${g.type}`}>
              {g.items.map((it) => {
                const stored = byKey.get(`${it.type}:${it.id}`);
                const n = stored?.current ? countSet(stored.current.settings) : 0;
                const isSel = selected.type === it.type && selected.id === it.id;
                return (
                  <li key={it.id}>
                    <button type="button" className={s.treeItem} aria-current={isSel ? 'true' : undefined} onClick={() => onSelect(it)}>
                      <span>{it.name}</span>
                      <span className={s.treeMeta}>{n > 0 ? plural(n, 'setting') : 'Nothing set'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {g.type === 'device' && scopedAllowed && deviceChoices.length > 0 ? (
            <div style={{ padding: '6px 16px 0' }}>
              <InlineSelect
                label="Add override"
                value=""
                onChange={(e) => {
                  const d = devices.find((x) => x.id === e.target.value);
                  if (d) onSelect({ type: 'device', id: d.id, name: d.name });
                }}
              >
                <option value="">Choose a device…</option>
                {deviceChoices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </InlineSelect>
            </div>
          ) : null}
        </div>
      ))}
    </nav>
  );
}

// ───────────────────────── field controls ─────────────────────────

type Tri = 'unset' | 'on' | 'off';

function FieldControl({
  f,
  input,
  onChange,
  disabled,
  error,
  lockedUnset,
  zones,
}: {
  f: FieldMeta;
  input: FieldInput;
  onChange: (next: FieldInput) => void;
  disabled: boolean;
  error?: string;
  /** work_hours cannot be cleared once set */
  lockedUnset: boolean;
  zones: string[];
}) {
  const name = `pol-${f.key}`;
  const errId = `${name}-err`;
  const set = (patch: Partial<FieldInput>) => onChange({ ...input, ...patch });
  let control: ReactNode;

  if (f.kind === 'bool') {
    const v: Tri = !input.set ? 'unset' : input.bool ? 'on' : 'off';
    control = (
      <Segmented<Tri>
        legend={f.label}
        name={name}
        value={v}
        disabled={disabled}
        options={[
          { value: 'unset', label: 'Not set' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
        onChange={(x) => set({ set: x !== 'unset', bool: x === 'on' })}
      />
    );
  } else if (f.kind === 'enum') {
    const v = input.set ? input.text : 'unset';
    control = (
      <Segmented<string>
        legend={f.label}
        name={name}
        value={v}
        disabled={disabled}
        options={[{ value: 'unset', label: 'Not set' }, ...(f.options ?? [])]}
        onChange={(x) => (x === 'unset' ? set({ set: false }) : set({ set: true, text: x }))}
      />
    );
  } else {
    const v = input.set ? 'set' : 'unset';
    const toggle = (
      <Segmented<'unset' | 'set'>
        legend={f.label}
        name={name}
        value={v}
        disabled={disabled}
        options={[
          { value: 'unset', label: 'Not set', disabled: lockedUnset },
          { value: 'set', label: 'Set' },
        ]}
        onChange={(x) => set({ set: x === 'set' })}
      />
    );
    let editor: ReactNode = null;
    if (input.set && f.kind === 'number') {
      editor = (
        <span className={s.numInput}>
          <input
            className={inputClass}
            type="number"
            inputMode="numeric"
            min={f.min}
            max={f.max}
            step={1}
            value={input.text}
            disabled={disabled}
            aria-label={`${f.label}${f.unit ? ` in ${f.unit}` : ''}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => set({ text: e.target.value })}
          />
          <span className="muted small">
            {f.unit} · {f.min}–{f.max}
          </span>
        </span>
      );
    } else if (input.set && f.kind === 'list') {
      editor = (
        <textarea
          className={inputClass}
          rows={3}
          value={input.text}
          disabled={disabled}
          aria-label={`${f.label}, one per line`}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => set({ text: e.target.value })}
        />
      );
    } else if (input.set && f.kind === 'work_hours') {
      const wh = input.wh;
      const setWh = (p: Partial<typeof wh>) => set({ wh: { ...wh, ...p } });
      editor = (
        <>
          <fieldset className={s.days} disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="visually-hidden">Work days</legend>
            {weekdaysShort().map((label, i) => {
              const d = i + 1;
              return (
                <label key={label}>
                  <input
                    type="checkbox"
                    checked={wh.days.includes(d)}
                    onChange={(e) => setWh({ days: e.target.checked ? [...wh.days, d] : wh.days.filter((x) => x !== d) })}
                  />
                  {label}
                </label>
              );
            })}
          </fieldset>
          <span className={s.whRow}>
            <input className={inputClass} type="time" aria-label="Work hours start" value={wh.start} disabled={disabled} onChange={(e) => setWh({ start: e.target.value })} />
            <input className={inputClass} type="time" aria-label="Work hours end" value={wh.end} disabled={disabled} onChange={(e) => setWh({ end: e.target.value })} />
            <select className={inputClass} aria-label="Work hours time zone" value={wh.timezone} disabled={disabled} onChange={(e) => setWh({ timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </span>
        </>
      );
    }
    control = (
      <>
        {toggle}
        {editor}
      </>
    );
  }

  return (
    <div className={s.control}>
      {control}
      {error ? (
        <span id={errId} role="alert" style={{ color: 'var(--danger-text)', fontSize: 13, fontWeight: 500 }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ───────────────────────── editor ─────────────────────────

function isExpansion(details: unknown): details is ExpansionConflict {
  return !!details && typeof details === 'object' && Array.isArray((details as ExpansionConflict).changes);
}

function ScopeEditor({
  detail,
  scope,
  scopeLocked,
  defaultTz,
  onPublished,
}: {
  detail: PolicyScopeDetail;
  scope: ScopeRef;
  scopeLocked: boolean;
  defaultTz: string;
  onPublished: (d: PolicyScopeDetail) => void;
}) {
  const stored = detail.scope.current?.settings ?? {};
  const [form, setForm] = useState<PolicyForm>(() => formFromPartial(stored, defaultTz));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [conflict, setConflict] = useState<ExpansionConflict | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const zones = useMemo(() => timeZoneOptions(defaultTz), [defaultTz]);
  const locked = new Set(detail.plan_locked_fields);

  const { settings, errors } = partialFromForm(form);
  const diff = diffPartials(stored, settings);
  const hasErrors = Object.keys(errors).length > 0;
  const current = { scope_type: detail.scope.scope_type, scope_id: detail.scope.scope_id };
  const groups = [...new Set(POLICY_FIELDS.map((f) => f.group))];

  const publish = async (confirm: boolean) => {
    setShowErrors(true);
    if (hasErrors || note.trim().length < 3 || diff.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await rd.policies.publish(detail.scope.scope_type, detail.scope.scope_id, {
        settings,
        change_note: note.trim(),
        confirm_expansion: confirm,
      });
      setConflict(null);
      onPublished(res);
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'expansion_requires_confirmation' && isExpansion(err.details)) setConflict(err.details);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setForm(formFromPartial(stored, defaultTz));
    setConflict(null);
    setError(null);
    setShowErrors(false);
  };

  return (
    <section className={s.editor} aria-labelledby="scope-h">
      <div className={s.editorHead}>
        <h2 id="scope-h">
          {TYPE_LABEL[scope.type]} · {detail.scope.scope_name || scope.name}
        </h2>
        <span className="small secondary">
          {scope.type === 'project'
            ? `Applies to ${plural(detail.affected_users, 'person', 'people')} while they track time on this project`
            : `Applies to ${plural(detail.affected_users, 'person', 'people')}`}
        </span>
      </div>
      {scopeLocked ? (
        <Banner tone="warn" title="Team, project and device policies are in Pro" actions={<Link href="/admin/billing">Compare plans →</Link>}>
          On your plan only the organization policy applies. You can look at this scope, but not publish it.
        </Banner>
      ) : null}

      <div className={s.cols} aria-hidden="true">
        <span>Setting</span>
        <span>This scope</span>
        <span>Effective for members</span>
      </div>
      {groups.map((g) => (
        <div key={g} role="group" aria-labelledby={`grp-${g}`}>
          <h3 id={`grp-${g}`} className={s.group}>
            {g}
          </h3>
          {POLICY_FIELDS.filter((f) => f.group === g).map((f) => {
            const planLocked = locked.has(f.key);
            const eff = readField(detail.effective.settings, f.key);
            const input = form[f.key]!;
            return (
              <div key={f.key} className={s.fieldRow}>
                <div className={s.fieldText}>
                  <span className={s.fieldLabel}>{f.label}</span>
                  <span className={s.fieldHelp}>{f.help}</span>
                  {planLocked ? (
                    <span>
                      <Badge tone="warn">Not in your plan</Badge>
                    </span>
                  ) : null}
                </div>
                <FieldControl
                  f={f}
                  input={input}
                  disabled={scopeLocked || planLocked || busy}
                  error={showErrors ? errors[f.key] : undefined}
                  lockedUnset={f.kind === 'work_hours' && readField(stored, f.key) !== undefined}
                  zones={zones}
                  onChange={(next) => setForm((prev) => ({ ...prev, [f.key]: next }))}
                />
                <div className={s.effective}>
                  <span className={s.effValue}>{formatFieldValue(f.key, eff)}</span>
                  <span className={s.because}>
                    {planLocked ? 'Your plan keeps this off' : describeSources(detail.effective.sources[f.key], current)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {conflict ? (
        <div className={s.expansion} role="alertdialog" aria-labelledby="exp-h" aria-describedby="exp-d">
          <span className={s.expEyebrow}>Collection increases</span>
          <span id="exp-h" className={s.expTitle}>
            This change collects more for {plural(conflict.affected_users, 'person', 'people')}
          </span>
          <ul id="exp-d" className={s.diff}>
            {conflict.changes.map((c) => (
              <li key={`${c.field}`}>{describeChange(c)}</li>
            ))}
          </ul>
          <p className="secondary">Each person is notified and sees the change in “What&apos;s collected” before the agent applies it.</p>
          <p className="small">
            Change note: <em>{note.trim()}</em>
          </p>
          <div className={formActionsClass}>
            <Button onClick={() => setConflict(null)} disabled={busy}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={() => publish(true)} disabled={busy} autoFocus>
              {busy ? 'Publishing…' : `Publish and notify ${plural(conflict.affected_users, 'person', 'people')} →`}
            </Button>
          </div>
        </div>
      ) : (
        <div className={s.publish}>
          <span className="label-mono">{diff.length === 0 ? 'No changes' : `${plural(diff.length, 'change')} in this scope`}</span>
          {diff.length > 0 ? (
            <ul className={s.diff}>
              {diff.map((d) => (
                <li key={d.key}>
                  {d.label}: {d.from} → {d.to}
                </li>
              ))}
            </ul>
          ) : null}
          <TextArea
            label="Change note (required)"
            rows={2}
            maxLength={2000}
            value={note}
            disabled={scopeLocked}
            placeholder="Why this change, who approved it"
            error={showErrors && note.trim().length < 3 ? 'Explain the change in at least 3 characters.' : null}
            hint="Shown in the audit log and to employees when collection increases."
            onChange={(e) => setNote(e.target.value)}
          />
          {showErrors && hasErrors ? (
            <p role="alert" style={{ color: 'var(--danger-text)', fontWeight: 500 }}>
              Fix the highlighted settings first.
            </p>
          ) : null}
          {error?.code === 'plan_upgrade_required' ? (
            <Banner tone="warn" role="alert" title="Your plan doesn't include this" actions={<Link href="/admin/billing">Compare plans →</Link>}>
              Screenshots, website domains and team, project or device policies need Pro.
            </Banner>
          ) : (
            <ActionError error={error} />
          )}
          <div className={formActionsClass}>
            <Button onClick={reset} disabled={busy || diff.length === 0}>
              Discard changes
            </Button>
            <Button variant="primary" onClick={() => publish(false)} disabled={busy || scopeLocked || diff.length === 0}>
              {busy ? 'Publishing…' : 'Publish →'}
            </Button>
          </div>
        </div>
      )}

      {detail.history.length > 0 ? (
        <details style={{ marginTop: 18 }}>
          <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', fontWeight: 600 }}>
            History ({detail.history.length} versions)
          </summary>
          <ul className={s.history}>
            {[...detail.history]
              .sort((a, b) => b.version - a.version)
              .map((v) => (
                <li key={v.version}>
                  <span className="mono">v{v.version}</span>
                  <span>
                    <span className="small muted">
                      Org revision {v.org_revision} · {formatDateTime(v.published_at, defaultTz)} · {v.published_by}
                    </span>
                    <br />
                    {v.change_note} {v.expands_collection ? <Badge tone="warn">Collected more</Badge> : null}
                  </span>
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

// ───────────────────────── page ─────────────────────────

export default function PoliciesPage() {
  const { access, me, timezone } = useMe();
  const enabled = access.isAdmin;
  const scopedAllowed = me.entitlements.includes('scoped_policies');
  const list = useApi(enabled ? 'policies' : null, (signal) => rd.policies.list(signal));
  const teams = useApi(enabled ? 'admin:teams' : null, (signal) => rd.admin.teams(signal));
  const projects = useApi(enabled ? 'admin:projects' : null, (signal) => rd.admin.projects(signal));
  const devices = useApi(enabled && scopedAllowed ? 'admin:devices' : null, (signal) => rd.admin.devices(signal));
  const [selected, setSelected] = useState<ScopeRef | null>(null);
  const [published, setPublished] = useState<string | null>(null);

  const orgScope = list.data?.scopes.find((x) => x.scope_type === 'organization');
  const scope: ScopeRef = selected ?? {
    type: 'organization',
    id: orgScope?.scope_id ?? me.organization.id,
    name: orgScope?.scope_name ?? me.organization.name,
  };
  const detail = useApi(enabled ? `policy|${scope.type}|${scope.id}` : null, (signal) => rd.policies.detail(scope.type, scope.id, signal));

  if (!enabled) return <NoAccess what="Collection policies are managed by org admins." />;

  return (
    <>
      <PageHeader
        eyebrow="Admin · Collection policy"
        title="Policies"
        description="Each scope sets only what it needs. When scopes disagree, the more private setting wins."
        actions={
          list.data ? (
            <Badge>
              Org revision {list.data.org_revision}
              {orgScope?.current ? ` · published ${formatDateTime(orgScope.current.published_at, timezone).replace(/, \d\d:\d\d$/, '')}` : ''}
            </Badge>
          ) : undefined
        }
      />
      {published ? (
        <Banner role="status" title={published} actions={<Button size="sm" variant="quiet" onClick={() => setPublished(null)}>Dismiss</Button>}>
          Agents pick it up at their next policy check. Devices that haven&apos;t applied it show as “behind” in Devices.
        </Banner>
      ) : null}
      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading label="Loading policies" />
      ) : (
        <div className={s.layout}>
          <ScopeTree
            list={list.data}
            teams={teams.data ?? []}
            projects={projects.data ?? []}
            devices={(devices.data ?? []).filter((d) => d.credential_status === 'active').map((d) => ({ id: d.id, name: `${d.name} (${d.user_name})` }))}
            orgId={me.organization.id}
            orgName={me.organization.name}
            selected={scope}
            onSelect={(r) => {
              setSelected(r);
              setPublished(null);
            }}
            scopedAllowed={scopedAllowed}
          />
          {detail.error ? (
            <section className={s.editor}>
              <ErrorState error={detail.error} onRetry={detail.reload} />
            </section>
          ) : !detail.data ? (
            <section className={s.editor}>
              <Loading label="Loading scope" />
            </section>
          ) : (
            <ScopeEditor
              key={`${scope.type}:${scope.id}:${detail.data.scope.current?.version ?? 0}`}
              detail={detail.data}
              scope={scope}
              scopeLocked={scope.type !== 'organization' && !scopedAllowed}
              defaultTz={timezone}
              onPublished={(d) => {
                detail.mutate(() => d);
                list.reload();
                setPublished(`Published version ${d.scope.current?.version ?? ''} of ${TYPE_LABEL[scope.type].toLowerCase()} ${d.scope.scope_name || scope.name}`);
              }}
            />
          )}
        </div>
      )}
    </>
  );
}
