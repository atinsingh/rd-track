'use client';

import { useState } from 'react';
import { FAMILY_RULE_DEFAULTS, type FamilyRules, type FamilyRulesDTO, type PartialFamilyRules } from '@rd/contracts';
import { Button } from '@/components/ui/Button';
import { ActionError } from '@/components/ui/DataState';
import { sameDoc } from '@/lib/family';
import { useT } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { useAction } from '@/lib/useApi';
import { RulesEditor } from './RulesEditor';
import s from './family.module.css';

/**
 * The editor with its save bar: one Save puts the whole document. For a child, `base` is the
 * family's rules (what a field follows until it's set for the child).
 */
export function RulesForm({
  dto,
  base = FAMILY_RULE_DEFAULTS,
  childName,
  save,
  onSaved,
}: {
  dto: FamilyRulesDTO;
  base?: FamilyRules;
  childName?: string;
  save: (doc: PartialFamilyRules) => Promise<FamilyRulesDTO>;
  onSaved?: (dto: FamilyRulesDTO) => void;
}) {
  const t = useT();
  const { timezone } = useMe();
  const [saved, setSaved] = useState<PartialFamilyRules>(dto.document);
  const [doc, setDoc] = useState<PartialFamilyRules>(dto.document);
  const [justSaved, setJustSaved] = useState(false);
  const action = useAction();
  const dirty = !sameDoc(doc, saved);
  const submit = async () => {
    const r = await action.run(() => save(doc));
    if (r) {
      setSaved(r.document);
      setDoc(r.document);
      setJustSaved(true);
      onSaved?.(r);
    }
  };
  return (
    <>
      <RulesEditor
        doc={doc}
        base={base}
        mode={dto.child_id ? 'child' : 'family'}
        childName={childName}
        tz={timezone}
        disabled={action.busy}
        onChange={(d) => {
          setDoc(d);
          setJustSaved(false);
        }}
      />
      <div className={s.saveBar} role="region" aria-label={t('fam.rules.saveRegion')}>
        <p className="small" role="status">
          {dirty
            ? t('fam.rules.unsaved')
            : justSaved
              ? childName
                ? t('fam.rules.savedChild', { name: childName })
                : t('fam.rules.savedFamily')
              : t('fam.rules.upToDate')}
        </p>
        <ActionError error={action.error} />
        <div className={s.formButtons}>
          <Button variant="quiet" disabled={!dirty || action.busy} onClick={() => setDoc(saved)}>
            {t('fam.rules.discard')}
          </Button>
          <Button variant="primary" disabled={!dirty || action.busy} onClick={submit}>
            {action.busy ? t('common.saving') : t('fam.rules.save')}
          </Button>
        </div>
      </div>
    </>
  );
}
