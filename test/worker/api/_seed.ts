// Worker-test helpers for the public endpoints and the login (test/worker/api, test/worker/auth).
// seedDb(): db/seed.sql into the (already migrated) D1 of this test file, through the real binding.
import { env } from 'cloudflare:workers';
import seedSql from '../../../db/seed.sql?raw';

/** Splits SQL text into statements: ';' at the end of a statement, outside quotes and comments. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      cur += c;
      if (c === quote) {
        if (sql[i + 1] === quote) cur += sql[++i];
        else quote = null;
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

let seeded = false;

/** Seeds this file's database once (storage is isolated per test file). */
export async function seedDb(): Promise<void> {
  if (seeded) return;
  const done = await env.DB.prepare('SELECT count(*) AS n FROM products').first<{ n: number }>();
  if ((done?.n ?? 0) > 0) {
    seeded = true;
    return;
  }
  await env.DB.batch(splitSql(seedSql).map((s) => env.DB.prepare(s)));
  seeded = true;
}

/** A Map-backed stand-in for caches.default (deterministic, per test). */
export class MemoryCache {
  readonly store = new Map<string, Response>();
  readonly puts: string[] = [];
  async match(key: string): Promise<Response | undefined> {
    const r = this.store.get(key);
    return r ? r.clone() : undefined;
  }
  async put(key: string, res: Response): Promise<void> {
    this.puts.push(key);
    this.store.set(key, res);
  }
}

/** A waitUntil collector. */
export function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) { pending.push(p); },
    passThroughOnException() {},
    settle: () => Promise.all(pending),
    pending,
  };
}

export const sql = (q: string, ...params: unknown[]) => (params.length ? env.DB.prepare(q).bind(...params) : env.DB.prepare(q));
export const rows = async <T = Record<string, unknown>>(q: string, ...params: unknown[]) => (await sql(q, ...params).all<T>()).results;
export const row = <T = Record<string, unknown>>(q: string, ...params: unknown[]) => sql(q, ...params).first<T>();
