// The catalog admin's server code inside workerd with the real local D1 and KV bindings (Miniflare):
// photo upload (POST /admin/api/media.json) with EXIF/GPS stripping, draft previews, price bulk rules and the
// all-or-nothing price save, harvest → pool + batch, count sets the absolute amount, slug freeze, go-live rules and
// the shop-order update (which relies on SQLite evaluating the guard before any row changes).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import seedSql from '../../../db/seed.sql?raw';
import gpsJpeg from './fixtures/gps-1000x800.jpg?inline';
import smallJpeg from './fixtures/small-700x500.jpg?inline';
import thumbJpeg from './fixtures/thumb-480.jpg?inline';
import { handleUpload } from '../../../src/pages/admin/api/media.json';
import { serveMedia } from '../../../src/server/media';
import { bulkPreview, listPriceGrid, savePrices } from '../../../src/server/prices';
import { createProduct, getProductEditor, moveProduct, saveProduct, setProductStatus, type ProductInput } from '../../../src/server/products-admin';
import { addHarvest, countStock, getPool, listBatches } from '../../../src/server/stock';
import { buildCatalog } from '../../../src/server/catalog';
import { validateCatalog } from '../../../src/data/catalog.validate.mjs';

const OWNER = { email: 'owner@example.test', role: 'owner' as const };
const HELPER = { email: 'helper@example.test', role: 'helper' as const };
const DB = env.DB as unknown as Parameters<typeof savePrices>[0];
const at = (min: number) => `${new Date(Date.parse('2026-11-15T04:30:00Z') + min * 60_000).toISOString().slice(0, 19)}Z`;

