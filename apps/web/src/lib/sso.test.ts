import { describe, expect, it } from 'vitest';
import { certificateWarning, samlManualReady } from './sso';

const now = new Date('2026-10-29T12:00:00Z');
const cert = (expires_at: string) => ({ subject: 'CN=idp', expires_at });

describe('certificateWarning', () => {
  it('warns about a certificate expiring soon, or already expired', () => {
    expect(certificateWarning({ entity_id: 'e', sso_url: 'u', certificates: [cert('2027-06-01T00:00:00Z')] }, now)).toBeNull();
    expect(certificateWarning({ entity_id: 'e', sso_url: 'u', certificates: [cert('2026-11-10T00:00:00Z')] }, now)).toMatchObject({ expired: false });
    expect(certificateWarning({ entity_id: 'e', sso_url: 'u', certificates: [cert('2026-10-01T00:00:00Z')] }, now)).toMatchObject({ expired: true });
    expect(certificateWarning(null, now)).toBeNull();
  });

  it('stays quiet while a replacement is already in place', () => {
    expect(certificateWarning({ entity_id: 'e', sso_url: 'u', certificates: [cert('2026-11-10T00:00:00Z'), cert('2029-01-01T00:00:00Z')] }, now)).toBeNull();
  });
});

describe('samlManualReady', () => {
  it('needs all three values and a URL', () => {
    expect(samlManualReady({ idp_entity_id: 'https://idp', sso_url: 'https://idp/sso', certificate: 'MII' })).toBe(true);
    expect(samlManualReady({ idp_entity_id: 'https://idp', sso_url: 'idp/sso', certificate: 'MII' })).toBe(false);
    expect(samlManualReady({ idp_entity_id: '', sso_url: 'https://idp/sso', certificate: 'MII' })).toBe(false);
  });
});
