import s from '../login/login.module.css';

/** The sign-in panel's words for clients (Stage 4 F9). */
export function ClientAbout() {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <h2>Your projects, as your agency sees them.</h2>
        <ul>
          <li>Hours on your projects, by week.</li>
          <li>How much of each budget is used.</li>
          <li>Your invoices, ready to print or save as PDF.</li>
        </ul>
      </div>
      <p className={s.fine} style={{ color: 'var(--ink-muted)' }}>
        Read-only. Nobody&apos;s computer activity, apps or screenshots are ever shown here.
      </p>
    </>
  );
}
