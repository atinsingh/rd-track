'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { Me } from '@rd/contracts';
import { accessFor, type Access } from './nav';
import { announceLocale, resolveLocale, setLocale } from './locale';
import { browserTimeZone, isValidTimeZone } from './time';

export interface MeContextValue {
  me: Me;
  access: Access;
  /** the user's profile time zone, falling back to the browser's */
  timezone: string;
  reload: () => void;
}

const MeContext = createContext<MeContextValue | null>(null);

export function MeProvider({ me, reload, children }: { me: Me; reload: () => void; children: ReactNode }) {
  // Before anything below renders, so every label and date is in the person's language (G27).
  const locale = resolveLocale(me.user.locale, me.organization.locale);
  setLocale(locale, false);
  useEffect(() => announceLocale(), [locale]);
  const value = useMemo<MeContextValue>(
    () => ({
      me,
      access: accessFor(me),
      timezone: me.user.timezone && isValidTimeZone(me.user.timezone) ? me.user.timezone : browserTimeZone(),
      reload,
    }),
    [me, reload],
  );
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): MeContextValue {
  const v = useContext(MeContext);
  if (!v) throw new Error('useMe must be used inside the signed-in app shell');
  return v;
}
