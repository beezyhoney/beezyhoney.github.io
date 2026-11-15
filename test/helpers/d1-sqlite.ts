// A small Cloudflare D1-compatible shim over Node's built-in node:sqlite, for unit tests of SQL logic
// without Miniflare. Real D1 / Miniflare integration tests come later; this mimics the parts of the D1
// Worker API the server code uses:
//   db.prepare(sql).bind(...values).first(col?) / .all() / .run() / .raw({ columnNames? })
//   db.batch([stmts])  → one transaction; any error rolls the whole batch back and is rethrown
//   db.exec(sql)       → { count, duration }
// D1 rules copied on purpose so tests catch the same mistakes D1 would:
//   - only ordered (?NNN) and anonymous (?) parameters; `undefined` cannot be bound (D1_TYPE_ERROR);
//   - integers are bound as INTEGER (node:sqlite would bind every JS number as REAL), booleans as 1/0;
//   - foreign keys are always enforced;
//   - results are plain objects, meta has changes / last_row_id / rows_read / rows_written / duration;
//   - D1's tighter SQLite limits (checked against workerd's D1 on 15 Nov 2026): a LIKE or GLOB pattern longer than
//     50 bytes fails with "LIKE or GLOB pattern too complex" (also inside CHECK constraints), and a compound SELECT
//     with more than 5 terms fails with "too many terms in compound SELECT". node:sqlite has no sqlite3_limit(), so
//     like()/glob() are replaced by equivalent functions that enforce the limit, and prepare() counts the terms.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** D1 limits (SQLITE_LIMIT_LIKE_PATTERN_LENGTH, SQLITE_LIMIT_COMPOUND_SELECT) */
export const D1_LIKE_PATTERN_MAX_BYTES = 50;
export const D1_COMPOUND_SELECT_MAX_TERMS = 5;

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** SQLite GLOB pattern → RegExp (case-sensitive; * ? [abc] [a-z] [^…]); null for a pattern that can never match */
function globRegExp(p: string): RegExp | null {
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (p[j] === '^') { neg = true; j++; }
      let cls = '';
      if (p[j] === ']') { cls += '\\]'; j++; }
      while (j < p.length && p[j] !== ']') {
        const ch = p[j];
        cls += ch === '-' && cls !== '' && j + 1 < p.length && p[j + 1] !== ']' ? '-' : reEscape(ch);
        j++;
      }
      if (j >= p.length) return null; // no closing ]
      re += `[${neg ? '^' : ''}${cls}]`;
      i = j;
    } else re += reEscape(c);
  }
  return new RegExp(`${re}$`);
}

/** ASCII-only lower case, as SQLite's LIKE folds case */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** SQLite LIKE pattern → RegExp (% _ and an optional escape character; ASCII case-insensitive) */
function likeRegExp(p: string, esc: string | null): RegExp {
  let re = '^';
  const pat = asciiLower(p);
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (esc !== null && c === esc) { i++; if (i < pat.length) re += reEscape(pat[i]); continue; }
    if (c === '%') re += '[\\s\\S]*';
    else if (c === '_') re += '[\\s\\S]';
    else re += reEscape(c);
  }
  return new RegExp(`${re}$`);
}

function checkPattern(pattern: string): void {
  if (Buffer.byteLength(pattern, 'utf8') > D1_LIKE_PATTERN_MAX_BYTES) throw new Error('LIKE or GLOB pattern too complex: SQLITE_ERROR');
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : String(v));

/** Registers like()/glob() replacements that behave like SQLite's and enforce D1's pattern limit */
function installD1Functions(db: DatabaseSync): void {
  const opts = { deterministic: true };
  db.function('glob', opts, (pattern: unknown, value: unknown) => {
    const p = text(pattern);
    const v = text(value);
    if (p === null || v === null) return null;
    checkPattern(p);
    const re = globRegExp(p);
    return re !== null && re.test(v) ? 1n : 0n;
  });
  db.function('like', opts, (pattern: unknown, value: unknown) => {
    const p = text(pattern);
    const v = text(value);
    if (p === null || v === null) return null;
    checkPattern(p);
    return likeRegExp(p, null).test(asciiLower(v)) ? 1n : 0n;
  });
  db.function('like', opts, (pattern: unknown, value: unknown, escape: unknown) => {
    const p = text(pattern);
    const v = text(value);
    const e = text(escape);
    if (p === null || v === null || e === null) return null;
    if ([...e].length !== 1) throw new Error('ESCAPE expression must be a single character: SQLITE_ERROR');
    checkPattern(p);
    return likeRegExp(p, asciiLower(e)).test(asciiLower(v)) ? 1n : 0n;
  });
}

