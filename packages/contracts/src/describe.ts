import type { PolicySettings } from './policy';

/**
 * Plain-language description of an effective policy, shared by the web
 * "What's collected" page and the agent's session-start notice (UX §3.3).
 */
export interface CollectionItem {
  key: string;
  collected: boolean;
  text: string;
  detail: string;
}

export function describeCollection(p: PolicySettings): CollectionItem[] {
  const items: CollectionItem[] = [
    {
      key: 'session',
      collected: true,
      text: 'When your session starts, pauses and stops',
      detail: 'Plus the project and task you chose',
    },
    {
      key: 'activity',
      collected: true,
      text: 'How many keyboard and mouse events happen each minute',
      detail: 'Counts only — never which keys or where you clicked',
    },
    {
      key: 'apps.capture_app_name',
      collected: p.apps.capture_app_name,
      text: 'The name of the app in front',
      detail: p.apps.capture_app_name ? 'For example "Visual Studio Code"' : 'Off for you',
    },
    {
      key: 'apps.capture_domains',
      collected: p.apps.capture_domains,
      text: 'Website domains',
      detail: p.apps.capture_domains ? 'Domain only, e.g. "github.com" — never full addresses' : 'Off for you',
    },
    {
      key: 'apps.capture_window_titles',
      collected: p.apps.capture_window_titles,
      text: 'Window titles and full URLs',
      detail: p.apps.capture_window_titles ? 'Collected' : 'Off for you',
    },
    {
      key: 'screenshots.enabled',
      collected: p.screenshots.enabled,
      text: 'Screenshots',
      detail: p.screenshots.enabled
        ? `About one every ${p.screenshots.interval_minutes} minutes, ${
            p.screenshots.primary_monitor_only ? 'primary monitor' : 'all monitors'
          }, reduced to ${p.screenshots.max_width_px} px wide, kept ${p.screenshots.excluded_apps.length ? 'except when excluded apps are in front, ' : ''}${p.retention.screenshot_days} days`
        : 'Off for you',
    },
  ];
  return items;
}

export const NEVER_COLLECTED =
  'Which keys you press, typed text, passwords, clipboard, webcam, microphone, the content of messages, email or documents, and your location.';

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Activity percentage as defined in system design §6.3; null when nothing was measurable. */
export function activityPercent(activeSeconds: number, idleSeconds: number): number | null {
  const measurable = activeSeconds + idleSeconds;
  if (measurable <= 0) return null;
  return Math.round((activeSeconds / measurable) * 100);
}
