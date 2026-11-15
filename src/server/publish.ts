// Publishing the website (design §2.5): an owner save that needs a rebuild bumps settings.site_version in its own
// batch and then calls requestPublish(), which records a `publishes` row and POSTs the Workers Builds deploy hook
// inside waitUntil (the page never waits for it). Automatic stock-status changes only set publish_due_at
// (now + 30 min); publishIfDue() (cron or the next admin page load) fires them.
// With no DEPLOY_HOOK_URL (local computer, tests) every call is a clear no-op: state 'disabled'.
import { type Actor, type D1, type Effects, SYSTEM, all, first, stmt } from './db';
import { bumpVersionStmt, clearPublishDueStmt } from './settings';
import { addTime, istTime, nowIso } from './time';

export interface PublishEnv { DB: D1; DEPLOY_HOOK_URL?: string }
/** ExecutionContext (or anything with waitUntil) */
export interface WaitCtx { waitUntil(promise: Promise<unknown>): void }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Minutes after which a requested build that never showed up counts as failed */
export const BUILD_TIMEOUT_MINUTES = 25;

export type PublishRequest =
  | { state: 'disabled'; message: string }
  | { state: 'requested'; publishId: number; siteVersion: number };

/** The hook URL if it is usable (https, or http on localhost for a local mock), else null */
export function hookUrl(env: { DEPLOY_HOOK_URL?: string }): string | null {
  const raw = (env.DEPLOY_HOOK_URL ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return u.toString();
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.toString();
  } catch { /* not a URL */ }
  return null;
}

export const DISABLED_MESSAGE = 'Publishing is off on this computer (no deploy hook set). Changes are saved; the website is not rebuilt.';

/**
 * Asks Workers Builds for a new build of the current site_version. Records a `publishes` row and clears
 * publish_due_at at once; the hook call runs in ctx.waitUntil and fills in http_status / build_uuid /
 * already_queued, or status 'failed' with the error. A repeat call while a build is queued returns the same
 * build (already_exists) — harmless.
 */
export async function requestPublish(env: PublishEnv, ctx: WaitCtx, o: { reason: string; actor?: Actor | string; at?: string; fetch?: Fetcher } ): Promise<PublishRequest> {
  const url = hookUrl(env);
  if (!url) return { state: 'disabled', message: DISABLED_MESSAGE };
  const at = o.at ?? nowIso();
  const by = typeof o.actor === 'string' ? o.actor : (o.actor ?? SYSTEM).email;
  const res = await env.DB.batch([
    stmt(env.DB, `INSERT INTO publishes (site_version, reason, requested_at, requested_by, status)
      SELECT CAST(value AS INTEGER), ?, ?, ?, 'requested' FROM settings WHERE key = 'site_version'`, o.reason.slice(0, 200), at, by),
    clearPublishDueStmt(env.DB, at),
    stmt(env.DB, "SELECT p.id, p.site_version FROM publishes p WHERE p.requested_at = ? AND p.requested_by = ? ORDER BY p.id DESC LIMIT 1", at, by),
  ]);
  const row = res[2].results[0] as { id: number; site_version: number };
  const doFetch: Fetcher = o.fetch ?? ((u, init) => fetch(u, init));
  ctx.waitUntil(callHook(env.DB, url, row.id, doFetch));
  return { state: 'requested', publishId: row.id, siteVersion: row.site_version };
}

async function callHook(db: D1, url: string, publishId: number, doFetch: Fetcher): Promise<void> {
  try {
    const r = await doFetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    let uuid: string | null = null;
    let already: number | null = null;
    try {
      const j = (await r.json()) as { result?: { build_uuid?: string; already_exists?: boolean } };
      uuid = typeof j?.result?.build_uuid === 'string' ? j.result.build_uuid.slice(0, 64) : null;
      already = j?.result?.already_exists === true ? 1 : 0;
    } catch { /* no JSON body */ }
    await stmt(db, `UPDATE publishes SET http_status = ?, build_uuid = ?, already_queued = ?,
        status = CASE WHEN ? THEN status ELSE 'failed' END, error = CASE WHEN ? THEN NULL ELSE ? END WHERE id = ?`,
    r.status, uuid, already, r.ok, r.ok, `Deploy hook answered ${r.status}`, publishId).run();
  } catch (e) {
    await stmt(db, "UPDATE publishes SET status = 'failed', error = ? WHERE id = ?", String((e as Error)?.message ?? e).slice(0, 500), publishId).run();
  }
}

/** After a write: an owner save that needs a rebuild ('now') calls requestPublish; 'scheduled' waits for the cron */
export async function handleEffects(env: PublishEnv, ctx: WaitCtx, actor: Actor, effects: Effects | undefined, reason: string, at?: string): Promise<PublishRequest | null> {
  if (effects?.publish !== 'now') return null;
  return requestPublish(env, ctx, { reason, actor, at });
}

/** "Update website now": bumps site_version (so the status can follow this build) and requests a build */
export async function publishNow(env: PublishEnv, ctx: WaitCtx, actor: Actor, at: string = nowIso()): Promise<PublishRequest> {
  if (!hookUrl(env)) return { state: 'disabled', message: DISABLED_MESSAGE };
  await bumpVersionStmt(env.DB, 'site_version', at, actor.email).run();
  return requestPublish(env, ctx, { reason: 'Update website now', actor, at });
}

