// The public, read-only JSON endpoints and their edge cache (design §4):
//   GET /api/live.json      contract 2 (prices + availability). Cache API 60 s, then Cache-Control: public, max-age=30.
//   GET /api/catalog.json   the catalog for builds (src/data/catalog.types.ts). Cache key includes site_version and
//                           live_version (one small read first), so a saved change is never served stale.
//   GET /api/batch.json     Know Your Jar live lookup, public batch fields only, 60 s cache.
// The data comes from src/server/catalog.ts, which never returns stock amounts, low levels, tracking flags, notes,
// customer data or drafts. The cache key never includes the visitor's query string (except the normalised batch
// code), so random query strings cannot force D1 reads. On a D1 failure the endpoints answer 503 and the site keeps
// its baked values.
import { batchKey } from '../data/catalog.validate.mjs';
import { buildCatalog, buildLivePayload, getVersions, lookupBatch } from './catalog';
import type { D1 } from './db';

export const LIVE_EDGE_SECONDS = 60;
export const LIVE_BROWSER_SECONDS = 30;
export const CATALOG_EDGE_SECONDS = 300;
export const BATCH_EDGE_SECONDS = 60;
/** Codes longer than this are never looked up. */
export const MAX_BATCH_CODE = 40;

/** The part of the Workers Cache API used here (caches.default). */
export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface LiveEnv {
  DB: D1;
}

export interface CacheOpts {
  /** default: caches.default when it exists; null turns the cache off */
  cache?: EdgeCache | null;
  ctx?: { waitUntil(p: Promise<unknown>): void } | null;
  at?: string;
}

/** caches.default in workerd (null elsewhere). */
export function defaultCache(): EdgeCache | null {
  return (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;
}

const pickCache = (o: CacheOpts) => (o.cache === undefined ? defaultCache() : o.cache);

const JSON_TYPE = 'application/json; charset=utf-8';

function json(body: unknown, status: number, cacheControl: string, extra: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': JSON_TYPE, 'cache-control': cacheControl, 'x-content-type-options': 'nosniff', ...extra },
  });
}

/** A copy of a (possibly immutable) cached response with the browser-facing headers. */
function served(res: Response, cacheControl: string, state: 'hit' | 'miss'): Response {
  const out = new Response(res.body, res);
  out.headers.set('cache-control', cacheControl);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('x-beezy-cache', state);
  return out;
}

/**
 * Serves `key` from the edge cache, or builds it (`build` returns the JSON body and status), stores a copy for
 * `edgeSeconds` (inside waitUntil when there is a ctx) and returns it with `browserCacheControl`.
 */
async function cachedJson(
  o: CacheOpts,
  key: string,
  edgeSeconds: number,
  browserCacheControl: string,
  build: () => Promise<{ body: unknown; status?: number }>,
): Promise<Response> {
  const cache = pickCache(o);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return served(hit, browserCacheControl, 'hit');
    } catch {
      // a cache failure only costs a D1 read
    }
  }
  let built: { body: unknown; status?: number };
  try {
    built = await build();
  } catch (e) {
    console.error('[api] read failed:', e instanceof Error ? e.message : e);
    return json({ error: 'unavailable' }, 503, 'no-store', { 'retry-after': '30' });
  }
  const status = built.status ?? 200;
  const stored = json(built.body, status, `public, max-age=${edgeSeconds}`);
  if (cache) {
    const put = cache.put(key, stored.clone()).catch(() => undefined);
    if (o.ctx) o.ctx.waitUntil(put);
    else await put;
  }
  return served(stored, browserCacheControl, 'miss');
}

/** GET /api/live.json */
export function liveJsonResponse(e: LiveEnv, request: Request, o: CacheOpts = {}): Promise<Response> {
  const url = new URL(request.url);
  return cachedJson(o, `${url.origin}/api/live.json`, LIVE_EDGE_SECONDS, `public, max-age=${LIVE_BROWSER_SECONDS}`,
    async () => ({ body: await buildLivePayload(e.DB, o.at) }));
}

/** GET /api/catalog.json */
export async function catalogJsonResponse(e: LiveEnv, request: Request, o: CacheOpts = {}): Promise<Response> {
  const url = new URL(request.url);
  let versions: { siteVersion: number; liveVersion: number };
  try {
    versions = await getVersions(e.DB);
  } catch (err) {
    console.error('[api] catalog versions failed:', err instanceof Error ? err.message : err);
    return json({ error: 'unavailable' }, 503, 'no-store', { 'retry-after': '30' });
  }
  const key = `${url.origin}/api/catalog.json?sv=${versions.siteVersion}&lv=${versions.liveVersion}`;
  return cachedJson(o, key, CATALOG_EDGE_SECONDS, 'no-cache', async () => ({ body: await buildCatalog(e.DB) }));
}

/** GET /api/batch.json?code= → { found: false } or { found: true, code, productSlug, productName, harvested, packed, bestBefore, note } */
export function batchJsonResponse(e: LiveEnv, request: Request, o: CacheOpts = {}): Promise<Response> {
  const url = new URL(request.url);
  const raw = (url.searchParams.get('code') ?? '').slice(0, 200);
  const key = raw.length <= MAX_BATCH_CODE ? batchKey(raw) : '';
  const browser = `public, max-age=${BATCH_EDGE_SECONDS}`;
  if (key.length < 3) return Promise.resolve(served(json({ found: false }, 200, browser), browser, 'miss'));
  return cachedJson(o, `${url.origin}/api/batch.json?code=${key}`, BATCH_EDGE_SECONDS, browser, async () => {
    const b = await lookupBatch(e.DB, raw);
    if (!b) return { body: { found: false } };
    return {
      body: {
        found: true, code: b.code, productSlug: b.productSlug, productName: b.productName,
        harvested: b.harvested, packed: b.packed, bestBefore: b.bestBefore, note: b.note,
      },
    };
  });
}

/** 405 for a method an endpoint does not take. */
export function methodNotAllowed(allow: string): Response {
  return new Response('Method not allowed\n', {
    status: 405,
    headers: { allow, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
