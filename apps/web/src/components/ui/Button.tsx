import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import s from './ui.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'inverse' | 'link' | 'monoLink';

const VARIANT: Record<ButtonVariant, string | undefined> = {
  primary: s.primary,
  secondary: s.secondary,
  quiet: s.quiet,
  danger: s.danger,
  inverse: s.inverse,
  link: s.linkBtn,
  monoLink: s.monoLink,
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: 'md' | 'sm' = 'md', extra?: string): string {
  return cx(s.btn, VARIANT[variant], size === 'sm' && s.sm, extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
}

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  children: ReactNode;
}

export function ButtonLink({ href, variant = 'secondary', size = 'md', className, ...rest }: ButtonLinkProps) {
  return <Link href={href} className={buttonClass(variant, size, className)} {...rest} />;
}
