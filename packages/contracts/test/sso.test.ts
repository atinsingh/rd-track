import { describe, expect, it } from 'vitest';
import { ssoDiscoverRequest, ssoDomainRequest } from '../src/sso';

describe('single sign-on inputs', () => {
  it('takes a bare domain, lower-cased', () => {
    expect(ssoDomainRequest.parse({ domain: ' Example.COM ' })).toEqual({ domain: 'example.com' });
    expect(ssoDomainRequest.parse({ domain: 'mail.example.co.uk' }).domain).toBe('mail.example.co.uk');
    for (const domain of ['https://example.com', '*.example.com', 'example', 'exa mple.com', 'example.com/path', '-x.example.com']) {
      expect(ssoDomainRequest.safeParse({ domain }).success, domain).toBe(false);
    }
  });

  it('only returns to a path inside the app', () => {
    expect(ssoDiscoverRequest.safeParse({ email: 'a@b.co', return_to: '/me' }).success).toBe(true);
    for (const return_to of ['//evil.example', '/\\evil.example', 'https://evil.example', 'me', '/a b']) {
      expect(ssoDiscoverRequest.safeParse({ email: 'a@b.co', return_to }).success, return_to).toBe(false);
    }
  });
});
