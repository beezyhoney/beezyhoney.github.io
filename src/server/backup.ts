// Daily backup of D1 into the KV namespace BACKUPS (amendment A2), in small steps that fit the cron's CPU limit.
//
// backupTick() runs on every cron tick (and on lazy triggers). From 02:30 IST it opens one `job_runs` row per IST
// day and, per tick, reads up to `maxRows` rows (pages of 500, table by table in rowid order) into ONE chunk that it
// writes to KV, keeping its place in job_runs.cursor_json. When every table is done it writes manifest.json last,
// closes the job and applies retention: 35 daily backups + the first backup of each of the last 12 months.
// KV writes per day = chunks + 1 manifest (2 for today's data size), far below the free 1,000/day.
// The format, and the restore SQL, are in backup-format.mjs (shared with scripts/restore-backup.mjs).
import { type D1, all, first, stmt } from './db';
import type { KVLike } from './media';
import { addMonths, istDate, istTime, nowIso } from './time';
import { BACKUP_FORMAT, BACKUP_TABLES, backupToSql, readBundle } from './backup-format.mjs';

export { BACKUP_FORMAT, BACKUP_TABLES, backupToSql, readBundle };

export interface BackupEnv { DB: D1; BACKUPS: KVLike }

export interface BackupChunk { format: 1; date: string; chunk: number; tables: { name: string; columns: string[]; rows: unknown[][] }[] }
export interface BackupManifest {
  format: 1;
  date: string;
  startedAt: string;
  finishedAt: string;
  /** names of the applied migrations (d1_migrations), so a restore can check the schema */
  migrations: string[];
  /** rows per table */
  tables: Record<string, number>;
  /** KV keys of the chunks, in order */
  chunks: string[];
  /** total bytes of the chunks */
  bytes: number;
}
export interface BackupBundle { format: 1; manifest: BackupManifest; chunks: BackupChunk[] }

interface Cursor { date: string; table: number; after: number; chunk: number; rows: Record<string, number>; keys: string[]; bytes: number }

export const DAILY_PREFIX = 'daily/';
export const KEEP_DAILY = 35;
export const KEEP_MONTHLY = 12;
/** IST time from which the day's backup may start */
export const BACKUP_START_IST = '02:30';

const chunkKey = (date: string, n: number) => `${DAILY_PREFIX}${date}/chunk-${String(n).padStart(3, '0')}.json`;
export const manifestKey = (date: string) => `${DAILY_PREFIX}${date}/manifest.json`;

export type BackupTickResult =
  | { state: 'not_due' }
  | { state: 'done_today'; date: string }
  | { state: 'progress'; date: string; jobId: number; chunkKey: string | null; rows: number }
  | { state: 'finished'; date: string; jobId: number; manifest: BackupManifest; deleted: number };

/**
 * One step of the daily backup. `force` starts today's backup before 02:30 IST (Backup screen "Back up now").
 * `maxRows` (default 1500) and `pageSize` (default 500) bound the work of one tick.
 */
export async function backupTick(env: BackupEnv, at: string = nowIso(), opts: { force?: boolean; maxRows?: number; pageSize?: number } = {}): Promise<BackupTickResult> {
  const date = istDate(at);
  const maxRows = opts.maxRows ?? 1500;
  const pageSize = Math.min(opts.pageSize ?? 500, maxRows);
  let job = await first<{ id: number; ok: number | null; cursor_json: string | null }>(env.DB,
    "SELECT id, ok, cursor_json FROM job_runs WHERE job = 'backup' AND json_extract(cursor_json, '$.date') = ? ORDER BY id DESC LIMIT 1", date);
  if (job?.ok === 1) return { state: 'done_today', date };
  if (!job) {
    if (!opts.force && istTime(at) < BACKUP_START_IST) return { state: 'not_due' };
    // an earlier day's backup that never finished is closed as failed (its chunks go with the retention)
    await stmt(env.DB, `UPDATE job_runs SET ok = 0, finished_at = ?, detail_json = '{"error":"did not finish that day"}'
      WHERE job = 'backup' AND ok IS NULL AND json_extract(cursor_json, '$.date') < ?`, at, date).run();
    const cursor: Cursor = { date, table: 0, after: 0, chunk: 0, rows: {}, keys: [], bytes: 0 };
    const r = await stmt(env.DB, "INSERT INTO job_runs (job, started_at, cursor_json) VALUES ('backup', ?, ?)", at, JSON.stringify(cursor)).run();
    job = { id: r.meta.last_row_id, ok: null, cursor_json: JSON.stringify(cursor) };
  }
  const cur = JSON.parse(job.cursor_json!) as Cursor;

  // read up to maxRows rows into one chunk
  const chunk: BackupChunk = { format: BACKUP_FORMAT, date, chunk: cur.chunk + 1, tables: [] };
  let read = 0;
  while (cur.table < BACKUP_TABLES.length && read < maxRows) {
    const name = BACKUP_TABLES[cur.table];
    const limit = Math.min(pageSize, maxRows - read);
    const raw = await stmt(env.DB, `SELECT rowid AS _backup_rowid, * FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT ?`, cur.after, limit).raw({ columnNames: true });
    const [columns, ...rows] = raw as [string[], ...unknown[][]];
    if (rows.length) {
      let t = chunk.tables.find((x) => x.name === name);
      if (!t) { t = { name, columns: columns.slice(1), rows: [] }; chunk.tables.push(t); }
      for (const r of rows) t.rows.push(r.slice(1));
      cur.after = Number(rows[rows.length - 1][0]);
      cur.rows[name] = (cur.rows[name] ?? 0) + rows.length;
      read += rows.length;
    } else {
      cur.rows[name] ??= 0;
    }
    if (rows.length < limit) { cur.table++; cur.after = 0; }
  }

  let key: string | null = null;
  if (chunk.tables.length) {
    key = chunkKey(date, chunk.chunk);
    const text = JSON.stringify(chunk);
    await env.BACKUPS.put(key, text, { metadata: { date, chunk: chunk.chunk } });
    cur.chunk = chunk.chunk;
    cur.keys.push(key);
    cur.bytes += text.length;
  }

  if (cur.table < BACKUP_TABLES.length) {
    await stmt(env.DB, 'UPDATE job_runs SET cursor_json = ? WHERE id = ?', JSON.stringify(cur), job.id).run();
    return { state: 'progress', date, jobId: job.id, chunkKey: key, rows: read };
  }

  const started = await first<{ started_at: string }>(env.DB, 'SELECT started_at FROM job_runs WHERE id = ?', job.id);
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT, date, startedAt: started?.started_at ?? at, finishedAt: at, migrations: await migrationNames(env.DB),
    tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, cur.rows[t] ?? 0])), chunks: cur.keys, bytes: cur.bytes,
  };
  await env.BACKUPS.put(manifestKey(date), JSON.stringify(manifest), { metadata: { date, manifest: true } });
  await stmt(env.DB, 'UPDATE job_runs SET cursor_json = ?, finished_at = ?, ok = 1, detail_json = ? WHERE id = ?',
    JSON.stringify(cur), at, JSON.stringify({ tables: manifest.tables, chunks: manifest.chunks.length, bytes: manifest.bytes }), job.id).run();
  const deleted = await applyRetention(env, date);
  return { state: 'finished', date, jobId: job.id, manifest, deleted };
}

