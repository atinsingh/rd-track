import Link from 'next/link';
import { PageHeader } from '@/components/ui/Layout';
import { t } from '@/lib/i18n';

export function NoAccess({ what }: { what: string }) {
  return (
    <>
      <PageHeader eyebrow={t('common.noAccess')} title={t('common.noAccessTitle')} description={what} />
      <p>
        <Link href="/">{t('common.goHome')}</Link>
      </p>
    </>
  );
}