/** data: URL (from ?inline) → bytes */
function bytesOf(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

beforeAll(async () => {
  const statements = seedSql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
});

function uploadRequest(file: Uint8Array | null, thumb: Uint8Array | null, type = 'image/jpeg'): Request {
  const fd = new FormData();
  if (file) fd.append('file', new Blob([file], { type }), 'photo.jpg');
  if (thumb) fd.append('thumb', new Blob([thumb], { type: 'image/jpeg' }), 'thumb.jpg');
  return new Request('http://127.0.0.1/admin/api/media.json', { method: 'POST', body: fd });
}

function segments(b: Uint8Array): number[] {
  const out: number[] = [];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff && b[i + 1] !== 0xda) {
    out.push(b[i + 1]);
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return out;
}

describe('photo upload (KV MEDIA)', () => {
  test('stores a stripped JPEG + thumbnail, an images row (not public) and an audit row', async () => {
    const original = bytesOf(gpsJpeg);
    expect(segments(original)).toEqual(expect.arrayContaining([0xe1, 0xed, 0xfe]));
    const res = await handleUpload(uploadRequest(original, bytesOf(thumbJpeg)), HELPER, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json<{ ok: true; path: string; thumbPath: string; width: number; height: number; thumbUrl: string }>();
    expect(body).toMatchObject({ ok: true, width: 1000, height: 800 });
    expect(body.path).toMatch(/^uploads\/[0-9A-HJKMNP-TV-Z]{26}\.jpg$/);
    expect(body.thumbUrl).toBe(`/admin/media/${body.thumbPath}`);
    const stored = new Uint8Array((await env.MEDIA.get(body.path, 'arrayBuffer'))!);
    expect(segments(stored)).not.toContain(0xe1); // Exif (and its GPS block) gone
    expect(segments(stored)).not.toContain(0xed); // IPTC gone
    expect(segments(stored)).not.toContain(0xfe); // comment gone
    const text = new TextDecoder('latin1').decode(stored);
    expect(text).not.toContain('GPS-Phone');
    expect(text).not.toContain('secret comment');
    expect(stored[0]).toBe(0xff);
    const meta = await env.MEDIA.getWithMetadata(body.path);
    expect(meta.metadata).toMatchObject({ contentType: 'image/jpeg', width: 1000, height: 800 });
    const row = await env.DB.prepare('SELECT source, public, width FROM images WHERE path = ?').bind(body.path).first();
    expect(row).toEqual({ source: 'upload', public: 0, width: 1000 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'media.upload'").first('n')).toBe(1);

    // a draft photo: the admin preview works, the public route does not
    const pub = await serveMedia(env as never, new Request(`http://x/media/${body.path}`), body.path, { requirePublic: true, cache: null });
    expect(pub.status).toBe(404);
    const adm = await serveMedia(env as never, new Request(`http://x/admin/media/${body.path}`), body.path, { requirePublic: false });
    expect(adm.status).toBe(200);
    expect(adm.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('refuses non-JPEG, too-small photos, a missing thumbnail, a wrong content type and signed-out requests', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const r1 = await handleUpload(uploadRequest(png, bytesOf(thumbJpeg), 'image/png'), OWNER, env);
    expect(r1.status).toBe(422);
    expect(await r1.json()).toMatchObject({ ok: false, field: 'file', message: 'Please choose a JPG photo.' });
    const r2 = await handleUpload(uploadRequest(bytesOf(smallJpeg), bytesOf(thumbJpeg)), OWNER, env);
    expect(await r2.json()).toMatchObject({ ok: false, field: 'file', message: expect.stringContaining('too small') });
    const r3 = await handleUpload(uploadRequest(bytesOf(gpsJpeg), null), OWNER, env);
    expect(await r3.json()).toMatchObject({ ok: false, field: 'thumb' });
    const r4 = await handleUpload(new Request('http://x/', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } }), OWNER, env);
    expect(r4.status).toBe(415);
    const r5 = await handleUpload(uploadRequest(bytesOf(gpsJpeg), bytesOf(thumbJpeg)), undefined, env);
    expect(r5.status).toBe(401);
    const big = new Request('http://x/', { method: 'POST', body: 'x', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(20 * 1024 * 1024) } });
    expect((await handleUpload(big, OWNER, env)).status).toBe(413);
  });
});

describe('stock: harvest and count', () => {
  test('a 100 kg harvest adds to the pool, starts tracking and makes the batch', async () => {
    const r = await addHarvest(DB, OWNER, { poolId: 1, harvestedOn: '2026-11-15', amount: 100_000, idemKey: 'h-1' }, at(0));
    expect(r).toMatchObject({ ok: true, value: { onHand: 100_000, batchCode: 'MUR-2611-01', startedTracking: true } });
    expect(await addHarvest(DB, OWNER, { poolId: 1, harvestedOn: '2026-11-15', amount: 100_000, idemKey: 'h-1' }, at(1))).toMatchObject({ ok: false, error: 'conflict' });
    const p = await getPool(DB, 1);
    expect(p).toMatchObject({ amountText: '100.0 kg', trackStock: true });
    const b = (await listBatches(DB)).find((x) => x.code === 'MUR-2611-01');
    expect(b).toMatchObject({ bestBefore: '2028-11', isPublic: true, estimatedLeft: 100_000 });
  });

  test('a count sets the absolute amount', async () => {
    const r = await countStock(DB, HELPER, { counts: [{ poolId: 1, amount: 99_500 }, { poolId: 15, amount: 12 }] }, at(2));
    expect(r.ok).toBe(true);
    expect((await getPool(DB, 1))?.onHand).toBe(99_500);
    expect((await getPool(DB, 15))).toMatchObject({ onHand: 12, trackStock: true, amountText: '12 pieces' });
    const again = await countStock(DB, HELPER, { counts: [{ poolId: 1, amount: 99_500 }] }, at(3));
    expect(again).toMatchObject({ ok: true, value: { changed: [] } });
    expect((await getPool(DB, 1))?.onHand).toBe(99_500);
  });
});

describe('prices', () => {
  test('bulk +10 % rounded to ₹5, saved all or nothing on real D1', async () => {
    const grid = await listPriceGrid(DB);
    const pv = bulkPreview(grid.filter((r) => r.productId === 2), 'pct', 10);
    expect(pv.map((c) => c.pricePaise)).toEqual([14000, 32000, 66000]); // ₹125 → ₹137.5 → ₹140; ₹290 → ₹319 → ₹320; ₹599 → ₹658.9 → ₹660
    const stale = pv.map((c, i) => (i === 2 ? { ...c, version: c.version + 5 } : c));
    expect(await savePrices(DB, OWNER, { changes: stale }, at(4))).toMatchObject({ ok: false, error: 'conflict' });
    expect((await env.DB.prepare('SELECT price_paise FROM variants WHERE id = 4').first('price_paise'))).toBe(12500);
    const ok = await savePrices(DB, OWNER, { changes: pv, reason: 'Bulk change: Raise by % 10' }, at(5));
    expect(ok).toMatchObject({ ok: true, value: { effects: { publish: 'now', live: true } } });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM price_history').first('n')).toBe(3);
    expect(validateCatalog(await buildCatalog(DB))).toEqual([]);
  });
});

describe('products', () => {
  test('new product with an uploaded photo goes live; the slug freezes; the photo becomes public', async () => {
    const up = await handleUpload(uploadRequest(bytesOf(gpsJpeg), bytesOf(thumbJpeg)), OWNER, env);
    const { path } = await up.json<{ path: string }>();
    const c = await createProduct(DB, OWNER, { name: 'Jamun Honey', category: 'blossom-honey' }, at(6));
    if (!c.ok) throw new Error(c.message);
    let e = (await getProductEditor(DB, c.value.id))!;
    expect(await setProductStatus(DB, OWNER, { id: e.id, version: e.version, action: 'go_live' }, at(7))).toMatchObject({ ok: false, field: 'photo' });
    const input: ProductInput = {
      id: e.id, version: e.version, name: e.name, category: e.category, kind: 'Monofloral', badge: 'Single flower', withComb: false,
      tagline: 'From jamun trees.', tone: '#E8E1F0', photo: path, card: null, gallery: [{ src: path, caption: 'A jar of jamun honey' }],
      specs: [['Taste', 'Fruity']], colour: [4, 5], about: 'Dark and fruity.', love: ['Rare'], useHead: null, use: 'By the spoon.',
      store: 'Keep dry.', finder: null, bloom: [3, 4], bloomNote: null, inGiftBox: false, slug: 'jamun-honey',
    };
    expect((await saveProduct(DB, OWNER, input, at(8))).ok).toBe(true);
    e = (await getProductEditor(DB, e.id))!;
    const live = await setProductStatus(DB, OWNER, { id: e.id, version: e.version, action: 'go_live' }, at(9));
    expect(live).toMatchObject({ ok: true, value: { status: 'live' } });
    expect(await env.DB.prepare('SELECT public FROM images WHERE path = ?').bind(path).first('public')).toBe(1);
    const pub = await serveMedia(env as never, new Request(`http://x/media/${path}`), path, { requirePublic: true, cache: null });
    expect(pub.status).toBe(200);
    e = (await getProductEditor(DB, e.id))!;
    expect(await saveProduct(DB, OWNER, { ...input, version: e.version, slug: 'jamun-blossom-honey' }, at(10))).toMatchObject({ ok: false, field: 'slug' });
    const cat = await buildCatalog(DB);
    expect(validateCatalog(cat)).toEqual([]);
    expect(cat.products.find((p) => p.slug === 'jamun-honey')).toMatchObject({ photo: path, status: 'live' });
  });

  test('shop order: one guarded UPDATE renumbers every product on real D1', async () => {
    const r = await moveProduct(DB, OWNER, { id: 3, direction: 'up' }, at(11));
    expect(r.ok).toBe(true);
    const ids = (await env.DB.prepare('SELECT id, sort FROM products ORDER BY sort, slug').all<{ id: number; sort: number }>()).results;
    expect(ids.slice(0, 3).map((x) => x.id)).toEqual([1, 3, 2]);
    expect(ids.map((x) => x.sort)).toEqual(ids.map((_, i) => i + 1));
  });
});
