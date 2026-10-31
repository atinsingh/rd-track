'use client';

import { useState } from 'react';
import { LOCALE_LABELS, LOCALES, LOGO_CONTENT_TYPES, type AppLocale, type BrandingDTO } from '@rd/contracts';
import { OrgLogo } from '@/components/OrgLogo';
import { Button } from '@/components/ui/Button';
import { ActionError, Resource } from '@/components/ui/DataState';
import { SelectField } from '@/components/ui/Field';
import { Card, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { logoProblem } from '@/lib/branding';
import { t } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { formatDateTime } from '@/lib/time';
import { useAction, useApi } from '@/lib/useApi';
import { NoAccess } from '../../NoAccess';

/** The organization's default language and formats (G27), which its invoices and client portal use too. */
function OrgLanguage({ b, onSaved }: { b: BrandingDTO; onSaved: (b: BrandingDTO) => void }) {
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const change = async (value: AppLocale | '') => {
    setSaved(false);
    const r = await action.run(() => rd.admin.setOrgLocale(value || null));
    if (r) {
      onSaved(r);
      setSaved(true);
    }
  };
  return (
    <Card title={t('language.orgTitle')} subtitle={t('language.orgSubtitle')}>
      <SelectField label={t('language.label')} value={b.locale ?? ''} disabled={action.busy} onChange={(e) => void change(e.target.value as AppLocale | '')}>
        <option value="">{t('language.orgFollowBrowser')}</option>
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </SelectField>
      <p role="status" className="small secondary">
        {saved ? t('language.orgSaved') : ''}
      </p>
      <ActionError error={action.error} />
    </Card>
  );
}

/** The organization's own logo (G26), shown beside the product mark, in the client portal and on invoices. */
export default function BrandingPage() {
  const { access, timezone: tz, me, reload } = useMe();
  const branding = useApi(access.isAdmin ? 'admin:branding' : null, (signal) => rd.admin.branding(signal));
  const action = useAction();
  const [problem, setProblem] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  if (!access.isAdmin) return <NoAccess what={t('cfg.brand.noAccess')} />;

  const upload = async (file: File | null) => {
    setProblem(null);
    if (!file) return;
    const p = logoProblem(file);
    if (p) {
      setProblem(p);
      return;
    }
    const r = await action.run(async () => {
      const up = await rd.admin.logoUpload(file.type, file.size);
      const put = await fetch(up.url, { method: 'PUT', headers: up.headers, body: file }).catch(() => null);
      if (!put?.ok) throw new Error(t('cfg.brand.uploadFailed'));
      return rd.admin.setLogo(up.upload_id);
    });
    setInputKey((k) => k + 1);
    if (r) {
      branding.mutate(() => r);
      reload();
    }
  };
  const remove = async () => {
    const r = await action.run(() => rd.admin.removeLogo());
    if (r) {
      branding.mutate(() => r);
      reload();
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('cfg.brand.eyebrow')}
        title={t('nav.branding')}
        description={t('cfg.brand.description', { org: me.organization.name })}
      />
      <Card title={t('cfg.brand.yourLogo')}>
        <Resource {...branding} label={t('cfg.brand.loading')}>
          {(b) => (
            <div className="stack" style={{ gap: 14 }}>
              {b.logo_url ? (
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ padding: 16, background: 'var(--ink)', borderRadius: 'var(--radius-control)' }}>
                    <OrgLogo url={b.logo_url} name={me.organization.name} />
                  </span>
                  <OrgLogo url={b.logo_url} name={me.organization.name} plain />
                </div>
              ) : (
                <p className="secondary">{t('cfg.brand.none')}</p>
              )}
              {b.logo_updated_at ? <p className="small muted">{t('cfg.brand.lastChanged', { when: formatDateTime(b.logo_updated_at, tz) })}</p> : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  key={inputKey}
                  id="logo-file"
                  type="file"
                  accept={LOGO_CONTENT_TYPES.join(',')}
                  className="visually-hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => void upload(e.target.files?.[0] ?? null)}
                />
                <Button
                  variant="primary"
                  disabled={action.busy}
                  onClick={() => (document.getElementById('logo-file') as HTMLInputElement | null)?.click()}
                >
                  {action.busy ? t('cfg.brand.uploading') : b.logo_url ? t('cfg.brand.replace') : t('cfg.brand.upload')}
                </Button>
                {b.logo_url ? (
                  <Button onClick={() => void remove()} disabled={action.busy}>
                    {t('cfg.brand.remove')}
                  </Button>
                ) : null}
              </div>
              <p className="small muted">{t('cfg.brand.hint')}</p>
              {problem ? (
                <p className="small" role="alert">
                  {problem}
                </p>
              ) : null}
              <ActionError error={action.error} />
            </div>
          )}
        </Resource>
      </Card>
      {branding.data ? <OrgLanguage b={branding.data} onSaved={(r) => branding.mutate(() => r)} /> : null}
    </>
  );
}
