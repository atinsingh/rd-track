import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import s from './ui.module.css';

interface FieldChrome {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
}

function useFieldIds(id?: string) {
  const auto = useId();
  const fid = id ?? auto;
  return { fid, hintId: `${fid}-hint`, errId: `${fid}-err` };
}

function describedBy(hint: unknown, error: unknown, hintId: string, errId: string): string | undefined {
  const ids = [hint ? hintId : null, error ? errId : null].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

export function TextField({ label, hint, error, className, id, ...rest }: FieldChrome & InputHTMLAttributes<HTMLInputElement>) {
  const { fid, hintId, errId } = useFieldIds(id);
  return (
    <div className={cx(s.field, className)}>
      <label htmlFor={fid} className={s.fieldLabel}>
        {label}
      </label>
      <input
        id={fid}
        className={s.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errId)}
        {...rest}
      />
      {hint ? (
        <span id={hintId} className={s.fieldHint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errId} className={s.fieldError}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  className,
  id,
  children,
  ...rest
}: FieldChrome & SelectHTMLAttributes<HTMLSelectElement>) {
  const { fid, hintId, errId } = useFieldIds(id);
  return (
    <div className={cx(s.field, className)}>
      <label htmlFor={fid} className={s.fieldLabel}>
        {label}
      </label>
      <select
        id={fid}
        className={s.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errId)}
        {...rest}
      >
        {children}
      </select>
      {hint ? (
        <span id={hintId} className={s.fieldHint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errId} className={s.fieldError}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextArea({
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: FieldChrome & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { fid, hintId, errId } = useFieldIds(id);
  return (
    <div className={cx(s.field, className)}>
      <label htmlFor={fid} className={s.fieldLabel}>
        {label}
      </label>
      <textarea
        id={fid}
        className={s.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errId)}
        {...rest}
      />
      {hint ? (
        <span id={hintId} className={s.fieldHint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errId} className={s.fieldError}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function Checkbox({
  label,
  hint,
  className,
  id,
  ...rest
}: { label: ReactNode; hint?: ReactNode; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const { fid, hintId } = useFieldIds(id);
  return (
    <div className={cx(s.check, className)}>
      <input id={fid} type="checkbox" aria-describedby={hint ? hintId : undefined} {...rest} />
      <span>
        <label htmlFor={fid} className={s.fieldLabel}>
          {label}
        </label>
        {hint ? (
          <span id={hintId} className={s.fieldHint} style={{ display: 'block' }}>
            {hint}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Compact "Label [select]" control used in page headers. */
export function InlineSelect({ label, id, children, ...rest }: { label: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <span className={s.inline}>
      <label htmlFor={fid}>{label}</label>
      <select id={fid} {...rest}>
        {children}
      </select>
    </span>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** Radio group drawn as square segments (native radios: arrow keys work). */
export function Segmented<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  disabled,
  describedBy: descBy,
}: {
  legend: string;
  name: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <fieldset className={s.segmented} disabled={disabled} aria-describedby={descBy}>
      <legend className="visually-hidden">{legend}</legend>
      <div className={s.segments}>
        {options.map((o) => (
          <label key={o.value} className={s.segment}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export const inputClass = s.input;
