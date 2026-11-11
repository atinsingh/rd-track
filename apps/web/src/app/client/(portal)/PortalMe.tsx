'use client';

import { createContext, useContext } from 'react';
import type { ClientPortalMe } from '@rd/contracts';

/** Who is signed in to the client portal, for its pages. */
export const PortalMe = createContext<ClientPortalMe | null>(null);
export const usePortalMe = () => useContext(PortalMe)!;