/** Number of terms in the largest compound SELECT of one statement (rough: counts the operators outside strings) */
function compoundTerms(sql: string): number {
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '');
  return 1 + (bare.match(/\b(?:UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0);
}

type Value = null | number | bigint | string | Uint8Array;

export interface ShimMeta {
  changes: number;
  last_row_id: number;
  duration: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
  size_after: number;
  served_by: string;
}
export interface ShimResult<T = Record<string, unknown>> { success: true; results: T[]; meta: ShimMeta }

function toBind(v: unknown, i: number): Value {
  if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (parameter ${i + 1})`);
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`D1_TYPE_ERROR: Type 'number' value ${v} not supported (parameter ${i + 1})`);
    return Number.isSafeInteger(v) ? BigInt(v) : v;
  }
  if (typeof v === 'bigint') throw new Error(`D1_TYPE_ERROR: Type 'bigint' not supported (parameter ${i + 1})`);
  if (typeof v === 'string') return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported (parameter ${i + 1})`);
}

const plain = (row: Record<string, unknown>): Record<string, unknown> => {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    o[k] = v instanceof Uint8Array ? Array.from(v) : v;
  }
  return o;
};

export class ShimStatement {
  constructor(private readonly owner: D1Shim, readonly sql: string, private readonly values: Value[] = []) {}

  bind(...values: unknown[]): ShimStatement {
    return new ShimStatement(this.owner, this.sql, values.map(toBind));
  }

  /** Runs the statement now; used by first/all/run/raw and by batch */
  execute(): { rows: Record<string, unknown>[]; columns: string[]; meta: ShimMeta } {
    const db = this.owner.sqlite;
    const started = performance.now();
    let st: StatementSync;
    try {
      if (compoundTerms(this.sql) > D1_COMPOUND_SELECT_MAX_TERMS) throw new Error('too many terms in compound SELECT: SQLITE_ERROR');
      st = db.prepare(this.sql);
    } catch (e) {
      throw new Error(`D1_ERROR: ${(e as Error).message}`, { cause: e });
    }
    const columns = st.columns().map((c) => c.name);
    const before = this.owner.totalChanges();
    let rows: Record<string, unknown>[] = [];
    let lastRowId = 0;
    try {
      if (columns.length > 0) {
        rows = (st.all(...this.values) as Record<string, unknown>[]).map(plain);
      } else {
        const r = st.run(...this.values);
        lastRowId = Number(r.lastInsertRowid);
      }
    } catch (e) {
      const msg = (e as Error).message;
      throw new Error(`D1_ERROR: ${msg}${/constraint failed/i.test(msg) ? ': SQLITE_CONSTRAINT' : ''}`, { cause: e });
    }
    const changes = this.owner.totalChanges() - before;
    if (columns.length > 0 && changes > 0) lastRowId = this.owner.lastRowId();
    return {
      rows,
      columns,
      meta: {
        changes,
        last_row_id: lastRowId,
        duration: performance.now() - started,
        rows_read: rows.length,
        rows_written: changes,
        changed_db: changes > 0,
        size_after: 0,
        served_by: 'd1-sqlite-shim',
      },
    };
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const { rows } = this.execute();
    if (!rows.length) return null;
    if (col === undefined) return rows[0] as T;
    if (!(col in rows[0])) throw new Error(`D1_ERROR: Column not found: ${col}`);
    return rows[0][col] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<ShimResult<T>> {
    const { rows, meta } = this.execute();
    return { success: true, results: rows as T[], meta };
  }

  async run<T = Record<string, unknown>>(): Promise<ShimResult<T>> {
    return this.all<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const { rows, columns } = this.execute();
    const out = rows.map((r) => columns.map((c) => r[c]));
    return (options?.columnNames ? [columns, ...out] : out) as T[];
  }
}

export class D1Shim {
  readonly sqlite: DatabaseSync;
  /** every SQL string run through prepare(), for tests that count queries */
  readonly log: string[] = [];
  private batches = 0;

  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    installD1Functions(this.sqlite);
  }

  totalChanges(): number {
    return Number((this.sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  }

  lastRowId(): number {
    return Number((this.sqlite.prepare('SELECT last_insert_rowid() AS n').get() as { n: number }).n);
  }

  prepare(sql: string): ShimStatement {
    this.log.push(sql);
    return new ShimStatement(this, sql);
  }

  /** Like D1: statements run in order inside one transaction; the first error rolls everything back */
  async batch<T = Record<string, unknown>>(statements: ShimStatement[]): Promise<ShimResult<T>[]> {
    if (!Array.isArray(statements) || statements.some((s) => !(s instanceof ShimStatement))) {
      throw new Error('D1_ERROR: batch() needs an array of prepared statements');
    }
    this.batches++;
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => {
        const { rows, meta } = s.execute();
        return { success: true as const, results: rows as T[], meta };
      });
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }

  /** Raw SQL, several statements allowed (used for migrations and seeds in tests) */
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    this.sqlite.exec(sql);
    const count = sql.split(';').filter((s) => s.trim()).length;
    return { count, duration: performance.now() - started };
  }

  /** number of batch() calls so far */
  get batchCount(): number {
    return this.batches;
  }

  close(): void {
    this.sqlite.close();
  }
}
