import { describe, expect, it } from 'vitest';
import type { DirectoryResponse, Me } from '@rd/contracts';
import { accessFor, navFor } from './nav';
import { paletteItems, searchPalette } from './palette';

const me = (over: Partial<Me['user']> = {}, teams: string[] = [], entitlements: Me['entitlements'] = []): Me => ({
  user: { id: 'u', email: 'e', display_name: 'D', org_role: 'employee', timezone: 'UTC', tracking_enabled: true, mfa_enabled: false, ...over },
  organization: { id: 'o', name: 'Org', plan: 'pro', license: 'active' },
  mfa_verified: false,
  managed_team_ids: teams,
  managed_project_ids: [],
  entitlements,
});

const directory: DirectoryResponse = {
  people: [
    { user_id: 'p1', display_name: 'Sam Ortiz', team_id: 't1', team_name: 'Platform' },
    { user_id: 'p2', display_name: 'José Álvarez', team_id: 't1', team_name: 'Platform' },
  ],
  projects: [{ id: 'j1', name: 'Website relaunch' }],
};

describe('command palette', () => {
  const items = paletteItems(navFor(accessFor(me({}, ['t1']))), directory);
  const labels = (q: string) => searchPalette(items, q).map((i) => i.label);

  it('lists only pages the user can open, with people and projects they manage', () => {
    expect(items.filter((i) => i.kind === 'page').map((i) => i.href)).toContain('/approvals');
    expect(items.some((i) => i.href.startsWith('/admin'))).toBe(false);
    expect(items.find((i) => i.kind === 'person')).toMatchObject({ label: 'Sam Ortiz', hint: 'Platform', href: '/team/p1?team=t1&name=Sam+Ortiz' });
    expect(items.find((i) => i.kind === 'project')?.href).toBe('/projects?project=j1');
  });
  it('shows the pages when nothing is typed', () => {
    expect(labels('')[0]).toBe('My day');
    expect(searchPalette(items, '  ').every((i) => i.kind === 'page')).toBe(true);
  });
  it('ranks label starts above word starts and keywords', () => {
    expect(labels('in')[0]).toBe('Insights');
    // "timeline" is a keyword of My day, so it comes after a label match.
    expect(labels('time').slice(0, 2)).toEqual(['My time', 'My day']);
    expect(labels('my t')[0]).toBe('My time');
    expect(labels('sam')).toEqual(['Sam Ortiz']);
    expect(labels('ortiz')).toEqual(['Sam Ortiz']);
    // "inbox" is a keyword of Approvals.
    expect(labels('inbox')).toEqual(['Approvals']);
  });
  it('ignores accents and case, and needs every word', () => {
    expect(labels('jose alv')).toEqual(['José Álvarez']);
    expect(labels('SAM web')).toEqual([]);
  });
  it('caps each kind', () => {
    expect(searchPalette(items, 'a', 1).filter((i) => i.kind === 'page')).toHaveLength(1);
  });
});
