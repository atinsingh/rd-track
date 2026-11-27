import { z } from 'zod';
import type { AppLanguage } from './locale';
import { collectionExpansions, type PolicySettings, type WorkHours } from './policy';

/**
 * Monitoring agreement (EULA) the desktop app shows before it tracks anything.
 *
 * Each acceptance stores what that computer was told is collected (the policies the text was
 * generated from). Tracking needs an acceptance that covers everything collected now
 * (`consentCovers`), else `403 consent_required`: only collecting more asks again. The
 * version labels the text (a policy that collects more, an admin's edit) and its history.
 * The text is generated from the effective policy unless an admin wrote their own.
 */

export const CONSENT_DECISIONS = ['accepted', 'declined'] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];
/** A person's answer to the current version: none yet, yes, or no. */
export type ConsentStatus = 'pending' | ConsentDecision;

export const CONSENT_REQUIRED = 'consent_required';
/** The text or version the app showed is no longer current: fetch it again and re-ask. */
export const CONSENT_OUTDATED = 'consent_outdated';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex SHA-256');

/** The app's answer, naming exactly what was shown. */
export const consentDecisionRequest = z.strictObject({
  version: z.number().int().min(1),
  text_sha256: sha256Hex,
  decision: z.enum(CONSENT_DECISIONS),
});
export type ConsentDecisionRequest = z.infer<typeof consentDecisionRequest>;

/** `GET /v1/device/consent`: what to show, and this person's answer to it. */
export interface DeviceConsentResponse {
  version: number;
  text: string;
  text_sha256: string;
  status: ConsentStatus;
  decided_at: string | null;
}

/** One accept or decline, as stored (append-only). */
export interface ConsentRecordDTO {
  id: string;
  version: number;
  decision: ConsentDecision;
  text_sha256: string;
  text: string;
  /** The address the server saw the answer come from. */
  ip: string;
  device_id: string;
  device_name: string;
  decided_at: string;
}

/** A person's consent: the version in force, their answer to it, and every answer they gave. */
export interface PersonConsentResponse {
  required_version: number;
  status: ConsentStatus;
  /** The last time a manager or admin asked them to answer again ("Ask again"). */
  asked_again_at: string | null;
  records: ConsentRecordDTO[];
}

export interface ConsentVersionDTO {
  version: number;
  reason: 'initial' | 'policy_expansion' | 'text_edited' | 'text_reset';
  created_by: string | null;
  created_at: string | null;
}

/** Admin → Policies: the agreement editor. */
export interface AdminConsentResponse {
  version: number;
  /** The admin's own text, or null when the generated text is used. */
  custom_text: string | null;
  /** The text generated from the organization-wide policy (people see their own effective policy). */
  generated_text: string;
  history: ConsentVersionDTO[];
}

/** Set the admin's own text (a new version), or `null` to go back to the generated text. */
export const adminConsentUpdate = z.strictObject({
  custom_text: z.string().trim().min(1).max(20_000).nullable(),
});

interface AgreementInput {
  organizationName: string;
  /** The person's effective policy, plus any per-project policy that differs (collection is the union). */
  settings: readonly PolicySettings[];
  language: AppLanguage;
  /** The admin's own text: shown instead of the generated one, followed by what is collected about this person, who sees it and for how long. */
  customText?: string | null;
}

/**
 * Plain-language agreement listing exactly what the policies collect, who may see it and
 * how long it is kept. Deterministic: the same input always gives the same text (it is hashed).
 */
