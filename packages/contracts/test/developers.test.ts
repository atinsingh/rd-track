import { describe, expect, it } from 'vitest';
import { apiTokenRequest } from '../src/developers';

describe('API token requests', () => {
  it('organization tokens need read, last up to a year', () => {
    expect(apiTokenRequest.safeParse({ name: 'BI', kind: 'organization', scopes: ['read', 'payroll'], expires_in_days: 365 }).success).toBe(true);
    expect(apiTokenRequest.safeParse({ name: 'BI', kind: 'organization', scopes: ['write'], expires_in_days: 30 }).success).toBe(false);
    expect(apiTokenRequest.safeParse({ name: 'BI', kind: 'organization', scopes: ['read'], expires_in_days: 366 }).success).toBe(false);
  });
  it('personal tokens are read-only, up to 90 days', () => {
    expect(apiTokenRequest.safeParse({ name: 'Me', kind: 'personal', expires_in_days: 90 }).success).toBe(true);
    expect(apiTokenRequest.safeParse({ name: 'Me', kind: 'personal', expires_in_days: 91 }).success).toBe(false);
    expect(apiTokenRequest.safeParse({ name: 'Me', kind: 'personal', scopes: ['read', 'write'], expires_in_days: 30 }).success).toBe(false);
  });
});
