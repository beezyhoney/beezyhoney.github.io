// Fixed-window counters in D1 (`rate_limits`), for order intake (design §2.3) and login limits (A1).
// A bucket name carries its window ('ip:<hash>:<YYYYMMDDHH>', 'day:<YYYYMMDD>'), so an old window is simply
// another row; expires_at only tells the cleanup job when the row can go.
//
//   const n = await hit(db, ipHourBucket(hash, at), at);   // count including this hit
//   if (n > 20) …
import { type D1, type D1Statement, all, first, stmt } from './db';
import { addTime, istDate, nowIso } from './time';

/** One upsert that adds 1 and returns the new count (add it to a batch, or use hit()) */
export function hitStmt(db: D1, bucket: string, expiresAt: string, by = 1): D1Statement {
  return stmt(db, `INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(bucket) DO UPDATE SET count = count + ?2, expires_at = max(expires_at, ?3) RETURNING count`, bucket, by, expiresAt);
}

/** Adds one to a bucket and returns the count including this hit */
export async function hit(db: D1, bucket: string, at: string = nowIso(), ttl: { minutes?: number; hours?: number; days?: number } = { hours: 2 }): Promise<number> {
  const r = await hitStmt(db, bucket, addTime(at, ttl)).first<{ count: number }>();
  return r?.count ?? 1;
}

/** Current count of a bucket without adding (0 when none) */
export async function peek(db: D1, bucket: string): Promise<number> {
  return (await first<{ count: number }>(db, 'SELECT count FROM rate_limits WHERE bucket = ?', bucket))?.count ?? 0;
}

/** Removes expired buckets (cleanup job). Returns how many went. */
export async function deleteExpired(db: D1, at: string = nowIso()): Promise<number> {
  return (await stmt(db, 'DELETE FROM rate_limits WHERE expires_at < ?', at).run()).meta.changes;
}

const compact = (iso: string) => iso.replace(/[-:TZ]/g, '');

/** 'ip:<hash>:<YYYYMMDDHH>' (IST hour) — orders per IP hash per hour */
export function ipHourBucket(ipHash: string, at: string): string {
  const ist = new Date(Date.parse(at) + 330 * 60_000).toISOString();
  return `ip:${ipHash}:${compact(ist).slice(0, 10)}`;
}

/** 'day:<YYYYMMDD>' (IST day) — all orders per day */
export const dayBucket = (at: string): string => `day:${istDate(at).replace(/-/g, '')}`;

/** A generic fixed window: '<name>:<window start in minutes since epoch>' (e.g. login codes per email per 15 min) */
export function windowBucket(name: string, windowMinutes: number, at: string): { bucket: string; resetsAt: string } {
  const minutes = Math.floor(Date.parse(at) / 60_000);
  const start = minutes - (minutes % windowMinutes);
  return { bucket: `${name}:${start}`, resetsAt: `${new Date((start + windowMinutes) * 60_000).toISOString().slice(0, 19)}Z` };
}

/** Used when IP_HASH_KEY is missing: random per isolate, so a hash can never be reversed with a known key
 *  (per-IP limits then only hold within one isolate; set the secret) */
let isolateKey: string | null = null;
const fallbackKey = (): string => {
  if (!isolateKey) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    isolateKey = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return isolateKey;
};

/**
 * HMAC-SHA256(key, ip + IST date) as 32 hex characters: changes every day, so IPs cannot be followed across days,
 * and cannot be reversed without the IP_HASH_KEY secret. Web Crypto (works in workerd and Node).
 * An empty key never falls back to a fixed one (see fallbackKey).
 */
export async function ipHash(key: string, ip: string, at: string = nowIso()): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key || fallbackKey()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(`${ip}|${istDate(at)}`)));
  return Array.from(sig.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * "Unusual order traffic": the IST days (today and yesterday) whose order count went over the daily cap.
 * Today shows an alert while this is not empty.
 */
export async function unusualTraffic(db: D1, perDay: number, at: string = nowIso()): Promise<{ day: string; count: number }[]> {
  const days = [istDate(at), istDate(addTime(at, { days: -1 }))];
  const rows = await all<{ bucket: string; count: number }>(db, 'SELECT bucket, count FROM rate_limits WHERE bucket IN (?, ?) AND count > ?',
    ...days.map((d) => `day:${d.replace(/-/g, '')}`), perDay);
  return rows.map((r) => ({ day: `${r.bucket.slice(4, 8)}-${r.bucket.slice(8, 10)}-${r.bucket.slice(10, 12)}`, count: r.count }));
}
