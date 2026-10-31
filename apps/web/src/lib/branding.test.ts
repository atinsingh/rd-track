import { describe, expect, it } from 'vitest';
import { deploymentJson, logoProblem, macosScript, windowsScript } from './branding';

describe('logo and deployment files (G26)', () => {
  it('accepts small PNG, JPEG and WebP logos only', () => {
    expect(logoProblem({ type: 'image/png', size: 10_000 })).toBeNull();
    expect(logoProblem({ type: 'image/svg+xml', size: 100 })).toMatch(/PNG/);
    expect(logoProblem({ type: 'image/webp', size: 600 * 1024 })).toMatch(/512 KB/);
  });

  it('writes the same deployment file from every script', () => {
    const json = deploymentJson('https://track.acme.com', 'rddk_abc');
    expect(JSON.parse(json)).toEqual({ server: 'https://track.acme.com', deployment_key: 'rddk_abc' });
    expect(macosScript('https://track.acme.com', 'rddk_abc')).toContain(json.trimEnd());
    expect(macosScript('https://track.acme.com', 'rddk_abc')).toContain('/Library/Application Support/RoundDigital Track');
    const ps = windowsScript('https://track.acme.com', 'rddk_abc');
    expect(ps).toContain('"deployment_key": "rddk_abc"');
    expect(ps).toContain("Join-Path $env:ProgramData 'RoundDigital Track'");
  });
});