/**
 * Fires a due automatic publish (stock-status changes): when publish_due_at ≤ now, bumps site_version and
 * requests a build. Returns 'not_due' when there is nothing to do.
 */
export async function publishIfDue(env: PublishEnv, ctx: WaitCtx, at: string = nowIso(), opts: { fetch?: Fetcher } = {}): Promise<PublishRequest | { state: 'not_due'; dueAt: string | null }> {
  const due = await first<{ value: string }>(env.DB, "SELECT value FROM settings WHERE key = 'publish_due_at'");
  const dueAt = due ? (JSON.parse(due.value) as string | null) : null;
  if (!dueAt || dueAt > at) return { state: 'not_due', dueAt };
  if (!hookUrl(env)) return { state: 'disabled', message: DISABLED_MESSAGE };
  await bumpVersionStmt(env.DB, 'site_version', at, SYSTEM.email).run();
  return requestPublish(env, ctx, { reason: 'Stock status changed', actor: SYSTEM, at, fetch: opts.fetch });
}

/**
 * Marks requested builds up to `builtSiteVersion` (from the live /build.json) as live and remembers it as
 * published_version. Call it from the status endpoint after reading /build.json.
 */
export async function markPublished(db: D1, builtSiteVersion: number, at: string = nowIso()): Promise<number> {
  if (!Number.isSafeInteger(builtSiteVersion) || builtSiteVersion < 1) return 0;
  const res = await db.batch([
    stmt(db, "UPDATE publishes SET status = 'live', live_at = ?, error = NULL WHERE status IN ('requested', 'failed') AND site_version <= ?", at, builtSiteVersion),
    stmt(db, `UPDATE settings SET value = CAST(? AS TEXT), updated_at = ?, updated_by = 'system'
      WHERE key = 'published_version' AND CAST(value AS INTEGER) < ?`, builtSiteVersion, at, builtSiteVersion),
  ]);
  return res[0].meta.changes;
}

export type PublishState = 'disabled' | 'up_to_date' | 'updating' | 'waiting' | 'failed';

export interface PublishStatus {
  state: PublishState;
  /** the admin header text */
  message: string;
  siteVersion: number;
  publishedVersion: number;
  dueAt: string | null;
  last: { id: number; siteVersion: number; reason: string; requestedAt: string; status: 'requested' | 'live' | 'failed'; liveAt: string | null; error: string | null } | null;
}

/**
 * The website status chip: "Website up to date ✓ (10:42)", "Updating… started 2 min ago",
 * "Changes waiting, automatic update at 11:05", "Update didn't finish…" (after 25 minutes), or publishing off.
 * Pass `builtSiteVersion` when /build.json was read (it also marks builds live).
 */
export async function getPublishStatus(env: PublishEnv, at: string = nowIso(), builtSiteVersion?: number | null): Promise<PublishStatus> {
  if (builtSiteVersion) await markPublished(env.DB, builtSiteVersion, at);
  const [settings, last] = await Promise.all([
    all<{ key: string; value: string }>(env.DB, "SELECT key, value FROM settings WHERE key IN ('site_version', 'published_version', 'publish_due_at')"),
    first<{ id: number; site_version: number; reason: string; requested_at: string; status: 'requested' | 'live' | 'failed'; live_at: string | null; error: string | null }>(env.DB,
      'SELECT id, site_version, reason, requested_at, status, live_at, error FROM publishes ORDER BY id DESC LIMIT 1'),
  ]);
  const get = (k: string) => JSON.parse(settings.find((s) => s.key === k)?.value ?? 'null');
  const siteVersion = Number(get('site_version') ?? 1);
  const publishedVersion = Number(get('published_version') ?? 0);
  const dueAt = get('publish_due_at') as string | null;
  const lastOut = last ? { id: last.id, siteVersion: last.site_version, reason: last.reason, requestedAt: last.requested_at, status: last.status, liveAt: last.live_at, error: last.error } : null;
  const base = { siteVersion, publishedVersion, dueAt, last: lastOut };
  if (!hookUrl(env)) return { ...base, state: 'disabled', message: 'Publishing is off on this computer.' };
  if (last && last.status === 'requested' && last.site_version > publishedVersion) {
    if (addTime(last.requested_at, { minutes: BUILD_TIMEOUT_MINUTES }) <= at) {
      return { ...base, state: 'failed', message: "Update didn't finish. Your website is safe and shows the previous version." };
    }
    const mins = Math.max(0, Math.floor((Date.parse(at) - Date.parse(last.requested_at)) / 60_000));
    return { ...base, state: 'updating', message: `Updating… started ${mins} min ago` };
  }
  if (last && last.status === 'failed' && last.site_version > publishedVersion) {
    return { ...base, state: 'failed', message: "Update didn't finish. Your website is safe and shows the previous version." };
  }
  if (dueAt) return { ...base, state: 'waiting', message: `Changes waiting, automatic update at ${istTime(dueAt)}` };
  if (siteVersion > publishedVersion && publishedVersion > 0) return { ...base, state: 'waiting', message: 'Changes waiting. Update the website to show them.' };
  const when = last?.live_at ?? last?.requested_at;
  return { ...base, state: 'up_to_date', message: `Website up to date ✓${when ? ` (${istTime(when)})` : ''}` };
}
