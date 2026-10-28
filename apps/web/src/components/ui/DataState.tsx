import type { ReactNode } from 'react';
import { describeError, type ApiError } from '@/lib/api';
import { Button } from './Button';
import s from './ui.module.css';

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className={s.state} role="status" aria-live="polite">
      <span className={s.loadingBar} aria-hidden="true" />
      <span className="small">{label}…</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, title }: { error: ApiError; onRetry?: () => void; title?: string }) {
  return (
    <div className={s.state} role="alert">
      <span className={s.stateTitle}>{title ?? "Couldn't load this"}</span>
      <span>{describeError(error)}</span>
      {error.requestId ? <span className={s.requestId}>Request ID {error.requestId}</span> : null}
      {onRetry ? (
        <Button size="sm" variant="quiet" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={s.state}>
      <span className={s.stateTitle}>{title}</span>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

/** Inline error after a failed action (form submit, button). */
export function ActionError({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null;
  return (
    <p role="alert" className={s.fieldError}>
      {describeError(error)}
      {error.requestId ? <span className={s.requestId}> · Request ID {error.requestId}</span> : null}
    </p>
  );
}

/** Loading / error / content switch for a `useApi` resource. */
export function Resource<T>({
  data,
  error,
  loading,
  reload,
  label,
  children,
}: {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload?: () => void;
  label?: string;
  children: (data: T) => ReactNode;
}) {
  if (data !== undefined) return <>{children(data)}</>;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <Loading label={label} />;
  return null;
}
