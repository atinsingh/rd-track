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
import { t } from '@/lib/i18n';
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
  if (!access.isAdmin) return <NoAccess what={t('cfg.data.noAccess')} />;

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
      <PageHeader eyebrow={t('cfg.eyebrow.data')} title={t('cfg.data.title')} description={t('cfg.data.description')} />
      <Card title={t('cfg.data.exportTitle')} subtitle={t('cfg.data.exportSubtitle')}>
        <p className="small secondary">{t('cfg.data.exportBody')}</p>
        <DataExports res={exports} onRequest={() => rd.admin.requestDataExport()} label={t('cfg.data.exportAll')} tz={tz} />
      </Card>
      <Resource {...org} label={t('common.loading')}>
        {(o) =>
          o.deletion_scheduled_at ? (
            <Banner
              tone="warn"
              title={t('cfg.data.willDelete', { org: o.name, when: formatDateTime(o.deletion_scheduled_at, tz) })}
              actions={
                <Button onClick={cancel} disabled={action.busy}>
                  {t('cfg.data.cancel')}
                </Button>
              }
            >
              {o.deletion_requested_by_name ? t('cfg.data.closedBy', { name: o.deletion_requested_by_name }) : ''}
              {t('cfg.data.closingBody')}
            </Banner>
          ) : (
            <Card title={t('cfg.data.closeTitle')} subtitle={t('cfg.data.closeSubtitle')}>
              <ul className="small secondary" style={{ margin: 0, paddingLeft: 18 }}>
                <li>{t('cfg.data.close1', { n: CLOSE_GRACE_DAYS })}</li>
                <li>{t('cfg.data.close2')}</li>
                <li>{t('cfg.data.close3', { n: BACKUP_RETENTION_DAYS })}</li>
                <li>{t('cfg.data.close4')}</li>
              </ul>
              <div>
                <Button variant="danger" onClick={() => setClosing(true)}>
                  {t('cfg.data.closeButton')}
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
        title={t('cfg.data.dialogTitle', { org: org.data?.name ?? t('cfg.data.thisOrg') })}
        description={t('cfg.data.dialogBody', { n: CLOSE_GRACE_DAYS })}
        footer={
          <>
            <Button onClick={() => setClosing(false)}>{t('cfg.data.keep')}</Button>
            <Button variant="danger" onClick={close} disabled={action.busy || typed.trim() !== org.data?.name}>
              {t('cfg.data.closeConfirm')}
            </Button>
          </>
        }
      >
        <TextField label={t('cfg.data.orgName')} placeholder={org.data?.name} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <ActionError error={action.error} />
      </Dialog>
    </>
  );
}