export function renderAgreement({ organizationName: org, settings, language, customText }: AgreementInput): string {
  const any = (f: (s: PolicySettings) => boolean) => settings.some(f);
  const max = (f: (s: PolicySettings) => number) => Math.max(...settings.map(f));
  const shots = settings.filter((s) => s.screenshots.enabled);
  const interval = shots.length ? Math.min(...shots.map((s) => s.screenshots.interval_minutes)) : 0;
  const allBlurred = shots.every((s) => s.screenshots.blur);
  const allMonitors = shots.some((s) => !s.screenshots.primary_monitor_only);
  const m = AGREEMENT_TEXT[language];

  const collected: string[] = [m.sessions, m.activity];
  if (any((s) => s.apps.capture_app_name)) collected.push(m.apps);
  if (any((s) => s.apps.capture_domains)) collected.push(m.domains);
  if (any((s) => s.apps.capture_window_titles)) collected.push(m.titles);
  if (shots.length) collected.push(m.screenshots(interval, allMonitors, allBlurred));
  // Location is looked up only for sessions that start inside office hours: none without them.
  if (any((s) => s.location.capture && s.work_hours !== null)) collected.push(m.location);

  const managerSees: string[] = [m.seeTime];
  if (any((s) => s.viewers.manager_can_view_activity)) managerSees.push(m.seeActivity);
  if (any((s) => s.viewers.manager_can_view_apps)) managerSees.push(m.seeApps);
  if (shots.some((s) => s.viewers.manager_can_view_screenshots)) managerSees.push(m.seeScreenshots);

  const kept = [m.keepActivity(max((s) => s.retention.activity_days)), m.keepApps(max((s) => s.retention.app_usage_days))];
  if (shots.length) kept.push(m.keepScreenshots(Math.max(...shots.map((s) => s.retention.screenshot_days))));

  const list = (items: string[]) => items.map((i) => `• ${i}`).join('\n');
  // The person's own lists always follow the admin's text, so what they accept (and its
  // hash) changes whenever what is collected about them, who sees it or how long it is kept does.
  const who = `${m.whoHeading}\n${list([m.admins, m.managers(managerSees.join(', '))])}`;
  const keptFor = `${m.keptHeading}\n${list(kept)}`;
  if (customText != null) return [customText, `${m.collectedHeading}\n${list(collected)}`, who, keptFor].join('\n\n');
  return [
    m.title(org),
    m.intro(org),
    `${m.collectedHeading}\n${list(collected)}`,
    `${m.neverHeading}\n${m.never}`,
    who,
    keptFor,
    m.answer(org),
  ].join('\n\n');
}

