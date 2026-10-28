import { migrate } from './migrate';

// Separate entry point: a "run if main" check inside migrate.ts would also fire when bundled into main.js.
const url = process.env.DATABASE_URL ?? 'postgres://rd:rd@localhost:5432/rd_track';
migrate(url).then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
