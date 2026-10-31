'use client';

import { useState, type ReactNode } from 'react';
import { ROUTINE_KINDS, WEEKDAYS, type FamilyRules, type PartialFamilyRules, type Routine, type RoutineKind, type Weekday } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { Checkbox, SelectField, TextArea, TextField } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Layout';
import { cx } from '@/lib/cx';
import {
  crossesMidnight,
  effective,
  inherit,
  isoDay,
  minutesLabel,
  normalizeDomain,
  override,
  parseList,
  pauseForAnHour,
  pauseUntilMorning,
  pausedNow,
  routineId,
  sets,
  type RuleField,
} from '@/lib/family';
import { t, useT } from '@/lib/i18n';
import { formatDateTime, formatTime, weekdayShort } from '@/lib/time';

/** "07:00" as the locale writes a time of day ("7:00 AM" in English). */
const clockTime = (hhmm: string) => formatTime(`2026-01-05T${hhmm}:00Z`, 'UTC');
import s from './family.module.css';

/** Minutes a parent can pick for a day or an app (null = no limit). */
const BUDGETS = [0, 15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480];

/** Common apps, offered as examples only: names differ by platform and version. */
export const APP_EXAMPLES: { name: string; id: string }[] = [
  { name: 'Roblox', id: 'com.roblox.client' },
  { name: 'TikTok', id: 'com.zhiliaoapp.musically' },
  { name: 'Fortnite', id: 'FortniteClient-Win64-Shipping.exe' },
];

export interface RulesEditorProps {
  /** What this document sets. */
  doc: PartialFamilyRules;
  /** What applies to a field the document doesn't set: the defaults, or the family's rules. */
  base: FamilyRules;
  onChange: (doc: PartialFamilyRules) => void;
  /** `child` shows, per field, whether it follows the family rule or is set for this child. */
  mode: 'family' | 'child';
  childName?: string;
  tz: string;
  disabled?: boolean;
}

