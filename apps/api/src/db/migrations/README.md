# Migrations

Numbered SQL files, applied once each in order by `src/db/migrate.ts` (one transaction per file).

Since `003_row_level_security.sql`, every tenant table has **FORCE**d row-level security,
which also applies to the table owner that runs migrations. A migration that reads or
writes tenant rows must first run `SELECT set_config('rd.org_id', '*', true);`
(system scope for that transaction), or it will see and change nothing.

New tenant tables need `organization_id`, `ENABLE`/`FORCE ROW LEVEL SECURITY` and a
`tenant_isolation` policy using `rd_org_visible(organization_id)` — plus a test in
`test/rls.test.ts`.
