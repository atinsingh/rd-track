'use client';

import { useState } from 'react';
import { BACKUP_RETENTION_DAYS, CLOSE_GRACE_DAYS } from '@rd/contracts';
import { DataExports } from '@/components/DataExports';
import { Button } from '@/components/ui/Button';
import { ActionError, Resource } from '@/components/ui/DataState';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/Field';
import { Banner, Card, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

/** G17: take everything with you, and close the organization when the contract ends. */
export default function OrganizationDataPage() {
  const { access, timezone: tz } = useMe();
  const exports = useApi(access.isAdmin ? 'admin:data-exports' : null, (signal) => rd.admin.dataExports(signal));
  const org = useApi(access.isAdmin ? 'admin:organization' : null, (signal) => rd.admin.organization(signal));
  const [closing, setClosing] = useState(false);
  const [typed, setTyped] = useState('');
  const action = useAction();
  if (!access.isAdmin) return <NoAccess what="Organization data is managed by org admins." />;

  const close = async () => {
    const r = await action.run(() => rd.admin.closeOrganization(typed));
    if (r) {
      org.mutate(() => r);
      setClosing(false);
      setTyped('');
    }
  };
  const cancel = async () => {
    const r = await action.run(() => rd.admin.cancelClose());
    if (r) org.mutate(() => r);
  };

  return (
    <>
      <PageHeader eyebrow="Settings · Data" title="Organization data" description="Export your organization's records at any time, and close the account when you're done." />
      <Card title="Export everything" subtitle="One ZIP of CSV files: people, structure, time, timesheets, time off, money, policies and the full audit log">
        <p className="small secondary">
          Computer activity, app names and screenshots aren&apos;t included — admins can&apos;t see them in Track either. Each person can download their own
          from What&apos;s collected. Passwords and other secrets are never exported.
        </p>
        <DataExports res={exports} onRequest={() => rd.admin.requestDataExport()} label="Export all records" tz={tz} />
      </Card>
      <Resource {...org} label="Loading">
        {(o) =>
          o.deletion_scheduled_at ? (
            <Banner
              tone="warn"
              title={`${o.name} will be deleted on ${formatDateTime(o.deletion_scheduled_at, tz)}`}
              actions={
                <Button onClick={cancel} disabled={action.busy}>
                  Cancel closing
                </Button>
              }
            >
              {o.deletion_requested_by_name ? `${o.deletion_requested_by_name} closed the organization. ` : ''}Everyone was told. Until then everything keeps
              working and any org admin can cancel. Export what you need before that day.
            </Banner>
          ) : (
            <Card title="Close this organization" subtitle="When your contract ends">
              <ul className="small secondary" style={{ margin: 0, paddingLeft: 18 }}>
                <li>Everything stays as it is for {CLOSE_GRACE_DAYS} days, and any org admin can cancel.</li>
                <li>Everyone in the organization is told, so they can download their own data first.</li>
                <li>
                  Then all records and stored files are deleted, the audit log included. Encrypted backups age out within {BACKUP_RETENTION_DAYS} days.
                </li>
                <li>Org admins get a certificate of deletion by email. RoundDigital keeps only that certificate.</li>
              </ul>
              <div>
                <Button variant="danger" onClick={() => setClosing(true)}>
                  Close organization…
                </Button>
              </div>
            </Card>
          )
        }
      </Resource>
      <ActionError error={closing ? null : action.error} />
      <Dialog
        open={closing}
        onClose={() => {
          setClosing(false);
          action.reset();
        }}
        size="sm"
        title={`Close ${org.data?.name ?? 'this organization'}?`}
        description={`It is deleted in ${CLOSE_GRACE_DAYS} days unless an org admin cancels. Type the organization's name to confirm.`}
        footer={
          <>
            <Button onClick={() => setClosing(false)}>Keep it</Button>
            <Button variant="danger" onClick={close} disabled={action.busy || typed.trim() !== org.data?.name}>
              Close organization
            </Button>
          </>
        }
      >
        <TextField label="Organization name" placeholder={org.data?.name} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
    </>
  );
}
