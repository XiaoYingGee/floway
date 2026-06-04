import type BetterSqlite3 from 'better-sqlite3';

// Mirrors the minimal D1 surface that apps/api/src/repo/d1.ts hand-types and
// consumes. We re-declare it here (rather than import) so this adapter stays a
// pure additive sibling that never edits the upstream tree. The shapes must
// stay structurally compatible with that file's D1Database/D1PreparedStatement.
interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

// The value types better-sqlite3 accepts as a bound parameter.
type SqliteBindValue = number | string | bigint | Buffer | null;

// better-sqlite3 only binds numbers, strings, bigints, buffers and null. D1
// (and thus the calling code) is laxer: it passes booleans and may pass
// undefined. Normalise each bound value so the upstream SQL — unchanged —
// keeps working: undefined → null, boolean → 0/1, Uint8Array → Buffer.
const sanitizeBindValue = (value: unknown): SqliteBindValue => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return Buffer.isBuffer(value) ? value : Buffer.from(value);
  return value as SqliteBindValue;
};

class SqlitePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly stmt: BetterSqlite3.Statement,
    private readonly args: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqlitePreparedStatement(this.stmt, values.map(sanitizeBindValue));
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.stmt.get(...this.args) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return { results: this.stmt.all(...this.args) as T[], success: true, meta: {} };
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  // Synchronous variant used inside batch()'s transaction, where every
  // statement must execute within the same synchronous better-sqlite3 txn.
  runSync(): D1Result {
    const info = this.stmt.run(...this.args);
    return {
      results: [],
      success: true,
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
    };
  }
}

export class SqliteD1 implements D1Database {
  // Compiled-statement cache: D1Repo re-prepares the same SQL on every call,
  // so memoising the compiled Statement avoids recompiling hot queries. Safe
  // because better-sqlite3 is fully synchronous — no statement is mid-iteration
  // when the next call reuses it.
  private readonly stmtCache = new Map<string, BetterSqlite3.Statement>();

  constructor(private readonly db: BetterSqlite3.Database) {}

  prepare(query: string): D1PreparedStatement {
    let stmt = this.stmtCache.get(query);
    if (!stmt) {
      stmt = this.db.prepare(query);
      this.stmtCache.set(query, stmt);
    }
    return new SqlitePreparedStatement(stmt);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const run = this.db.transaction((stmts: SqlitePreparedStatement[]) =>
      stmts.map(stmt => stmt.runSync()));
    return run(statements as SqlitePreparedStatement[]);
  }
}
