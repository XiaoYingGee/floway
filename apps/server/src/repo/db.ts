import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

// Resolve the on-disk SQLite location from the environment. DB_PATH wins; else
// it lives under DATA_DIR (which also holds spilled payload files). Both the
// CLI migrator and the server entry call this so they share one file.
export const resolveDbPath = (): string => {
  const explicit = process.env.DB_PATH?.trim();
  if (explicit) return resolve(explicit);
  const dataDir = process.env.DATA_DIR?.trim() || './data';
  return resolve(dataDir, 'floway.db');
};

// Open (creating parent dirs as needed) a SQLite connection tuned for a
// long-lived server: WAL for concurrent readers, a busy timeout so brief write
// contention retries instead of throwing, and foreign keys on to match D1.
export const openDatabase = (dbPath = resolveDbPath()): Database.Database => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
};
