import type { SamlIdpDTO } from '@rd/contracts';

const DAY = 86_400_000;

/** The provider's signing certificate that expires first, when that's within `days` (or already past). */
export function certificateWarning(saml: SamlIdpDTO | null, now: Date, days = 30): { subject: string; expires_at: string; expired: boolean } | null {
  const soonest = [...(saml?.certificates ?? [])].sort((a, b) => a.expires_at.localeCompare(b.expires_at))[0];
  if (!soonest) return null;
  const left = new Date(soonest.expires_at).getTime() - now.getTime();
  // A rolled certificate sits next to its replacement: only warn when nothing outlives the window.
  const outlived = saml!.certificates.some((c) => new Date(c.expires_at).getTime() - now.getTime() > days * DAY);
  if (left > days * DAY || outlived) return null;
  return { ...soonest, expired: left <= 0 };
}

/** Whether the by-hand SAML fields are enough to save. */
export const samlManualReady = (f: { idp_entity_id: string; sso_url: string; certificate: string }) =>
  Boolean(f.idp_entity_id.trim() && /^https?:\/\//.test(f.sso_url.trim()) && f.certificate.trim());
