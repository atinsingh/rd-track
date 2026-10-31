'use client';

import { useRouter } from 'next/navigation';
import { ChildForm } from '@/components/family/ChildBits';
import { Card, PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { announceFamilyChanged } from '@/lib/events';
import { useT } from '@/lib/i18n';

export default function NewChild() {
  const t = useT();
  const router = useRouter();
  return (
    <>
      <PageHeader eyebrow={t('fam.nav.group')} title={t('fam.child.addTitle')} description={t('fam.child.addDescription')} />
      <Card>
        <ChildForm
          submitLabel={t('fam.child.add')}
          busyLabel={t('fam.child.adding')}
          cancelHref="/family"
          onSubmit={async (input) => {
            const c = await rd.family.addChild(input);
            announceFamilyChanged();
            router.push(`/family/children/${c.id}`);
          }}
        />
      </Card>
    </>
  );
}
