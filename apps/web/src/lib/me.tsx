'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Me } from '@rd/contracts';
import { accessFor, type Access } from './nav';
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
