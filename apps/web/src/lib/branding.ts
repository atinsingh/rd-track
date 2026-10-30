import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES, type DeploymentFile } from '@rd/contracts';
import { t } from './i18n';

/** Why a logo file can't be used, or null (G26). */
export function logoProblem(file: { type: string; size: number }): string | null {
  if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) return t('cfg.brand.wrongType');
  if (file.size > LOGO_MAX_BYTES) return t('cfg.brand.tooBig');
  return null;
}

/** Where the desktop app looks for the deployment file on each system. */
export const DEPLOYMENT_FILE_PATHS = {
  macos: '/Library/Application Support/RoundDigital Track/deployment.json',
  windows: 'C:\\ProgramData\\RoundDigital Track\\deployment.json',
} as const;

export function deploymentJson(server: string, key: string): string {
  const f: DeploymentFile = { server, deployment_key: key };
  return `${JSON.stringify(f, null, 2)}\n`;
}

/** A script for Jamf, Kandji or Intune for macOS: writes the deployment file (the app itself is a separate package). */
export function macosScript(server: string, key: string): string {
  return [
    '#!/bin/sh',
    '# RoundDigital Track: tells the app which organization this Mac belongs to.',
    '# Run as root after installing the app. People still connect with their own work email.',
    'set -e',
    `DIR="/Library/Application Support/RoundDigital Track"`,
    'mkdir -p "$DIR"',
    `cat > "$DIR/deployment.json" <<'JSON'`,
    deploymentJson(server, key).trimEnd(),
    'JSON',
    'chmod 644 "$DIR/deployment.json"',
    '',
  ].join('\n');
}

/** A PowerShell script for Intune or GPO: installs the MSI quietly and writes the deployment file. */
export function windowsScript(server: string, key: string): string {
  const json = deploymentJson(server, key).trimEnd().replace(/'/g, "''");
  return [
    '# RoundDigital Track: installs the app and tells it which organization this PC belongs to.',
    '# Run as SYSTEM, with the MSI next to this script. People still connect with their own work email.',
    "$ErrorActionPreference = 'Stop'",
    '$msi = Get-ChildItem -Path $PSScriptRoot -Filter "RoundDigital*Track_*_x64_en-US.msi" | Select-Object -First 1',
    'if ($msi) { Start-Process msiexec.exe -ArgumentList "/i `"$($msi.FullName)`" /qn /norestart" -Wait }',
    "$dir = Join-Path $env:ProgramData 'RoundDigital Track'",
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    `Set-Content -Path (Join-Path $dir 'deployment.json') -Encoding UTF8 -Value '${json}'`,
    '',
  ].join('\r\n');
}
