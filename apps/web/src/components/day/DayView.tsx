'use client';

import type { ReactNode } from 'react';
import type { MyPolicyResponse, PolicySettings, ScreenshotDTO } from '@rd/contracts';
import { Card } from '@/components/ui/Layout';
import { ErrorState, Loading } from '@/components/ui/DataState';
import { personBase, rd, type ApiError } from '@/lib/api';
import { dayRange, todayInTz } from '@/lib/time';
import { useApi } from '@/lib/useApi';
import { AppBars } from './AppBars';
import { CurrentSession } from './CurrentSession';
import { ScreenshotStrip } from './ScreenshotStrip';
import { SessionsList } from './SessionsList';
import { SummaryTiles } from './SummaryTiles';
import { Timeline } from './Timeline';

export interface Visibility {
  activity: boolean;
  apps: boolean;
  screenshots: boolean;
}

const notShared = (e: ApiError | undefined) => e?.code === 'forbidden';

function NotShared({ title, what, name }: { title: string; what: string; name?: string }) {
  return (
    <Card title={title} className="grow">
      <p className="secondary">
        {what} {name ? `for ${name} ` : ''}isn&apos;t shared with you under the collection policy.
      </p>
    </Card>
  );
}

function shotPolicy(settings: PolicySettings, scopeName: string, managerVisible: boolean): string {
  const sh = settings.screenshots;
  return `${scopeName} · about one every ${sh.interval_minutes} min · kept ${settings.retention.screenshot_days} days · visible to you${
    managerVisible ? ' and your team manager' : ' only'
  }`;
}

/** Plain-language screenshot policy line and whether any policy turns screenshots on. */
export function screenshotPolicySummary(policy: MyPolicyResponse | undefined): { enabled: boolean; text?: string } {
  if (!policy) return { enabled: false };
  const lines: string[] = [];
  if (policy.base.settings.screenshots.enabled)
    lines.push(shotPolicy(policy.base.settings, 'Your policy', policy.base.settings.viewers.manager_can_view_screenshots));
  for (const p of policy.projects)
    if (p.settings.screenshots.enabled)
      lines.push(shotPolicy(p.settings, `Project ${p.project_name} policy`, p.settings.viewers.manager_can_view_screenshots));
  return { enabled: lines.length > 0, text: lines.join(' — ') || undefined };
}

/**
 * One person's day — used for "My day" and, with `userId`, for a team member.
 * Managers see exactly the same components with the same numbers, minus what policy
 * doesn't share with them.
 */
export function DayView({
  userId,
  personName,
  date,
  tz,
  visibility,
  policy,
  sessionAction,
}: {
  /** null = the signed-in user */
  userId: string | null;
  personName?: string;
  date: string;
  tz: string;
  /** what the viewer may see; omit for the signed-in user */
  visibility?: Visibility;
  /** the signed-in user's own policy (self view only) */
  policy?: MyPolicyResponse;
  sessionAction?: ReactNode;
}) {
  const isSelf = userId === null;
  const base = personBase(userId);
  const range = dayRange(date, tz);
  const r = { from: range.from, to: range.to };
  const k = `${base}|${r.from}|${r.to}`;

  const sessions = useApi(`sessions|${k}`, (signal) => rd.person.sessions(base, r, signal));
  const activity = useApi(visibility && !visibility.activity ? null : `activity|${k}`, (signal) =>
    rd.person.activity(base, r, signal),
  );
  const apps = useApi(visibility && !visibility.apps ? null : `apps|${k}`, (signal) => rd.person.apps(base, r, signal));
  const shots = useApi(visibility && !visibility.screenshots ? null : `shots|${k}`, (signal) =>
    rd.person.screenshots(base, r, signal),
  );

  const activityVisible = !(visibility && !visibility.activity) && !notShared(activity.error);
  const shotPolicyInfo = screenshotPolicySummary(policy);
  const shotList: ScreenshotDTO[] = shots.data ?? [];
  const showShots = isSelf ? shotList.length > 0 || shotPolicyInfo.enabled : !!visibility?.screenshots && !notShared(shots.error);

  if (sessions.error && !sessions.data) return <ErrorState error={sessions.error} onRetry={sessions.reload} />;
  if (!sessions.data || (activityVisible && !activity.data && !activity.error)) return <Loading label="Loading the day" />;

  const live =
    date === todayInTz(tz) ? sessions.data.find((x) => x.state !== 'stopped' && x.ended_at === null) : undefined;
  const liveScreenshots = (() => {
    if (!live || !policy) return false;
    const proj = policy.projects.find((p) => p.project_id === live.project_id);
    return (proj?.settings ?? policy.base.settings).screenshots.enabled;
  })();

  return (
    <>
      {live ? <CurrentSession session={live} tz={tz} screenshotsOn={liveScreenshots} isSelf={isSelf} /> : null}
      <SummaryTiles totals={activity.data?.totals ?? null} sessions={sessions.data} activityVisible={activityVisible} />

      {!activityVisible ? (
        <NotShared title="Computer activity through the day" what="Computer activity" name={personName} />
      ) : activity.error ? (
        <Card title="Computer activity through the day">
          <ErrorState error={activity.error} onRetry={activity.reload} />
        </Card>
      ) : activity.data ? (
        <Timeline
          activity={activity.data}
          sessions={sessions.data}
          dayFrom={range.fromMs}
          dayTo={range.toMs}
          tz={tz}
          isSelf={isSelf}
        />
      ) : null}

      <div className="row">
        <SessionsList sessions={sessions.data} tz={tz} action={sessionAction} />
        {(visibility && !visibility.apps) || notShared(apps.error) ? (
          <NotShared title="Applications in front" what="App usage" name={personName} />
        ) : apps.error ? (
          <Card title="Applications in front" className="grow">
            <ErrorState error={apps.error} onRetry={apps.reload} />
          </Card>
        ) : apps.data ? (
          <AppBars apps={apps.data.apps} />
        ) : (
          <Card title="Applications in front" className="grow">
            <Loading />
          </Card>
        )}
      </div>

      {showShots ? (
        shots.error ? (
          <Card title="Screenshots">
            <ErrorState error={shots.error} onRetry={shots.reload} />
          </Card>
        ) : shots.data ? (
          <ScreenshotStrip
            shots={shotList}
            tz={tz}
            isSelf={isSelf}
            personName={personName}
            policyText={isSelf ? shotPolicyInfo.text : undefined}
            onDeletionRequested={(id) =>
              shots.mutate((prev) =>
                prev?.map((x) => (x.id === id ? { ...x, deletion_request_status: 'pending' as const } : x)),
              )
            }
          />
        ) : (
          <Card title="Screenshots">
            <Loading />
          </Card>
        )
      ) : null}
    </>
  );
}
