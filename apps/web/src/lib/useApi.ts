'use client';

import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { toApiError, type ApiError } from './api';

interface State<T> {
  key: string | null;
  nonce: number;
  data?: T;
  error?: ApiError;
}

export interface ApiResource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** true while the current key (or a reload) is in flight */
  loading: boolean;
  reload: () => void;
  /** local update after a mutation */
  mutate: (fn: (prev: T | undefined) => T | undefined) => void;
}

/**
 * Minimal client-side fetching hook. `key` identifies the resource (null = skip);
 * changing it refetches. Data for a different key is never shown.
 */
export function useApi<T>(key: string | null, loader: (signal: AbortSignal) => Promise<T>): ApiResource<T> {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<State<T>>({ key: null, nonce: -1 });
  const load = useEffectEvent(loader);

  useEffect(() => {
    if (key === null) return;
    const ac = new AbortController();
    load(ac.signal).then(
      (data) => {
        if (!ac.signal.aborted) setState({ key, nonce, data });
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setState({ key, nonce, error: toApiError(e) });
      },
    );
    return () => ac.abort();
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const mutate = useCallback(
    (fn: (prev: T | undefined) => T | undefined) => setState((s) => ({ ...s, data: fn(s.data) })),
    [],
  );

  const sameKey = key !== null && state.key === key;
  return {
    data: sameKey ? state.data : undefined,
    error: sameKey && state.nonce === nonce ? state.error : undefined,
    loading: key !== null && (!sameKey || state.nonce !== nonce),
    reload,
    mutate,
  };
}

/** State for one mutation: busy flag and last error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(toApiError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const reset = useCallback(() => setError(null), []);
  return { busy, error, run, reset, setError };
}
