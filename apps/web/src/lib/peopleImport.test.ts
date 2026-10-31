import { describe, expect, it } from 'vitest';
import { IMPORT_TEMPLATE, parseCsv, rowsFromCsv } from './peopleImport';

describe('people CSV import', () => {
  it('parses quoted fields, doubled quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,"b, c","say ""hi"""\r\n1,2,3\r\n\r\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('maps friendly headers and values to import rows, leaving bad values for the server to explain', () => {
    const { rows, problem } = rowsFromCsv('Email,Full name,Role,Tracks time,Team\nana@x.com,Ana,Admin,no,Design\nben@x.com,Ben,boss,maybe,\n', 'UTC');
    expect(problem).toBeNull();
    expect(rows).toEqual([
      { email: 'ana@x.com', display_name: 'Ana', org_role: 'org_admin', tracking_enabled: false, team: 'Design', timezone: 'UTC' },
      { email: 'ben@x.com', display_name: 'Ben', org_role: 'boss', tracking_enabled: 'maybe', timezone: 'UTC' },
    ]);
  });

  it('needs email and name columns', () => {
    expect(rowsFromCsv('email\nx@y.z\n', 'UTC').problem).toMatch(/name/);
    expect(rowsFromCsv('email,name\n', 'UTC').problem).toMatch(/at least one/);
    expect(rowsFromCsv(IMPORT_TEMPLATE, 'UTC').rows).toHaveLength(1);
  });
});
