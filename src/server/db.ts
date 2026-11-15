// Typed helpers over the D1 binding (env.DB), plus the shared result and actor types of src/server.
//
// The interfaces below are the subset of Cloudflare's D1 API the server uses; env.DB (D1Database) and the test
// shim (test/helpers/d1-sqlite.ts) both fit them. D1 rules to remember:
// - parameters are ordered (?NNN) or anonymous (?); named parameters do not exist; `undefined` cannot be bound;
// - db.batch([...]) is one SQL transaction: statements run in order and the first error rolls everything back;
// - at most 100 bound parameters per statement; a batch counts as one query against the per-request limit.
/** Current UTC time in the database format 'YYYY-MM-DDTHH:MM:SSZ' (alias of time.ts nowIso) */
export { nowIso as now } from './time';

// ───────────────────────────── D1 shapes ─────────────────────────────

export interface D1Meta {
  changes: number;
  last_row_id: number;
  duration?: number;
  rows_read?: number;
  rows_written?: number;
  changed_db?: boolean;
}
export interface D1Result<T = Row> { success: boolean; results: T[]; meta: D1Meta }
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Row>(column?: string): Promise<T | null>;
  all<T = Row>(): Promise<D1Result<T>>;
  run<T = Row>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}
export interface D1 {
  prepare(sql: string): D1Statement;
  batch<T = Row>(statements: D1Statement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}
export type Row = Record<string, unknown>;

// ───────────────────────────── actors and results ─────────────────────────────

/** Who is acting: Astro.locals.admin for admin requests, SYSTEM for cron jobs, PUBLIC for order intake */
export interface Actor { email: string; role: 'owner' | 'helper' }
export const SYSTEM: Actor = Object.freeze({ email: 'system', role: 'owner' }) as Actor;
export const PUBLIC_ACTOR = 'public';

/**
 * Error codes every server function may return (never thrown):
 * - not_found: the row does not exist
 * - conflict: someone else changed it (version), it is already in that state, or a duplicate code
 * - invalid: the input is wrong (see `field` and `message`)
 * - needs_price: an order line has no price yet (confirm)
 * - needs_restock_answer: cancelling a sent/delivered order needs "did the jars come back?"
 * - forbidden: the actor's role may not do this
 * - not_allowed: not possible in the current state (e.g. "Clear test data" after go-live)
 */
export type ErrorCode = 'not_found' | 'conflict' | 'invalid' | 'needs_price' | 'needs_restock_answer' | 'forbidden' | 'not_allowed';

export interface Failure {
  ok: false;
  error: ErrorCode;
  /** plain-English message for the owner */
  message: string;
  /** form field the message belongs to, when there is one */
  field?: string;
  /** extra data, e.g. the lines without a price */
  details?: unknown;
}
export interface Success<T> { ok: true; value: T }
export type Result<T> = Success<T> | Failure;

export const ok = <T>(value: T): Success<T> => ({ ok: true, value });
export const fail = (error: ErrorCode, message: string, extra: { field?: string; details?: unknown } = {}): Failure =>
  ({ ok: false, error, message, ...extra });

/** Owner-only actions return this for helpers */
export const ownerOnly = (actor: Actor): Failure | null =>
  actor.role === 'owner' ? null : fail('forbidden', 'Only the owner can do this.');

/** What a write means for the website, for the caller (see publish.ts handleEffects) */
export interface Effects {
  /** 'now': an owner save that needs a rebuild was recorded (site_version bumped) → call requestPublish();
   *  'scheduled': a stock-status change set publish_due_at (the cron or the next admin page load publishes);
   *  null: nothing to publish */
  publish: 'now' | 'scheduled' | null;
  /** live_version was bumped: /api/live.json shows the change within about a minute */
  live: boolean;
}
export const NO_EFFECTS: Effects = Object.freeze({ publish: null, live: false }) as Effects;

// ───────────────────────────── query helpers ─────────────────────────────

/** Prepared statement with its parameters bound */
export function stmt(db: D1, sql: string, ...params: unknown[]): D1Statement {
  const s = db.prepare(sql);
  return params.length ? s.bind(...params) : s;
}

/** First row, or null */
export async function first<T = Row>(db: D1, sql: string, ...params: unknown[]): Promise<T | null> {
  return stmt(db, sql, ...params).first<T>();
}

/** All rows */
export async function all<T = Row>(db: D1, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await stmt(db, sql, ...params).all<T>()).results ?? [];
}

/** Runs one write; returns its meta (changes, last_row_id) */
export async function run(db: D1, sql: string, ...params: unknown[]): Promise<D1Meta> {
  return (await stmt(db, sql, ...params).run()).meta;
}

/** Runs statements as one transaction. Throws DbError (with `kind`) when a constraint fails. */
export async function batch(db: D1, statements: D1Statement[]): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (e) {
    throw DbError.from(e);
  }
}

export type ConstraintKind = 'unique' | 'check' | 'foreign_key' | 'not_null' | 'other';

