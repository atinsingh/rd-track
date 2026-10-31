'use client';

import { RulesForm } from '@/components/family/RulesForm';
import { Resource } from '@/components/ui/DataState';
import { PageHeader } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useApi } from '@/lib/useApi';

/** The family's rules: what every child gets unless a rule is set for them. */
export default function FamilyRulesPage() {
  const t = useT();
  const rules = useApi('family:rules', (signal) => rd.family.rules(signal));
  return (
    <>
      <PageHeader eyebrow={t('fam.nav.group')} title={t('fam.rules.title')} description={t('fam.rules.description')} />
      <Resource {...rules} label={t('fam.rules.loading')}>
        {(dto) => <RulesForm key={dto.revision} dto={dto} save={(doc) => rd.family.setRules(doc)} />}
      </Resource>
    </>
  );
}
