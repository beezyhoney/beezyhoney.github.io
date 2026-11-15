// System reads for the status chip (/admin/api/status.json), Help → Self-check and Backup → "Download everything".
// Nothing here writes, except getPublishStatus() marking builds live once the deployed /build.json shows them.
import { BACKUP_TABLES } from '../../server/backup';
import { type D1, all, first } from '../../server/db';
import { selfCheck, type SelfCheck } from '../../server/jobs-impl';
import { getPublishStatus, type PublishStatus } from '../../server/publish';
import { nowIso } from '../../server/time';

interface AssetsLike { fetch(input: Request | string): Promise<Response> }
interface KvProbe { get(key: string): Promise<unknown> }

/**
 * site_version of the build that is live, from the deployed static /build.json (the Worker's own ASSETS binding:
 * the assets of the running version, so this is exactly what visitors get). null when it cannot be read (dev).
 */
export async function builtSiteVersion(assets: AssetsLike | undefined | null): Promise<number | null> {
  if (!assets || typeof assets.fetch !== 'function') return null;
  try {
    const res = await assets.fetch(new Request(new URL('/build.json', 'http://x')));
    if (!res.ok) return null;
    const j = (await res.json()) as { siteVersion?: unknown };
    return Number.isSafeInteger(j?.siteVersion) && (j.siteVersion as number) > 0 ? (j.siteVersion as number) : null;
  } catch {
    return null;
  }
}

export interface StatusPayload {
  /** the status chip reads this (src/admin/README.md "Status chip contract") */
  website: PublishStatus;
  /** the site_version the deployed /build.json reports, or null */
  built: number | null;
  health: { db: boolean };
  time: string;
}

/** Body of GET /admin/api/status.json */
export async function statusPayload(env: { DB: D1; DEPLOY_HOOK_URL?: string; ASSETS?: AssetsLike }, at: string = nowIso()): Promise<StatusPayload> {
  const built = await builtSiteVersion(env.ASSETS);
  let db = true;
  let website: PublishStatus;
  try {
    website = await getPublishStatus(env, at, built);
  } catch {
    db = false;
    website = { state: 'failed', message: 'The database did not answer.', siteVersion: 0, publishedVersion: 0, dueAt: null, last: null };
  }
  return { website, built, health: { db }, time: at };
}

// ───────────────────────────── photo library ─────────────────────────────

export interface LibraryPhoto { path: string; src: string; width?: number; height?: number; alt?: string }

/**
 * The website photos with small thumbnails from the deployed /photo-library.json (design §4: built at build time,
 * repo photos with 240 px WebP thumbnails). Accepts [{ path, src | thumb, width?, height?, alt? }] or
 * { photos: [...] }. Returns null when it is not there (local dev, or not built yet): screens then fall back to a
 * plain list of photo names.
 */