/** A failed batch, with the kind of constraint that stopped it */
export class DbError extends Error {
  constructor(message: string, readonly kind: ConstraintKind, readonly cause?: unknown) {
    super(message);
    this.name = 'DbError';
  }

  static from(e: unknown): DbError {
    if (e instanceof DbError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    const kind: ConstraintKind = /UNIQUE constraint failed/i.test(msg) ? 'unique'
      : /CHECK constraint failed/i.test(msg) ? 'check'
        : /FOREIGN KEY constraint failed/i.test(msg) ? 'foreign_key'
          : /NOT NULL constraint failed/i.test(msg) ? 'not_null'
            : 'other';
    return new DbError(msg, kind, e);
  }
}

/** Runs a batch and turns constraint failures into a Failure; other errors are rethrown */
export async function tryBatch(db: D1, statements: D1Statement[], messages: Partial<Record<ConstraintKind, string>> = {}): Promise<Result<D1Result[]>> {
  try {
    return ok(await batch(db, statements));
  } catch (e) {
    const err = DbError.from(e);
    if (err.kind === 'other') throw err;
    const code: ErrorCode = err.kind === 'unique' ? 'conflict' : 'invalid';
    return fail(code, messages[err.kind] ?? (err.kind === 'unique'
      ? 'This was already saved (or the code is already used). Reload the page.'
      : 'Some values are not allowed. Check the form and try again.'), { details: err.message });
  }
}

// ───────────────────────────── ids ─────────────────────────────

/** Random UUID v4 (op tokens and idempotency keys) */
export const uuid = (): string => crypto.randomUUID();

/** A guard fragment for WHERE clauses, with anonymous (?) parameters */
export interface Guard { sql: string; params: unknown[] }

/** EXISTS guard: the order still carries this batch's op token (the first statement of the batch set it) */
export const orderOpGuard = (orderId: number, op: string): Guard =>
  ({ sql: 'EXISTS (SELECT 1 FROM orders WHERE id = ? AND last_op = ?)', params: [orderId, op] });

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name: string): string => {
  if (!IDENT.test(name)) throw new Error(`bad SQL identifier: ${name}`);
  return name;
};

/**
 * Optimistic-concurrency UPDATE: sets the columns, bumps version, stamps updated_at/updated_by, and changes
 * nothing unless the row still has `version` (and the extra guard holds). Check meta.changes === 1 afterwards.
 *
 *   versionedUpdate(db, { table: 'stock_pools', key: ['id', 3], version: 4, set: { low_at: 2000 }, actor, at })
 */
export function versionedUpdate(db: D1, o: {
  table: string;
  key: [column: string, value: unknown];
  version: number;
  set: Record<string, unknown>;
  actor: Actor | string;
  at: string;
  guard?: Guard;
}): D1Statement {
  const cols = Object.keys(o.set);
  const sets = [...cols.map((c) => `${ident(c)} = ?`), 'version = version + 1', 'updated_at = ?', 'updated_by = ?'];
  const by = typeof o.actor === 'string' ? o.actor : o.actor.email;
  const sql = `UPDATE ${ident(o.table)} SET ${sets.join(', ')} WHERE ${ident(o.key[0])} = ? AND version = ?${o.guard ? ` AND ${o.guard.sql}` : ''}`;
  return stmt(db, sql, ...cols.map((c) => o.set[c]), o.at, by, o.key[1], o.version, ...(o.guard?.params ?? []));
}

/** One audit_log row (plain-English summary, optional before/after JSON) */
export interface AuditEntry {
  at: string;
  actor: Actor | string;
  /** e.g. 'order.confirm', 'stock.count', 'settings.save' */
  action: string;
  /** e.g. 'order', 'pool', 'variant', 'product', 'batch', 'settings' */
  entity: string;
  entityId: string | number;
  /** what happened, in words the owner reads in Activity, e.g. 'Confirmed BZ-7K3QD' (at most 500 characters) */
  summary: string;
  before?: unknown;
  after?: unknown;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const jsonOrNull = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * INSERT for one audit row. With a guard it is written only when the guard holds (the batch's op token),
 * so a rejected action leaves no audit trace.
 */
export function auditInsert(db: D1, e: AuditEntry, guard?: Guard): D1Statement {
  const actor = typeof e.actor === 'string' ? e.actor : e.actor.email;
  const values = [e.at, actor, e.action, e.entity, String(e.entityId), clip(e.summary, 500), jsonOrNull(e.before), jsonOrNull(e.after)];
  if (!guard) {
    return stmt(db, 'INSERT INTO audit_log (at, actor, action, entity, entity_id, summary, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...values);
  }
  return stmt(db, `INSERT INTO audit_log (at, actor, action, entity, entity_id, summary, before_json, after_json)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`, ...values, ...guard.params);
}

/** `?, ?, ?` for n parameters */
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Small integer parse for ids from forms and URLs; null when it is not a positive whole number */
export function toId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