export function RulesEditor({ doc, base, onChange, mode, childName, tz, disabled }: RulesEditorProps) {
  useT();
  const value = <F extends RuleField>(f: F) => effective(doc, base, f);
  const set = <F extends RuleField>(f: F, v: FamilyRules[F]) => onChange(override(doc, f, v));

  const ctx: SectionCtx = { doc, base, onChange, mode, childName, disabled };

  const budget = value('daily_budget');
  const setDay = (d: Weekday, v: number | null) => set('daily_budget', { ...budget, [d]: v });
  const preset = (weekday: number | null, weekend: number | null) =>
    set('daily_budget', Object.fromEntries(WEEKDAYS.map((d) => [d, d === 'sat' || d === 'sun' ? weekend : weekday])) as FamilyRules['daily_budget']);

  return (
    <div className={s.rules}>
      <RuleSection ctx={ctx} field="daily_budget" title={t('fam.rules.budget')} intro={t('fam.rules.budgetIntro')}>
        <div className={s.presets} role="group" aria-label={t('fam.rules.presets')}>
          <Button size="sm" onClick={() => preset(120, 240)}>
            {t('fam.rules.presetSchool')}
          </Button>
          <Button size="sm" onClick={() => preset(120, 120)}>
            {t('fam.rules.presetEvery')}
          </Button>
          <Button size="sm" onClick={() => preset(null, null)}>
            {t('fam.rules.presetNone')}
          </Button>
        </div>
        <div className={s.days}>
          {WEEKDAYS.map((d) => (
            <SelectField
              key={d}
              label={weekdayShort(isoDay(d))}
              value={budget[d] === null ? 'none' : String(budget[d])}
              onChange={(e) => setDay(d, e.target.value === 'none' ? null : Number(e.target.value))}
            >
              <option value="none">{t('fam.rules.noLimit')}</option>
              {[...new Set([...BUDGETS, ...(budget[d] === null ? [] : [budget[d]!])])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? t('fam.rules.noScreenTime') : minutesLabel(m)}
                  </option>
                ))}
            </SelectField>
          ))}
        </div>
      </RuleSection>

      <RuleSection ctx={ctx} field="routines" title={t('fam.rules.routines')} intro={t('fam.rules.routinesIntro')}>
        <Routines routines={value('routines')} onChange={(r) => set('routines', r)} />
      </RuleSection>

      <RuleSection ctx={ctx} field="blocked_apps" title={t('fam.rules.blocked')} intro={t('fam.rules.blockedIntro')}>
        <ListField
          label={t('fam.rules.blockedLabel')}
          hint={t('fam.rules.onea')}
          items={value('blocked_apps')}
          onChange={(v) => set('blocked_apps', v)}
        />
        <div className={s.examples}>
          <span className="small secondary">{t('fam.rules.examples')}</span>
          {APP_EXAMPLES.map((a) => (
            <Button
              key={a.id}
              size="sm"
              variant="quiet"
              disabled={value('blocked_apps').includes(a.id)}
              onClick={() => set('blocked_apps', [...value('blocked_apps'), a.id])}
            >
              {t('fam.rules.addExample', { name: a.name })}
            </Button>
          ))}
        </div>
      </RuleSection>

      <RuleSection ctx={ctx} field="app_limits" title={t('fam.rules.appLimits')} intro={t('fam.rules.appLimitsIntro')}>
        <AppLimits limits={value('app_limits')} onChange={(v) => set('app_limits', v)} />
      </RuleSection>

      <RuleSection ctx={ctx} field="web" title={t('fam.rules.web')} intro={t('fam.rules.webIntro')}>
        <Checkbox
          label={t('fam.rules.blockAdult')}
          hint={t('fam.rules.blockAdultHint')}
          checked={value('web').block_adult}
          onChange={(e) => set('web', { ...value('web'), block_adult: e.target.checked })}
        />
        <Checkbox
          label={t('fam.rules.safeSearch')}
          hint={t('fam.rules.safeSearchHint')}
          checked={value('web').safe_search}
          onChange={(e) => set('web', { ...value('web'), safe_search: e.target.checked })}
        />
        <div className={s.twoCol}>
          <DomainField
            label={t('fam.rules.blockedSites')}
            items={value('web').blocked_domains}
            onChange={(v) => set('web', { ...value('web'), blocked_domains: v })}
          />
          <DomainField
            label={t('fam.rules.allowedSites')}
            hint={t('fam.rules.allowedSitesHint')}
            items={value('web').allowed_domains}
            onChange={(v) => set('web', { ...value('web'), allowed_domains: v })}
          />
        </div>
      </RuleSection>

      <RuleSection ctx={ctx} field="pause_until" title={t('fam.rules.pause')} intro={t('fam.rules.pauseIntro')}>
        <p className={s.pauseState} role="status">
          {pausedNow(value('pause_until'))
            ? t('fam.rules.pausedUntil', { when: formatDateTime(value('pause_until'), tz) })
            : t('fam.rules.notPaused')}
        </p>
        <div className={s.presets}>
          <Button size="sm" onClick={() => set('pause_until', pauseForAnHour())}>
            {t('fam.rules.pauseHour')}
          </Button>
          <Button size="sm" onClick={() => set('pause_until', pauseUntilMorning(tz))}>
            {t('fam.rules.pauseMorning')}
          </Button>
          <Button size="sm" variant="quiet" disabled={!pausedNow(value('pause_until'))} onClick={() => set('pause_until', null)}>
            {t('fam.rules.resume')}
          </Button>
        </div>
      </RuleSection>

      <RuleSection ctx={ctx} field="allow_requests" title={t('fam.rules.requests')}>
        <Checkbox
          label={t('fam.rules.allowRequests')}
          hint={t('fam.rules.allowRequestsHint')}
          checked={value('allow_requests')}
          onChange={(e) => set('allow_requests', e.target.checked)}
        />
      </RuleSection>
    </div>
  );
}

interface SectionCtx {
  doc: PartialFamilyRules;
  base: FamilyRules;
  onChange: (doc: PartialFamilyRules) => void;
  mode: 'family' | 'child';
  childName?: string;
  disabled?: boolean;
}

