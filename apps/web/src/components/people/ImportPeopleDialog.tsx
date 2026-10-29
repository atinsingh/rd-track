'use client';

import { useState } from 'react';
import { USER_IMPORT_MAX_ROWS, type UserImportResponse } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { TextArea } from '@/components/ui/Field';
import { Badge, TableBox, tableClass } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { plural } from '@/lib/format';
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
      eyebrow="Admin · People"
      title={done ? `${plural(done.ok, 'invite')} sent` : 'Import people from CSV'}
      description={
        done
          ? undefined
          : 'One person per line. Required columns: email and name. Optional: role (employee, admin, auditor, finance), timezone, tracks time (yes/no), team (created if new).'
      }
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button onClick={check} disabled={!parsed?.rows.length || !!parsed.problem || tooMany || action.busy}>
              {action.busy && !checked ? 'Checking…' : 'Check rows'}
            </Button>
            <Button variant="primary" onClick={run} disabled={!checked || checked.ok === 0 || action.busy}>
              {action.busy && checked ? 'Inviting…' : checked ? `Invite ${plural(checked.ok, 'person', 'people')}` : 'Invite'}
            </Button>
          </>
        )
      }
    >
      {!done ? (
        <>
          <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => void readFile(e.target.files?.[0])} />
          <TextArea
            label="Or paste CSV"
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
              Download a template
            </a>{' '}
            · Up to {USER_IMPORT_MAX_ROWS} people at a time. Time zone defaults to {defaultTz}. Nobody is emailed until you press Invite.
          </p>
          {parsed?.problem ? <p className="small" role="alert">{parsed.problem}</p> : null}
          {tooMany ? (
            <p className="small" role="alert">
              That&apos;s {parsed!.rows.length} people; import at most {USER_IMPORT_MAX_ROWS} at a time.
            </p>
          ) : null}
        </>
      ) : null}
      {result ? (
        <>
          <p className="small secondary" role="status">
            {done
              ? `${plural(done.ok, 'person', 'people')} invited${done.failed ? `, ${done.failed} skipped` : ''}.`
              : `${plural(result.ok, 'row')} ready${result.failed ? `, ${result.failed} can't be imported (fix them in the file and check again, or invite the rest)` : ''}.`}
          </p>
          <TableBox label="Rows">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Email</th>
                  <th scope="col">Result</th>
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
                          <Badge tone="solid">{done ? 'Invited' : 'Ready'}</Badge>
                          {r.team === 'created' ? ' · new team' : r.team === 'joined' ? ' · joins team' : ''}
                        </>
                      ) : (
                        <>
                          <Badge tone="warn">Skipped</Badge> {r.message}
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
