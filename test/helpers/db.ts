// Test databases: a fresh in-memory D1 shim with db/migrations/*.sql applied and (optionally) db/seed.sql.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Shim } from './d1-sqlite';
import type { Actor, D1 } from '../../src/server/db';

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const MIGRATIONS_DIR = join(ROOT, 'db/migrations');
export const SEED_FILE = join(ROOT, 'db/seed.sql');

/** Every migration in order */
export function migrationSql(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
}

/** A migrated database; seeded unless `seed: false`. `seedSql` replaces db/seed.sql (e.g. a test catalog). */
export async function freshDb(opts: { seed?: boolean; seedSql?: string } = {}): Promise<D1Shim & D1> {
  const db = new D1Shim();
  for (const sql of migrationSql()) await db.exec(sql);
  if (opts.seed !== false) await db.exec(opts.seedSql ?? readFileSync(SEED_FILE, 'utf8'));
  return db as D1Shim & D1;
}

export const OWNER: Actor = { email: 'owner@example.test', role: 'owner' };
export const HELPER: Actor = { email: 'helper@example.test', role: 'helper' };

/** A fixed clock for tests: t('2026-11-15T10:00:00Z') or t(minutesAfterStart) */
export const T0 = '2026-11-15T04:30:00Z'; // 10:00 IST
export function t(offsetMinutes = 0, base = T0): string {
  return `${new Date(Date.parse(base) + offsetMinutes * 60_000).toISOString().slice(0, 19)}Z`;
}

/** Shorthand: one row */
export async function row<T = Record<string, unknown>>(db: D1, sql: string, ...params: unknown[]): Promise<T> {
  const s = db.prepare(sql);
  const r = await (params.length ? s.bind(...params) : s).first<T>();
  if (r === null) throw new Error(`no row: ${sql}`);
  return r;
}

/** Shorthand: all rows */
export async function rows<T = Record<string, unknown>>(db: D1, sql: string, ...params: unknown[]): Promise<T[]> {
  const s = db.prepare(sql);
  return (await (params.length ? s.bind(...params) : s).all<T>()).results;
}

/** Variant id by code */
export async function variantId(db: D1, code: string): Promise<number> {
  return (await row<{ id: number }>(db, 'SELECT id FROM variants WHERE code = ?', code)).id;
}

/** Pool row by code */
export async function pool(db: D1, code: string): Promise<{ id: number; on_hand: number; track_stock: number; low_at: number | null; availability: string; version: number }> {
  return row(db, 'SELECT id, on_hand, track_stock, low_at, availability, version FROM stock_pools WHERE code = ?', code);
}
