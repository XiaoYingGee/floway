import { openDatabase, resolveDbPath } from './db.ts';
import { runMigrations } from './migrate.ts';

// Standalone migration command (`pnpm migrate`). The server also migrates on
// boot; this exists for ops workflows that want to apply schema separately.
const db = openDatabase();
const applied = runMigrations(db);
db.close();

if (applied.length === 0) {
  console.log(`No pending migrations. Database up to date at ${resolveDbPath()}`);
} else {
  console.log(`Applied ${applied.length} migration(s) to ${resolveDbPath()}:`);
  for (const name of applied) console.log(`  - ${name}`);
}
