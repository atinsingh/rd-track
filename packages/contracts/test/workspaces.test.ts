import { describe, expect, it } from 'vitest';
import { enrollmentLink } from '../src/workspaces';

describe('enrollment links', () => {
  it('encodes the server and code the way the desktop app parses them (agent link.rs)', () => {
    expect(enrollmentLink('https://track.acme.com', 'ABCD-EFGH')).toBe('rdtrack://enroll?server=https%3A%2F%2Ftrack.acme.com&code=ABCD-EFGH');
    expect(enrollmentLink('http://localhost:3100', 'X1')).toBe('rdtrack://enroll?server=http%3A%2F%2Flocalhost%3A3100&code=X1');
  });
});
