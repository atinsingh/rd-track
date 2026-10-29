import type { OrgRole, UserImportRow } from '@rd/contracts';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const HEADERS: Record<string, keyof UserImportRow> = {
  email: 'email',
  'e-mail': 'email',
  'work email': 'email',
  name: 'display_name',
  'full name': 'display_name',
  display_name: 'display_name',
  role: 'org_role',
  org_role: 'org_role',
  timezone: 'timezone',
  'time zone': 'timezone',
  time_zone: 'timezone',
  tracks: 'tracking_enabled',
  'tracks time': 'tracking_enabled',
  tracking: 'tracking_enabled',
  tracking_enabled: 'tracking_enabled',
  team: 'team',
};

const ROLES: Record<string, OrgRole> = {
  employee: 'employee',
  admin: 'org_admin',
  'org admin': 'org_admin',
  org_admin: 'org_admin',
  auditor: 'auditor',
  finance: 'finance',
};

export const IMPORT_TEMPLATE = 'email,name,role,timezone,tracks time,team\nana@example.com,Ana Silva,employee,Europe/Lisbon,yes,Design\n';

/**
 * Turns a CSV of people into import rows. The first line names the columns (email and
 * name are required; role, time zone, tracks time and team are optional). Values the
 * server would reject are passed through as-is so the dry run explains them per row.
 */
export function rowsFromCsv(text: string, defaultTz: string): { rows: Record<string, unknown>[]; problem: string | null } {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], problem: 'Add a header line and at least one person.' };
  const keys = table[0]!.map((h) => HEADERS[h.trim().toLowerCase()] ?? null);
  if (!keys.includes('email') || !keys.includes('display_name')) return { rows: [], problem: 'The first line needs an "email" and a "name" column.' };
  const rows = table.slice(1).map((cells) => {
    const r: Record<string, unknown> = { timezone: defaultTz };
    keys.forEach((k, i) => {
      const v = (cells[i] ?? '').trim();
      if (!k || v === '') return;
      if (k === 'org_role') r[k] = ROLES[v.toLowerCase()] ?? v;
      else if (k === 'tracking_enabled') r[k] = /^(yes|y|true|1|on)$/i.test(v) ? true : /^(no|n|false|0|off)$/i.test(v) ? false : v;
      else r[k] = v;
    });
    return r;
  });
  return { rows, problem: null };
}