/**
 * One rule. In child mode it follows the family until the parent sets it for the child. It is a
 * module-level component, so typing in one of its fields never remounts it.
 */
function RuleSection({ field, title, intro, children, ctx }: { field: RuleField; title: string; intro?: string; children: ReactNode; ctx: SectionCtx }) {
  const { doc, base, onChange, mode, childName, disabled } = ctx;
  const own = mode === 'family' || sets(doc, field);
  return (
    <section className={s.rule} aria-labelledby={`rule-${field}`}>
      <div className={s.ruleHead}>
        <div>
          <h2 id={`rule-${field}`} className={s.ruleTitle}>
            {title}
          </h2>
          {intro ? <p className={cx('small', 'secondary', s.ruleIntro)}>{intro}</p> : null}
        </div>
        {mode === 'child' ? (
          <div className={s.ruleSource}>
            <Badge tone={own ? 'solid' : 'outline'}>{own ? t('fam.rules.setFor', { name: childName ?? '' }) : t('fam.rules.usesFamily')}</Badge>
            <Button size="sm" variant="quiet" disabled={disabled} onClick={() => onChange(own ? inherit(doc, field) : override(doc, field, base[field]))}>
              {own ? t('fam.rules.useFamily') : t('fam.rules.setForAction', { name: childName ?? '' })}
            </Button>
          </div>
        ) : null}
      </div>
      <fieldset className={s.ruleBody} disabled={disabled || !own}>
        <legend className="visually-hidden">{title}</legend>
        {children}
      </fieldset>
    </section>
  );
}

