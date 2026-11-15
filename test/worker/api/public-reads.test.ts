// GET /api/live.json, /api/catalog.json, /api/batch.json in workerd with the real D1 (seeded from db/seed.sql).
// Checks the contract-2 shape, the catalog whitelist (no counts, private notes or customer data), the edge cache
// and the batch lookup. Route modules are called directly (Astro's handler is not loaded in worker tests).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import snapshot from '../../../src/data/catalog.snapshot.json';
import { validateCatalog } from '../../../src/data/catalog.validate.mjs';
import { GET as batchGET, POST as batchPOST } from '../../../src/pages/api/batch.json';
import { GET as catalogGET } from '../../../src/pages/api/catalog.json';
import { GET as liveGET, POST as livePOST } from '../../../src/pages/api/live.json';
import {
  batchJsonResponse, catalogJsonResponse, defaultCache, LIVE_BROWSER_SECONDS, liveJsonResponse,
} from '../../../src/server/live';
import { fakeCtx, MemoryCache, row, seedDb, sql } from './_seed';

const ORIGIN = 'https://beezyhoney.in';
const req = (path: string) => new Request(`${ORIGIN}${path}`);
const routeCtx = (path: string, ctx = fakeCtx()) =>
  ({ request: req(path), url: new URL(`${ORIGIN}${path}`), params: {}, locals: { cfContext: ctx } }) as never;

beforeAll(async () => {
  await seedDb();
});

/** Private words and numbers that must never reach a public read. */
const FORBIDDEN_KEYS = /"(onHand|on_hand|lowAt|low_at|trackStock|track_stock|availability|privateNote|private_note|customer\w*|email|ip_?hash|phone|address|note_private|costPaise)"/i;

async function setSettings(values: Record<string, unknown>) {
  for (const [k, v] of Object.entries(values)) {
    await sql('UPDATE settings SET value = ?, version = version + 1 WHERE key = ?', JSON.stringify(v), k).run();
  }
}