export async function photoLibrary(assets: AssetsLike | undefined | null): Promise<Map<string, LibraryPhoto> | null> {
  if (!assets || typeof assets.fetch !== 'function') return null;
  try {
    const res = await assets.fetch(new Request(new URL('/photo-library.json', 'http://x')));
    if (!res.ok) return null;
    const j = (await res.json()) as unknown;
    const list = Array.isArray(j) ? j : Array.isArray((j as { photos?: unknown })?.photos) ? (j as { photos: unknown[] }).photos : null;
    if (!list) return null;
    const out = new Map<string, LibraryPhoto>();
    for (const item of list as Record<string, unknown>[]) {
      const path = typeof item?.path === 'string' ? item.path : null;
      const src = typeof item?.src === 'string' ? item.src : typeof item?.thumb === 'string' ? item.thumb : null;
      // same-origin thumbnails only (the admin loads nothing from other hosts)
      if (!path || !src || !src.startsWith('/') || src.startsWith('//')) continue;
      out.set(path, {
        path, src,
        width: Number.isSafeInteger(item.width) ? (item.width as number) : Number.isSafeInteger(item.w) ? (item.w as number) : undefined,
        height: Number.isSafeInteger(item.height) ? (item.height as number) : Number.isSafeInteger(item.h) ? (item.h as number) : undefined,
        alt: typeof item.alt === 'string' ? item.alt : undefined,
      });
    }
    return out.size ? out : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── paged dump ─────────────────────────────

export const DUMP_PAGE = 500;

export interface DumpPage {
  table: string;
  columns: string[];
  rows: unknown[][];
  /** pass as ?after= for the next page; null when the table is done */
  next: number | null;
}

/** One page of a backed-up table in rowid order (same rows and columns as the daily backup) */
export async function dumpPage(db: D1, table: string, after = 0, limit = DUMP_PAGE): Promise<DumpPage | null> {
  if (!(BACKUP_TABLES as readonly string[]).includes(table)) return null;
  const n = Math.min(Math.max(Math.trunc(limit) || DUMP_PAGE, 1), 1000);
  const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
  const raw = await db.prepare(`SELECT rowid AS _backup_rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(from, n).raw({ columnNames: true });
  const [columns, ...rows] = raw as [string[], ...unknown[][]];
  if (!columns) {
    // no rows: read the column names from the schema
    const cols = await all<{ name: string }>(db, `SELECT name FROM pragma_table_info(?) ORDER BY cid`, table);
    return { table, columns: cols.map((c) => c.name), rows: [], next: null };
  }
  return {
    table,
    columns: columns.slice(1),
    rows: rows.map((r) => r.slice(1)),
    next: rows.length === n ? Number(rows[rows.length - 1][0]) : null,
  };
}

/** Names of the applied migrations (so a restore can check the schema) */
export async function migrationNames(db: D1): Promise<string[]> {
  try {
    return (await all<{ name: string }>(db, 'SELECT name FROM d1_migrations ORDER BY id')).map((r) => r.name);
  } catch {
    return [];
  }
}

// ───────────────────────────── self-check ─────────────────────────────

export interface FullSelfCheck extends SelfCheck {
  /** site_version in D1, published_version, and the version the deployed /build.json reports */
  versions: { site: number; published: number; built: number | null };
  /** ADMIN_EMAILS and LOGIN_SECRET are set (never their values) */
  loginConfig: { adminEmails: boolean; loginSecret: boolean };
  kv: { media: boolean | null; backups: boolean | null };
  mail: boolean;
}

async function probe(kv: KvProbe | undefined): Promise<boolean | null> {
  if (!kv) return null;
  try { await kv.get('selfcheck-probe'); return true; } catch { return false; }
}

/** Help → Self-check: everything selfCheck() reports plus versions, login config, KV and mail bindings */
export async function fullSelfCheck(env: {
  DB: D1; BACKUPS?: KvProbe; MEDIA?: KvProbe; ASSETS?: AssetsLike; LOGIN_MAIL?: unknown; DEPLOY_HOOK_URL?: string;
  ADMIN_EMAILS?: string; LOGIN_SECRET?: string;
}, at: string = nowIso(), staleDays = 2): Promise<FullSelfCheck> {
  const base = await selfCheck({ DB: env.DB, DEPLOY_HOOK_URL: env.DEPLOY_HOOK_URL } as Parameters<typeof selfCheck>[0], at, staleDays);
  let site = 0;
  let published = 0;
  if (base.d1) {
    const rows = await all<{ key: string; value: string }>(env.DB, "SELECT key, value FROM settings WHERE key IN ('site_version', 'published_version')");
    site = Number(JSON.parse(rows.find((r) => r.key === 'site_version')?.value ?? '0')) || 0;
    published = Number(JSON.parse(rows.find((r) => r.key === 'published_version')?.value ?? '0')) || 0;
  }
  const [built, media, backups] = await Promise.all([builtSiteVersion(env.ASSETS), probe(env.MEDIA), probe(env.BACKUPS)]);
  return {
    ...base,
    versions: { site, published, built },
    loginConfig: {
      adminEmails: String(env.ADMIN_EMAILS ?? '').split(',').some((e) => e.includes('@')),
      loginSecret: String(env.LOGIN_SECRET ?? '').trim().length >= 32,
    },
    kv: { media, backups },
    mail: !!env.LOGIN_MAIL,
  };
}

/** The settings counters (site / live / published versions) in one read */
export async function settingCounters(db: D1): Promise<{ site: number; live: number; published: number }> {
  const r = await first<{ s: string | null; l: string | null; p: string | null }>(db, `SELECT
      (SELECT value FROM settings WHERE key = 'site_version') AS s,
      (SELECT value FROM settings WHERE key = 'live_version') AS l,
      (SELECT value FROM settings WHERE key = 'published_version') AS p`);
  return { site: Number(r?.s ?? 0) || 0, live: Number(r?.l ?? 0) || 0, published: Number(r?.p ?? 0) || 0 };
}
