'use client';

import { useState } from 'react';
import { USER_IMPORT_MAX_ROWS, type UserImportResponse } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { TextArea } from '@/components/ui/Field';
import { Badge, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { t, tPlural } from '@/lib/i18n';
import { IMPORT_TEMPLATE, rowsFromCsv } from '@/lib/peopleImport';
import { useAction } from '@/lib/useApi';

/**
 * Invite many people from a CSV (G14). "Check" runs the server's dry run so every row is
 * judged by the same rules as a single invite (email, role, seats, duplicates) before
 * anyone gets an email; "Invite" then sends one invite per good row.
 */
export function ImportPeopleDialog({ open, onClose, onDone, defaultTz }: { open: boolean; onClose: () => void; onDone: () => void; defaultTz: string }) {
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<UserImportResponse | null>(null);
  const [done, setDone] = useState<UserImportResponse | null>(null);
  const action = useAction();
  const parsed = text.trim() ? rowsFromCsv(text, defaultTz) : null;
  const tooMany = (parsed?.rows.length ?? 0) > USER_IMPORT_MAX_ROWS;
  const result = done ?? checked;

  const close = () => {
    setText('');
    setChecked(null);
    setDone(null);
    action.reset();
    onClose();
  };
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    setChecked(null);
    setDone(null);
  };
  const check = async () => {
    if (!parsed?.rows.length) return;
    const r = await action.run(() => rd.admin.importUsers(parsed.rows, true));
    if (r) setChecked(r);
  };
  const run = async () => {
    if (!parsed?.rows.length) return;
    const r = await action.run(() => rd.admin.importUsers(parsed.rows, false));
    if (r) {
      setDone(r);
      onDone();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      eyebrow={t('mgr.users.eyebrow')}
      title={done ? tPlural(done.ok, 'mgr.import.sentOne', 'mgr.import.sentOther') : t('mgr.import.title')}
      description={done ? undefined : t('mgr.import.desc')}
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            {t('security.done')}
          </Button>
        ) : (
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button onClick={check} disabled={!parsed?.rows.length || !!parsed.problem || tooMany || action.busy}>
              {action.busy && !checked ? t('mgr.import.checking') : t('mgr.import.check')}
            </Button>
            <Button variant="primary" onClick={run} disabled={!checked || checked.ok === 0 || action.busy}>
              {action.busy && checked
                ? t('mgr.import.inviting')
                : checked
                  ? tPlural(checked.ok, 'mgr.import.inviteOne', 'mgr.import.inviteOther')
                  : t('mgr.import.invite')}
            </Button>
          </>
        )
      }
    >
      {!done ? (
        <>
          <input type="file" accept=".csv,text/csv" aria-label={t('mgr.import.file')} onChange={(e) => void readFile(e.target.files?.[0])} />
          <TextArea
            label={t('mgr.import.paste')}
            rows={6}
            className="mono"
            placeholder={IMPORT_TEMPLATE}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setChecked(null);
            }}
          />
          <p className="small muted">
            <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_TEMPLATE)}`} download="people-template.csv">
              {t('mgr.import.template')}
            </a>
            {t('mgr.import.limits', { max: USER_IMPORT_MAX_ROWS, tz: defaultTz })}
          </p>
          {parsed?.problem ? <p className="small" role="alert">{parsed.problem}</p> : null}
          {tooMany ? (
            <p className="small" role="alert">
              {t('mgr.import.tooMany', { n: parsed!.rows.length, max: USER_IMPORT_MAX_ROWS })}
            </p>
          ) : null}
        </>
      ) : null}
      {result ? (
        <>
          <p className="small secondary" role="status">
            {done
              ? `${tPlural(done.ok, 'mgr.import.invitedOne', 'mgr.import.invitedOther')}${done.failed ? t('mgr.import.skipped', { n: done.failed }) : ''}.`
              : `${tPlural(result.ok, 'mgr.import.readyOne', 'mgr.import.readyOther')}${result.failed ? t('mgr.import.cantImport', { n: result.failed }) : ''}.`}
          </p>
          <TableBox label={t('mgr.import.rows')}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col">{t('mgr.import.colRow')}</th>
                  <th scope="col">{t('mgr.import.colEmail')}</th>
                  <th scope="col">{t('mgr.import.colResult')}</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.row}>
                    <td className="mono small">{r.row}</td>
                    <td>{r.email ?? '—'}</td>
                    <td className="small">
                      {r.ok ? (
                        <>
                          <Badge tone="solid">{done ? t('mgr.import.invited') : t('mgr.import.ready')}</Badge>
                          {r.team === 'created' ? t('mgr.import.newTeam') : r.team === 'joined' ? t('mgr.import.joinsTeam') : ''}
                        </>
                      ) : (
                        <>
                          <Badge tone="warn">{t('mgr.import.skippedBadge')}</Badge> {r.message}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableBox>
        </>
      ) : null}
      <ActionError error={action.error} />
    </Dialog>
  );
}
