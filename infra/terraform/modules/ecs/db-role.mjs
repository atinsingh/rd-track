// Ensures the least-privilege application role exists and can use every object in
// schema public. Run by the `migrate` task (as the schema owner) before and after
// migrations; idempotent. Passed to `node --input-type=module -e` from the task
// definition, so it may only import what the API image ships (`pg`).
//
//   DATABASE_URL     owner connection (MIGRATION_DATABASE_URL secret)
//   APP_DB_ROLE      role name, e.g. rd_app
//   APP_DB_PASSWORD  its password (APP_DB_PASSWORD secret)
//
// The role is created without SUPERUSER / BYPASSRLS (the defaults) so row-level
// security applies; the check at the end refuses to continue if that ever changes.
import pg from 'pg';

const role = process.env.APP_DB_ROLE;
const password = process.env.APP_DB_PASSWORD;
if (!role || !password) throw new Error('APP_DB_ROLE and APP_DB_PASSWORD are required');

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  const r = c.escapeIdentifier(role);
  const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) await c.query(`CREATE ROLE ${r} LOGIN`);
  try {
    await c.query(`ALTER ROLE ${r} WITH LOGIN PASSWORD ${c.escapeLiteral(password)}`);
  } catch (err) {
    if (err.code === '42501') {
      throw new Error(
        `${role} exists but this user may not alter it (it was created by another role). ` +
          `As its creator run: GRANT ${role} TO <migration user> WITH ADMIN OPTION, or drop it.`,
        { cause: err },
      );
    }
    throw err;
  }

  const db = (await c.query('SELECT current_database() AS d')).rows[0].d;
  const statements = [
    `GRANT CONNECT ON DATABASE ${c.escapeIdentifier(db)} TO ${r}`,
    `GRANT USAGE ON SCHEMA public TO ${r}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${r}`,
    // Objects the owner (this connection's user) creates later are covered too.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${r}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${r}`,
  ];
  for (const sql of statements) await c.query(sql);

  const attrs = (await c.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [role])).rows[0];
  if (attrs.rolsuper || attrs.rolbypassrls) throw new Error(`${role} must not be SUPERUSER or BYPASSRLS (RLS would not apply)`);
  const owned = await c.query(
    `SELECT count(*)::int AS n FROM pg_class cl JOIN pg_roles ro ON ro.oid = cl.relowner WHERE ro.rolname = $1`,
    [role],
  );
  if (owned.rows[0].n > 0) throw new Error(`${role} owns ${owned.rows[0].n} relations; table owners bypass non-FORCEd RLS`);
  console.log(JSON.stringify({ msg: 'app db role ready', role }));
} finally {
  await c.end();
}