async function migrationNames(db: D1): Promise<string[]> {
  try {
    return (await all<{ name: string }>(db, 'SELECT name FROM d1_migrations ORDER BY id')).map((r) => r.name);
  } catch {
    return [];
  }
}

/** All KV keys under daily/ (paged list) */
async function listDailyKeys(kv: KVLike): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: DAILY_PREFIX, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

/**
 * Which backup days to keep: the newest KEEP_DAILY complete days, plus the first complete day of each of the
 * last KEEP_MONTHLY months (counting `today`'s month), plus `today`. Pure, for tests.
 */
export function daysToKeep(completeDays: string[], today: string): Set<string> {
  const days = [...new Set(completeDays)].sort();
  const keep = new Set(days.slice(-KEEP_DAILY));
  const firstMonth = addMonths(today.slice(0, 7), -(KEEP_MONTHLY - 1));
  const firstOfMonth = new Map<string, string>();
  for (const d of days) if (!firstOfMonth.has(d.slice(0, 7))) firstOfMonth.set(d.slice(0, 7), d);
  for (const [m, d] of firstOfMonth) if (m >= firstMonth) keep.add(d);
  keep.add(today);
  return keep;
}

/** Deletes backups outside the retention (only days older than today; incomplete old days go too). Returns keys deleted. */
export async function applyRetention(env: BackupEnv, today: string): Promise<number> {
  const keys = await listDailyKeys(env.BACKUPS);
  const dayOf = (k: string) => k.slice(DAILY_PREFIX.length, DAILY_PREFIX.length + 10);
  const complete = keys.filter((k) => k.endsWith('/manifest.json')).map(dayOf);
  const keep = daysToKeep(complete, today);
  let n = 0;
  for (const k of keys) {
    const d = dayOf(k);
    if (d < today && !keep.has(d)) { await env.BACKUPS.delete(k); n++; }
  }
  return n;
}

/** Complete backups, newest first (one KV read per manifest) */
export async function listBackups(env: BackupEnv): Promise<BackupManifest[]> {
  const keys = (await listDailyKeys(env.BACKUPS)).filter((k) => k.endsWith('/manifest.json')).sort().reverse();
  const out: BackupManifest[] = [];
  for (const k of keys) {
    const m = await env.BACKUPS.get(k, { type: 'json' });
    if (m) out.push(m as BackupManifest);
  }
  return out;
}

/** One complete backup as a single downloadable bundle, or null */
export async function readBackup(env: BackupEnv, date: string): Promise<BackupBundle | null> {
  const manifest = (await env.BACKUPS.get(manifestKey(date), { type: 'json' })) as BackupManifest | null;
  if (!manifest) return null;
  const chunks: BackupChunk[] = [];
  for (const k of manifest.chunks) {
    const c = (await env.BACKUPS.get(k, { type: 'json' })) as BackupChunk | null;
    if (!c) throw new Error(`backup ${date} is missing ${k}`);
    chunks.push(c);
  }
  return { format: BACKUP_FORMAT, manifest, chunks };
}

/** The last finished backup (for Today: "last backup older than 2 days") */
export async function lastBackup(db: D1): Promise<{ date: string; finishedAt: string } | null> {
  const r = await first<{ date: string; finished_at: string }>(db,
    "SELECT json_extract(cursor_json, '$.date') AS date, finished_at FROM job_runs WHERE job = 'backup' AND ok = 1 ORDER BY id DESC LIMIT 1");
  return r ? { date: r.date, finishedAt: r.finished_at } : null;
}
