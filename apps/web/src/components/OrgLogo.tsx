import { cx } from '@/lib/cx';
import s from './orgLogo.module.css';

/**
 * The organization's own logo (G26), on a light chip so dark logos stay readable on the
 * ink rail. The link is short-lived and private, so it is a plain image, not next/image.
 */
export function OrgLogo({ url, name, className, plain }: { url: string | null; name: string; className?: string; plain?: boolean }) {
  if (!url) return null;
  return (
    <span className={cx(plain ? s.plain : s.chip, className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={name} className={s.img} />
    </span>
  );
}