const AGREEMENT_TEXT = {
  en: {
    title: (org: string) => `Work-time monitoring agreement — ${org}`,
    intro: (org: string) =>
      `${org} uses RoundDigital Track on this computer to record work time. This explains what the app collects. ` +
      'It collects nothing until you agree, and only while a work session is running.',
    collectedHeading: 'What is collected',
    sessions: 'When your sessions start, pause and stop, and the project and task you choose.',
    activity: 'Keyboard and mouse activity: how many events happen each minute, and when you are idle. Counts only — never which keys you press or where you click.',
    apps: 'The name of the app in front, for example "Visual Studio Code".',
    domains: 'Website domains, for example "github.com" — never full web addresses.',
    titles: 'Window titles and full web addresses.',
    screenshots: (n: number, allMonitors: boolean, blurred: boolean) =>
      `Screenshots, about one every ${n} minutes, of ${allMonitors ? 'all monitors' : 'the primary monitor'}${
        blurred ? ', blurred on this computer so no text can be read' : ''
      }.`,
    location:
      'Your approximate location: the city, region and country looked up from your IP address, only for sessions that start during office hours. ' +
      'The IP address and city are deleted after 30 days. Never GPS.',
    neverHeading: 'Never collected',
    never:
      'Which keys you press, typed text, passwords, clipboard, webcam, microphone, the content of messages, email or documents, and your precise (GPS) location.',
    whoHeading: 'Who can see it',
    admins: 'Your organization’s administrators.',
    managers: (what: string) => `Your managers can see: ${what}.`,
    seeTime: 'your time',
    seeActivity: 'computer activity',
    seeApps: 'app names',
    seeScreenshots: 'screenshots',
    keptHeading: 'How long it is kept',
    keepActivity: (d: number) => `Activity: ${d} days.`,
    keepApps: (d: number) => `App and website usage: ${d} days.`,
    keepScreenshots: (d: number) => `Screenshots: ${d} days.`,
    answer: (org: string) =>
      `Choose "I agree" to allow this monitoring on this computer. If you choose "Decline", the app will not track anything and ${org} will see that you declined; ` +
      `what happens next is up to ${org} (for example HR), and the app takes no other action. ` +
      'You will be asked again if more is collected. Your answers are on your Privacy page.',
  },
  fr: {
    title: (org: string) => `Entente de suivi du temps de travail — ${org}`,
    intro: (org: string) =>
      `${org} utilise RoundDigital Track sur cet ordinateur pour enregistrer le temps de travail. Voici ce que l’application recueille. ` +
      'Elle ne recueille rien tant que vous n’avez pas accepté, et seulement pendant une session de travail.',
    collectedHeading: 'Ce qui est recueilli',
    sessions: 'Le début, les pauses et la fin de vos sessions, ainsi que le projet et la tâche que vous choisissez.',
    activity: 'L’activité du clavier et de la souris : le nombre d’événements par minute et vos périodes d’inactivité. Des nombres seulement — jamais les touches pressées ni l’endroit où vous cliquez.',
    apps: 'Le nom de l’application au premier plan, par exemple « Visual Studio Code ».',
    domains: 'Les domaines des sites web, par exemple « github.com » — jamais les adresses complètes.',
    titles: 'Les titres de fenêtres et les adresses web complètes.',
    screenshots: (n: number, allMonitors: boolean, blurred: boolean) =>
      `Des captures d’écran, environ une toutes les ${n} minutes, ${allMonitors ? 'de tous les écrans' : 'de l’écran principal'}${
        blurred ? ', floutées sur cet ordinateur pour qu’aucun texte ne soit lisible' : ''
      }.`,
    location:
      'Votre emplacement approximatif : la ville, la région et le pays déduits de votre adresse IP, seulement pour les sessions qui commencent pendant les heures de bureau. ' +
      'L’adresse IP et la ville sont effacées après 30 jours. Jamais de GPS.',
    neverHeading: 'Jamais recueilli',
    never:
      'Les touches que vous pressez, le texte saisi, les mots de passe, le presse-papiers, la webcam, le micro, le contenu des messages, courriels ou documents, et votre emplacement précis (GPS).',
    whoHeading: 'Qui peut le voir',
    admins: 'Les administrateurs de votre organisation.',
    managers: (what: string) => `Vos gestionnaires peuvent voir : ${what}.`,
    seeTime: 'votre temps',
    seeActivity: 'l’activité de l’ordinateur',
    seeApps: 'le nom des applications',
    seeScreenshots: 'les captures d’écran',
    keptHeading: 'Durée de conservation',
    keepActivity: (d: number) => `Activité : ${d} jours.`,
    keepApps: (d: number) => `Utilisation des applications et des sites : ${d} jours.`,
    keepScreenshots: (d: number) => `Captures d’écran : ${d} jours.`,
    answer: (org: string) =>
      `Choisissez « J’accepte » pour autoriser ce suivi sur cet ordinateur. Si vous choisissez « Refuser », l’application ne suivra rien et ${org} verra que vous avez refusé ; ` +
      `la suite relève de ${org} (par exemple les RH), et l’application ne fait rien d’autre. ` +
      'On vous le redemandera si davantage est recueilli. Vos réponses se trouvent sur votre page Confidentialité.',
  },
} as const;

/** Office hours `next` that stay within `prev`: same zone, no new days, no earlier start or later end. */
function hoursWithin(prev: WorkHours, next: WorkHours): boolean {
  if (prev.timezone !== next.timezone || !next.days.every((d) => prev.days.includes(d))) return false;
  if (prev.start === next.start && prev.end === next.end) return true;
  // HH:MM compares as text; overnight hours (end before start) must match exactly.
  return prev.start <= prev.end && next.start <= next.end && next.start >= prev.start && next.end <= prev.end;
}

/**
 * What `next` collects beyond `prev`, for consent: everything a published policy counts as an
 * expansion, plus office hours that grow (location and auto-start follow them) and location
 * starting because office hours appeared.
 */
export function consentExpansions(prev: PolicySettings, next: PolicySettings): string[] {
  const out = collectionExpansions(prev, next).map((c) => c.field);
  if (prev.work_hours && next.work_hours && !hoursWithin(prev.work_hours, next.work_hours)) out.push('work_hours');
  const located = (s: PolicySettings) => s.location.capture && s.work_hours !== null;
  if (!located(prev) && located(next) && !out.includes('location.capture')) out.push('location.capture');
  return out;
}

/**
 * Whether an acceptance given for `accepted` (the policies behind the text shown then) covers
 * what is collected now: each current policy within one that was accepted. Collecting less,
 * leaving a team or project, or wording changes never ask again.
 */
export function consentCovers(accepted: readonly PolicySettings[], now: readonly PolicySettings[]): boolean {
  return now.every((n) => accepted.some((a) => consentExpansions(a, n).length === 0));
}