describe('/api/live.json (contract 2)', () => {
  it('answers the exact shape, live and paused products, active packs', async () => {
    const res = await liveJsonResponse(env, req('/api/live.json'), { cache: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${LIVE_BROWSER_SECONDS}`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['lv', 'note', 'offer', 'p', 'sd', 'show']);
    expect(body.lv).toBe(1);
    expect(body.show).toBe(false);
    expect(body.sd).toBe('sold_out');
    expect(body.offer).toBeNull();
    expect(body.note).toBe('Delivery charges are confirmed on WhatsApp.');
    const p = body.p as Record<string, Record<string, unknown[]>>;
    const live = snapshot.products.filter((x) => x.status === 'live' || x.status === 'paused').map((x) => x.slug).sort();
    expect(Object.keys(p).sort()).toEqual(live);
    let entries = 0;
    for (const [slug, packs] of Object.entries(p)) {
      for (const [label, e] of Object.entries(packs)) {
        entries++;
        expect(e).toHaveLength(4);
        expect(e[0] === null || Number.isInteger(e[0])).toBe(true);
        expect(e[1] === null || Number.isInteger(e[1])).toBe(true);
        expect(['in', 'low', 'out']).toContain(e[2]);
        const v = snapshot.variants.find((x) => x.code === e[3]);
        expect(v, `${slug} ${label}`).toBeTruthy();
        expect(v!.productSlug).toBe(slug);
        expect(v!.label).toBe(label);
        expect(v!.active).toBe(true);
        // Show prices is off in the seed: no price or MRP is published
        expect(e[0]).toBeNull();
        expect(e[1]).toBeNull();
      }
    }
    expect(entries).toBe(snapshot.variants.filter((v) => v.active && live.includes(v.productSlug)).length);
  });

  it('publishes prices only while Show prices is on', async () => {
    await setSettings({ show_prices: true });
    const body = (await (await liveJsonResponse(env, req('/api/live.json'), { cache: null })).json()) as { show: boolean; p: Record<string, Record<string, unknown[]>> };
    expect(body.show).toBe(true);
    for (const packs of Object.values(body.p)) {
      for (const e of Object.values(packs)) {
        const v = snapshot.variants.find((x) => x.code === e[3])!;
        expect(e[0]).toBe(v.pricePaise);
      }
    }
    await setSettings({ show_prices: false });
  });

  it('never publishes stock amounts or low levels, only in / low / out', async () => {
    await sql("UPDATE stock_pools SET track_stock = 1, on_hand = 123457, low_at = 98765 WHERE code = 'murungai-honey'").run();
    const text = await (await liveJsonResponse(env, req('/api/live.json'), { cache: null })).text();
    expect(text).not.toMatch(/123457|98765/);
    expect(text).not.toMatch(FORBIDDEN_KEYS);
    // sold out by count: on hand smaller than one pack
    await sql("UPDATE stock_pools SET on_hand = 10 WHERE code = 'murungai-honey'").run();
    const body = (await (await liveJsonResponse(env, req('/api/live.json'), { cache: null })).json()) as { p: Record<string, Record<string, unknown[]>> };
    expect(Object.values(body.p['murungai-honey']).every((e) => e[2] === 'out')).toBe(true);
    await sql("UPDATE stock_pools SET track_stock = 0, on_hand = 0, low_at = 2000 WHERE code = 'murungai-honey'").run();
  });

  it('is served from the edge cache for 60 s, whatever the query string (no forced D1 reads)', async () => {
    const cache = new MemoryCache();
    const ctx = fakeCtx();
    const a = await liveJsonResponse(env, req('/api/live.json'), { cache, ctx });
    await ctx.settle();
    expect(a.headers.get('x-beezy-cache')).toBe('miss');
    expect(cache.puts).toEqual([`${ORIGIN}/api/live.json`]);
    const stored = cache.store.get(`${ORIGIN}/api/live.json`)!;
    expect(stored.headers.get('cache-control')).toBe('public, max-age=60');
    await setSettings({ delivery_note: 'Changed after caching.' });
    const b = await liveJsonResponse(env, req('/api/live.json?x=1&nocache=2'), { cache });
    expect(b.headers.get('x-beezy-cache')).toBe('hit');
    expect(b.headers.get('cache-control')).toBe('public, max-age=30');
    expect(((await b.json()) as { note: string }).note).toBe('Delivery charges are confirmed on WhatsApp.');
    const fresh = (await (await liveJsonResponse(env, req('/api/live.json'), { cache: null })).json()) as { note: string };
    expect(fresh.note).toBe('Changed after caching.');
    await setSettings({ delivery_note: 'Delivery charges are confirmed on WhatsApp.' });
  });

  it('works with the real Workers cache (caches.default)', async () => {
    expect(defaultCache()).not.toBeNull();
    const ctx = fakeCtx();
    const url = 'https://cache-test.beezyhoney.in/api/live.json';
    const a = await liveJsonResponse(env, new Request(url), { ctx });
    await ctx.settle();
    expect(a.status).toBe(200);
    const b = await liveJsonResponse(env, new Request(url), {});
    expect(b.headers.get('x-beezy-cache')).toBe('hit');
    expect(b.headers.get('cache-control')).toBe('public, max-age=30');
  });

  it('a D1 failure is a quiet 503 (the site keeps its baked prices)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { DB: { batch: () => Promise.reject(new Error('D1 down')), prepare: env.DB.prepare.bind(env.DB) } } as never;
    const res = await liveJsonResponse(broken, req('/api/live.json'), { cache: null });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('the route module answers GET and refuses POST', async () => {
    const res = await liveGET(routeCtx('/api/live.json'));
    expect(res.status).toBe(200);
    expect((await livePOST(routeCtx('/api/live.json'))).status).toBe(405);
  });
});

describe('/api/catalog.json', () => {
  it('equals the committed snapshot except the version fields, and passes the strict validator', async () => {
    const res = await catalogJsonResponse(env, req('/api/catalog.json'), { cache: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = (await res.json()) as Record<string, unknown>;
    expect(validateCatalog(body)).toEqual([]);
    const strip = (c: Record<string, unknown>) => ({ ...c, siteVersion: 0, liveVersion: 0 });
    expect(strip(body)).toEqual(strip(snapshot as unknown as Record<string, unknown>));
  });

  it('never leaks counts, private notes, customer data or drafts', async () => {
    await sql("UPDATE stock_pools SET track_stock = 1, on_hand = 555551, low_at = 444441 WHERE code = 'multifloral-honey'").run();
    const product = await row<{ id: number }>("SELECT id FROM products WHERE slug = 'murungai-honey'");
    await sql(`INSERT INTO batches (code, code_key, product_id, harvested_label, packed_on, best_before, public_note, private_note, is_public, status,
      created_at, created_by, updated_at, updated_by) VALUES ('MUR-2611-01', 'MUR261101', ?, 'November 2026', '2026-11-15', '2028-11',
      'Thick and pale.', 'SECRET-NOTE-XYZ', 1, 'active', '2026-11-15T10:00:00Z', 'owner@example.test', '2026-11-15T10:00:00Z', 'owner@example.test')`, product!.id).run();
    await sql(`INSERT INTO orders (ref, client_key, source, channel, status, customer_name, customer_phone, customer_address, ip_hash,
      created_at, updated_at, updated_by) VALUES ('BZ-7K3QD', NULL, 'manual', 'phone', 'new', 'Customer Name Q', '+91 99999 11111',
      'Street 12', 'iphash123', '2026-11-15T10:00:00Z', '2026-11-15T10:00:00Z', 'owner@example.test')`).run();
    await sql("UPDATE products SET status = 'draft', first_live_at = NULL WHERE slug = 'tulasi-honey'").run().catch(() => undefined);
    const text = await (await catalogJsonResponse(env, req('/api/catalog.json'), { cache: null })).text();
    expect(text).not.toMatch(/555551|444441|SECRET-NOTE-XYZ|Customer Name Q|99999|Street 12|iphash123|owner@example\.test/);
    expect(text).not.toMatch(FORBIDDEN_KEYS);
    const body = JSON.parse(text) as { batches: { code: string; note: string | null }[]; products: { slug: string }[] };
    expect(validateCatalog(body)).toEqual([]);
    expect(body.batches).toEqual([expect.objectContaining({ code: 'MUR-2611-01', note: 'Thick and pale.' })]);
    const draft = await row<{ status: string }>("SELECT status FROM products WHERE slug = 'tulasi-honey'");
    if (draft?.status === 'draft') expect(body.products.map((p) => p.slug)).not.toContain('tulasi-honey');
  });

  it('caches by site_version + live_version, so a saved change is never served stale', async () => {
    const cache = new MemoryCache();
    const a = await catalogJsonResponse(env, req('/api/catalog.json'), { cache });
    expect(a.headers.get('x-beezy-cache')).toBe('miss');
    expect((await catalogJsonResponse(env, req('/api/catalog.json?bust=1'), { cache })).headers.get('x-beezy-cache')).toBe('hit');
    await sql("UPDATE settings SET value = '7' WHERE key = 'site_version'").run();
    const c = await catalogJsonResponse(env, req('/api/catalog.json'), { cache });
    expect(c.headers.get('x-beezy-cache')).toBe('miss');
    expect(((await c.json()) as { siteVersion: number }).siteVersion).toBe(7);
    expect(cache.puts).toEqual([`${ORIGIN}/api/catalog.json?sv=1&lv=1`, `${ORIGIN}/api/catalog.json?sv=7&lv=1`]);
    await sql("UPDATE settings SET value = '1' WHERE key = 'site_version'").run();
  });

  it('the route module answers', async () => {
    const res = await catalogGET(routeCtx('/api/catalog.json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });
});

describe('/api/batch.json', () => {
  const ask = (code: string, cache: MemoryCache | null = null) =>
    batchJsonResponse(env, req(`/api/batch.json?code=${encodeURIComponent(code)}`), { cache });

  it('finds a public batch by code, ignoring case, spaces and punctuation; public fields only', async () => {
    const product = await row<{ id: number }>("SELECT id FROM products WHERE slug = 'multifloral-honey'");
    await sql(`INSERT INTO batches (code, code_key, product_id, harvested_label, packed_on, best_before, public_note, private_note, is_public, status,
      created_at, created_by, updated_at, updated_by) VALUES ('MUL-2610-02', 'MUL261002', ?, 'October 2026', '2026-10-20', '2028-10',
      NULL, 'PRIVATE-BATCH-NOTE', 1, 'active', '2026-11-15T10:00:00Z', 'owner@example.test', '2026-11-15T10:00:00Z', 'owner@example.test')`, product!.id).run();
    for (const typed of ['MUL-2610-02', 'mul 2610 02', 'mul261002']) {
      const res = await ask(typed);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toMatch(/PRIVATE-BATCH-NOTE|owner@example|private/i);
      expect(JSON.parse(text)).toEqual({
        found: true, code: 'MUL-2610-02', productSlug: 'multifloral-honey', productName: expect.any(String),
        harvested: 'October 2026', packed: '2026-10-20', bestBefore: '2028-10', note: null,
      });
    }
  });

  it('hidden, recalled and unknown batches are not found; nonsense is not looked up', async () => {
    await sql("UPDATE batches SET is_public = 0 WHERE code = 'MUL-2610-02'").run();
    expect(await (await ask('MUL-2610-02')).json()).toEqual({ found: false });
    await sql("UPDATE batches SET is_public = 1, status = 'recalled' WHERE code = 'MUL-2610-02'").run();
    expect(await (await ask('MUL-2610-02')).json()).toEqual({ found: false });
    await sql("UPDATE batches SET status = 'active' WHERE code = 'MUL-2610-02'").run();
    expect(await (await ask('NOPE-0000-00')).json()).toEqual({ found: false });
    const cache = new MemoryCache();
    for (const junk of ['', '--', 'x'.repeat(41)]) {
      const res = await ask(junk, cache);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ found: false });
    }
    expect(cache.puts).toEqual([]); // nothing was looked up or cached
  });

  it('is cached for 60 s per normalised code', async () => {
    const cache = new MemoryCache();
    expect((await ask('mul-2610-02', cache)).headers.get('x-beezy-cache')).toBe('miss');
    const hit = await ask('MUL 2610 02', cache);
    expect(hit.headers.get('x-beezy-cache')).toBe('hit');
    expect(hit.headers.get('cache-control')).toBe('public, max-age=60');
    expect(cache.puts).toEqual([`${ORIGIN}/api/batch.json?code=MUL261002`]);
  });

  it('the route module answers GET and refuses POST', async () => {
    const res = await batchGET(routeCtx('/api/batch.json?code=MUL-2610-02'));
    expect(((await res.json()) as { found: boolean }).found).toBe(true);
    expect((await batchPOST(routeCtx('/api/batch.json'))).status).toBe(405);
  });
});
