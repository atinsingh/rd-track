import type { AuditEventDTO, CollectionItem, PolicySettings } from '@rd/contracts';
import { humanize } from './format';
import { t, type MessageKey } from './i18n';

/**
 * "What's collected" in the reader's language (G27). The English catalogue entries are word
 * for word `describeCollection` in @rd/contracts, which the desktop agent mirrors; a test
 * keeps them equal.
 */
export function describeCollectionLocalized(p: PolicySettings): CollectionItem[] {
  const off = t('collect.off');
  const sh = p.screenshots;
  return [
    { key: 'session', collected: true, text: t('collect.session.text'), detail: t('collect.session.detail') },
    { key: 'activity', collected: true, text: t('collect.activity.text'), detail: t('collect.activity.detail') },
    {
      key: 'apps.capture_app_name',
      collected: p.apps.capture_app_name,
      text: t('collect.appName.text'),
      detail: p.apps.capture_app_name ? t('collect.appName.detail') : off,
    },
    {
      key: 'apps.capture_domains',
      collected: p.apps.capture_domains,
      text: t('collect.domains.text'),
      detail: p.apps.capture_domains ? t('collect.domains.detail') : off,
    },
    {
      key: 'apps.capture_window_titles',
      collected: p.apps.capture_window_titles,
      text: t('collect.titles.text'),
      detail: p.apps.capture_window_titles ? t('collect.titles.detail') : off,
    },
    {
      key: 'screenshots.enabled',
      collected: sh.enabled,
      text: t('collect.shots.text'),
      detail: sh.enabled
        ? t('collect.shots.detail', {
            minutes: sh.interval_minutes,
            monitors: sh.primary_monitor_only ? t('collect.shots.primary') : t('collect.shots.all'),
            blurred: sh.blur ? t('collect.shots.blurred') : '',
            width: sh.max_width_px,
            excluded: sh.excluded_apps.length ? t('collect.shots.excluded') : '',
            days: p.retention.screenshot_days,
          })
        : off,
    },
  ];
}

/** What a manager can see, as the API words it ("computer activity", "time on Client A"), in the reader's language. */
export function viewerSees(s: string): string {
  const known: Record<string, MessageKey> = {
    time: 'privacy.sees.time',
    'computer activity': 'privacy.sees.activity',
    'app names': 'privacy.sees.apps',
    'screenshots where policy allows': 'privacy.sees.shots',
  };
  if (known[s]) return t(known[s]);
  const on = /^time on (.+)$/.exec(s);
  return on ? t('privacy.sees.timeOn', { project: on[1]! }) : s;
}

const ACCESS_ACTIONS = new Set([
  'screenshot.view', 'pay_rate.view', 'payroll_adjustment.view', 'expense.receipt_view', 'client_portal.view_hours',
  'payroll_adjustment.create', 'payroll_adjustment.end', 'payroll_adjustment.delete', 'pay_rate.create', 'pay_rate.delete',
  'bill_rate.create', 'screenshot.list', 'screenshot.deleted', 'activity.view', 'apps.view', 'time.view', 'export.create',
  'time_correction.approve', 'time_correction.reject', 'timesheet.view', 'timesheet.approve', 'timesheet.reject',
  'timesheet.reopen', 'work_limits.update', 'deletion_request.approve', 'deletion_request.reject', 'user.create',
  'user.update', 'team.member_set', 'project.member_set', 'device.enrollment_code_created', 'device.revoked',
  'legal_hold.create', 'support.viewed', 'erasure.declined', 'erasure.approved', 'auth.login', 'auth.sso_subject_changed',
  'attendance.view', 'expense.submitted', 'expense.approved', 'expense.cancelled',
]);

/** One line of "Who viewed your data". Action names are as the API's audit log writes them. */
export function describeAccess(e: AuditEventDTO): string {
  const text = ACCESS_ACTIONS.has(e.action) ? t(`access.${e.action}` as MessageKey) : humanize(e.action);
  return e.result === 'denied' ? t('privacy.denied', { text }) : text;
}