/** A list typed one per line; kept as typed until it changes, so commas and blank lines don't jump. */
function ListField({ label, hint, items, onChange }: { label: string; hint?: string; items: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(items.join('\n'));
  const parsed = parseList(text);
  // The list changed from outside (a preset, "use the family rule"): show it.
  const shown = parsed.join('\n') === items.join('\n') ? text : items.join('\n');
  return (
    <TextArea
      label={label}
      hint={hint}
      rows={3}
      spellCheck={false}
      value={shown}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}

/** Domains typed or pasted as links; anything that isn't a domain is pointed out and left out. */
function DomainField({ label, hint, items, onChange }: { label: string; hint?: string; items: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  const [text, setText] = useState(items.join('\n'));
  const typed = parseList(text);
  const good = [...new Set(typed.map(normalizeDomain).filter((d): d is string => d !== null))];
  const bad = typed.filter((d) => normalizeDomain(d) === null);
  const shown = good.join('\n') === items.join('\n') ? text : items.join('\n');
  return (
    <TextArea
      label={label}
      hint={hint ?? t('fam.rules.oneSite')}
      error={bad.length ? t('fam.rules.notDomain', { items: bad.join(', ') }) : null}
      rows={3}
      spellCheck={false}
      value={shown}
      onChange={(e) => {
        setText(e.target.value);
        const next = [...new Set(parseList(e.target.value).map(normalizeDomain).filter((d): d is string => d !== null))];
        onChange(next);
      }}
    />
  );
}

function Routines({ routines, onChange }: { routines: Routine[]; onChange: (r: Routine[]) => void }) {
  const t = useT();
  const [kind, setKind] = useState<RoutineKind>('school');
  const kindName = (k: RoutineKind) => t(`fam.routine.${k}`);
  const update = (i: number, patch: Partial<Routine>) => onChange(routines.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => {
    const defaults: Record<RoutineKind, Pick<Routine, 'start' | 'end' | 'days'>> = {
      bedtime: { start: '21:00', end: '07:00', days: [...WEEKDAYS] },
      school: { start: '08:30', end: '15:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
      homework: { start: '16:00', end: '17:30', days: ['mon', 'tue', 'wed', 'thu'] },
      custom: { start: '12:00', end: '13:00', days: [...WEEKDAYS] },
    };
    onChange([...routines, { id: routineId(kind, routines.map((r) => r.id)), kind, name: kindName(kind), allow_apps: [], ...defaults[kind] }]);
  };
  return (
    <div className={s.routines}>
      {routines.length === 0 ? <p className="small secondary">{t('fam.rules.noRoutines')}</p> : null}
      {routines.map((r, i) => (
        <div key={r.id} className={s.routine}>
          <div className={s.routineRow}>
            <TextField label={t('fam.rules.routineName')} value={r.name} maxLength={60} onChange={(e) => update(i, { name: e.target.value })} />
            <TextField label={t('fam.rules.from')} type="time" value={r.start} onChange={(e) => update(i, { start: e.target.value })} />
            <TextField label={t('fam.rules.to')} type="time" value={r.end} onChange={(e) => update(i, { end: e.target.value })} />
          </div>
          <fieldset className={s.dayChips}>
            <legend className="small secondary">{t('fam.rules.on')}</legend>
            {WEEKDAYS.map((d) => {
              const on = r.days.includes(d);
              return (
                <label key={d} className={cx(s.chip, on && s.chipOn)}>
                  <input
                    type="checkbox"
                    checked={on}
                    // A routine needs at least one day.
                    disabled={on && r.days.length === 1}
                    onChange={() => update(i, { days: on ? r.days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || r.days.includes(x)) })}
                  />
                  {weekdayShort(isoDay(d))}
                </label>
              );
            })}
          </fieldset>
          {crossesMidnight(r) ? <p className="small secondary">{t('fam.rules.overnight', { end: clockTime(r.end) })}</p> : null}
          <ListField
            label={t('fam.rules.routineAllow')}
            hint={t('fam.rules.routineAllowHint')}
            items={r.allow_apps}
            onChange={(v) => update(i, { allow_apps: v })}
          />
          <div>
            <Button size="sm" variant="quiet" onClick={() => onChange(routines.filter((_, j) => j !== i))}>
              {t('fam.rules.removeRoutine', { name: r.name })}
            </Button>
          </div>
        </div>
      ))}
      {routines.length < 10 ? (
        <div className={s.addRow}>
          <SelectField label={t('fam.rules.newRoutine')} value={kind} onChange={(e) => setKind(e.target.value as RoutineKind)}>
            {ROUTINE_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindName(k)}
              </option>
            ))}
          </SelectField>
          <Button onClick={add}>{t('fam.rules.addRoutine')}</Button>
        </div>
      ) : null}
    </div>
  );
}

function AppLimits({ limits, onChange }: { limits: FamilyRules['app_limits']; onChange: (v: FamilyRules['app_limits']) => void }) {
  const t = useT();
  const [app, setApp] = useState('');
  return (
    <div className={s.routines}>
      {limits.length === 0 ? <p className="small secondary">{t('fam.rules.noAppLimits')}</p> : null}
      {limits.length ? (
        <ul className={s.limitList}>
          {limits.map((l, i) => (
            <li key={`${l.app}-${i}`} className={s.limitRow}>
              <span className={cx('mono', s.limitApp)}>{l.app}</span>
              <SelectField
                label={t('fam.rules.perDay', { app: l.app })}
                value={String(l.minutes)}
                onChange={(e) => onChange(limits.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) } : x)))}
              >
                {[...new Set([...BUDGETS, l.minutes])]
                  .sort((a, b) => a - b)
                  .map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? t('fam.rules.notAtAll') : minutesLabel(m)}
                    </option>
                  ))}
              </SelectField>
              <Button size="sm" variant="quiet" onClick={() => onChange(limits.filter((_, j) => j !== i))}>
                {t('fam.rules.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={s.addRow}>
        <TextField label={t('fam.rules.limitApp')} hint={t('fam.rules.limitAppHint')} value={app} spellCheck={false} onChange={(e) => setApp(e.target.value)} />
        <Button
          disabled={!app.trim() || limits.some((l) => l.app === app.trim()) || limits.length >= 100}
          onClick={() => {
            onChange([...limits, { app: app.trim(), minutes: 60 }]);
            setApp('');
          }}
        >
          {t('fam.rules.addLimit')}
        </Button>
      </div>
    </div>
  );
}
