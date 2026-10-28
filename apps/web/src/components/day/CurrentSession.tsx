import type { SessionDTO } from '@rd/contracts';
import { formatDuration } from '@/lib/format';
import { formatTime } from '@/lib/time';
import { sessionTitle } from './SessionsList';
import { CameraIcon } from './ScreenshotStrip';
import s from './day.module.css';

export function CurrentSession({ session, tz, screenshotsOn, isSelf }: { session: SessionDTO; tz: string; screenshotsOn: boolean; isSelf: boolean }) {
  const paused = session.state === 'paused';
  return (
    <section aria-label="Current session" className={s.current}>
      <span className={s.liveTag}>
        <span className={paused ? s.pausedDot : s.liveDot} aria-hidden="true" />
        {paused ? 'Paused' : 'Tracking now'}
      </span>
      <span className={s.currentWhat}>{sessionTitle(session)}</span>
      <span className={s.currentTime}>{formatDuration(session.tracked_seconds)}</span>
      <span>started {formatTime(session.started_at, tz)}</span>
      {screenshotsOn ? (
        <span className={s.cameraBadge}>
          <CameraIcon />
          Screenshots on for this project
        </span>
      ) : null}
      {!isSelf ? <span className="visually-hidden">Live session of the person you are viewing</span> : null}
    </section>
  );
}
