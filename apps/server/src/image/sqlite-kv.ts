import type BetterSqlite3 from 'better-sqlite3';

// SQLite-backed replacement for the KV namespace that memoised compressed
// WebP results. Same contract the Cloudflare path uses (content-addressed key
// in, bytes out) but stored in a server-owned table. This table is NOT part of
// the apps/api migration set — it is created here so the server runtime stays
// fully self-contained and additive.
export class SqliteImageCache {
  private readonly getStmt: BetterSqlite3.Statement;
  private readonly putStmt: BetterSqlite3.Statement;
  private readonly pruneStmt: BetterSqlite3.Statement;

  constructor(private readonly db: BetterSqlite3.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS image_cache (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    this.getStmt = db.prepare('SELECT value FROM image_cache WHERE key = ? AND expires_at > ?');
    this.putStmt = db.prepare(
      `INSERT INTO image_cache (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    );
    this.pruneStmt = db.prepare('DELETE FROM image_cache WHERE expires_at <= ?');
  }

  get(key: string, now: number): Uint8Array | null {
    const row = this.getStmt.get(key, now) as { value: Buffer } | undefined;
    return row ? new Uint8Array(row.value) : null;
  }

  put(key: string, value: Uint8Array, ttlSeconds: number, now: number): void {
    this.putStmt.run(key, Buffer.from(value), now + ttlSeconds * 1000);
  }

  // Called from the hourly cron to bound storage; lazy expiry on read already
  // prevents stale hits, this just reclaims disk.
  pruneExpired(now: number): void {
    this.pruneStmt.run(now);
  }
}
