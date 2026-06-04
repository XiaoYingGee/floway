import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';

import { MIGRATIONS_DIR } from '../paths.ts';

// Tracks which migration filenames have been applied. Named distinctly from
// D1/wrangler's own d1_migrations table to avoid any collision.
const LEDGER_TABLE = '_server_migrations';

export const runMigrations = (db: BetterSqlite3.Database): string[] => {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const applied = new Set(
    db.prepare(`SELECT name FROM ${LEDGER_TABLE}`).all().map(row => (row as { name: string }).name),
  );

  // Lexicographic sort is deterministic and matches wrangler's ordering, which
  // matters because some numeric prefixes repeat (two 0011_* files exist).
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const newlyApplied: string[] = [];
  const record = db.prepare(`INSERT INTO ${LEDGER_TABLE} (name, applied_at) VALUES (?, ?)`);

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const appliedAt = new Date().toISOString();
    // Each file may hold several statements; db.exec runs them all. Wrap the
    // file plus its ledger write in one transaction so a failure leaves no
    // partially-applied migration recorded.
    db.transaction(() => {
      db.exec(sql);
      record.run(file, appliedAt);
    })();
    newlyApplied.push(file);
  }

  return newlyApplied;
};
