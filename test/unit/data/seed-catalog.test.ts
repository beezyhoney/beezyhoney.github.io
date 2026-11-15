import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { buildSeedSql, imageSize, listRepoImages } from '../../../scripts/make-seed.mjs';
import { SETTINGS_DEFAULTS } from '../../../src/server/settings.defaults.mjs';
import { validateCatalog } from '../../../src/data/catalog.validate.mjs';
import { buildCatalog, buildLivePayload, getVersions, liveOffer } from '../../../src/server/catalog';
import { updateSettings } from '../../../src/server/settings';
import { addHarvest, countStock } from '../../../src/server/stock';
import { SITE } from '../../../src/data/site';
import { OWNER, ROOT, SEED_FILE, freshDb, pool, row, rows, t } from '../../helpers/db';

const snapshot = () => JSON.parse(readFileSync(join(ROOT, 'src/data/catalog.snapshot.json'), 'utf8'));

describe('seed (db/seed.sql)', () => {
  test('is up to date with the snapshot (make-seed --check)', () => {
    const r = spawnSync(process.execPath, ['scripts/make-seed.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(SEED_FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(buildSeedSql(snapshot()));
  });

  test('16 products, 47 packs (35 priced), 18 pools per A3, 4 categories, every repo photo, all settings', async () => {
    const db = await freshDb();
    const n = async (sql: string) => (await row<{ n: number }>(db, sql)).n;
    expect(await n('SELECT COUNT(*) AS n FROM products')).toBe(16);
    expect(await n("SELECT COUNT(*) AS n FROM products WHERE status = 'live' AND first_live_at IS NOT NULL")).toBe(16);
    expect(await n('SELECT COUNT(*) AS n FROM variants')).toBe(47);
    expect(await n('SELECT COUNT(*) AS n FROM variants WHERE price_paise IS NOT NULL')).toBe(35);
    expect(await n('SELECT COUNT(*) AS n FROM variants WHERE price_paise IS NULL')).toBe(12);
    expect(await n('SELECT COUNT(*) AS n FROM variants WHERE mrp_paise IS NOT NULL')).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM categories')).toBe(4);
    expect(await n('SELECT COUNT(*) AS n FROM images')).toBe(listRepoImages().length);
    expect(await n('SELECT COUNT(*) AS n FROM settings')).toBe(Object.keys(SETTINGS_DEFAULTS).length);
    expect(await n('SELECT COUNT(*) AS n FROM admin_users')).toBe(0);
    for (const t of ['orders', 'order_lines', 'stock_moves', 'payments', 'harvests', 'batches', 'login_codes', 'admin_sessions', 'recovery_codes', 'audit_log']) {
      expect(await n(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    }
    // pools (A3): one gram pool per honey, one piece pool per candle size, one honey-stick pool
    const pools = await rows<{ code: string; unit: string; track_stock: number; on_hand: number; low_at: number }>(db, 'SELECT code, unit, track_stock, on_hand, low_at FROM stock_pools ORDER BY id');
    expect(pools).toHaveLength(18);
    expect(pools.filter((p) => p.unit === 'g')).toHaveLength(14);
    expect(pools.filter((p) => p.unit === 'piece').map((p) => p.code)).toEqual(['beeswax-candles:small', 'beeswax-candles:medium', 'beeswax-candles:large', 'honey-sticks']);
    expect(pools.every((p) => p.track_stock === 0 && p.on_hand === 0)).toBe(true);
    expect(pools.find((p) => p.code === 'murungai-honey')!.low_at).toBe(2000);
    expect(pools.find((p) => p.code === 'honey-sticks')!.low_at).toBe(5);
    // pack → pool quantity: grams for honey, pieces otherwise
    const v = await rows<{ code: string; pool: string; pool_qty: number; net_grams: number | null }>(db,
      'SELECT v.code, s.code AS pool, v.pool_qty, v.net_grams FROM variants v JOIN stock_pools s ON s.id = v.pool_id');
    for (const x of v) {
      if (x.pool.endsWith('-honey')) expect(x.pool_qty, x.code).toBe(x.net_grams);
    }
    expect(v.find((x) => x.code === 'honey-sticks:box-10')).toMatchObject({ pool: 'honey-sticks', pool_qty: 10 });
    expect(v.find((x) => x.code === 'honey-sticks:1-stick')).toMatchObject({ pool: 'honey-sticks', pool_qty: 1 });
    expect(v.find((x) => x.code === 'beeswax-candles:medium')).toMatchObject({ pool: 'beeswax-candles:medium', pool_qty: 1 });
    // prices = START_PRICES (via the snapshot); show_prices off (A6)
    expect((await row<{ price_paise: number }>(db, "SELECT price_paise FROM variants WHERE code = 'murungai-honey:250g'")).price_paise).toBe(31000);
    expect((await row<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'show_prices'")).value).toBe('false');
    expect(await rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('has no personal data: no email address, no owner-only facts; business details are the public ones', () => {
    const sql = readFileSync(SEED_FILE, 'utf8');
    expect(sql).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(sql).not.toMatch(/INSERT INTO admin_users/);
    const business = SETTINGS_DEFAULTS.business as { name: string; customerCare: string; fssai: string };
    expect(business.name).toBe(SITE.farm);
    expect(business.customerCare).toBe(SITE.phoneDisplay);
    expect(business.fssai).toBe(SITE.fssai);
  });

  test('settings defaults match the snapshot settings', () => {
    const s = snapshot().settings;
    expect(SETTINGS_DEFAULTS.show_prices).toBe(s.showPrices);
    expect(SETTINGS_DEFAULTS.stock_display).toBe(s.stockDisplay);
    expect(SETTINGS_DEFAULTS.delivery_note).toBe(s.deliveryNote);
    expect(SETTINGS_DEFAULTS.offer).toEqual(s.offer);
    expect(SETTINGS_DEFAULTS.gift).toEqual(s.gift);
  });

  test('image sizes are read from JPEG and PNG headers', () => {
    const png = readFileSync(join(ROOT, 'src/assets/img/bni-member.png'));
    expect(imageSize(png)).toEqual({ width: 900, height: 578, type: 'png' });
    expect(() => imageSize(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('catalog builder (D1 → catalog.types format)', () => {
  test('deep-equals the snapshot, field order included (except the version fields)', async () => {
    const db = await freshDb();
    const snap = snapshot();
    const c = await buildCatalog(db);
    expect(validateCatalog(c)).toEqual([]);
    expect({ ...c, siteVersion: 0, liveVersion: 0 }).toEqual({ ...snap, siteVersion: 0, liveVersion: 0 });
    expect(JSON.stringify(c)).toBe(JSON.stringify(snap));
  });

  test('a seed from another catalog (paused, retired, batches) round-trips too, and drafts never appear', async () => {
    const snap = snapshot();
    snap.products.find((p: { slug: string }) => p.slug === 'litchi-honey').status = 'paused';
    snap.products.find((p: { slug: string }) => p.slug === 'kombu-honey').status = 'retired';
    snap.batches = [
      { code: 'KOM-2511-01', productSlug: 'kombu-honey', harvested: 'October 2025', packed: '2025-11-05', bestBefore: '2027-11', note: null },
      { code: 'TST-2001-02', productSlug: 'murungai-honey', harvested: 'January 2020', packed: '2020-01-20', bestBefore: '2022-01', note: 'Old test batch.' },
    ];
    snap.settings.offer = { text: 'Diwali gift boxes: order by 25 Oct', href: '/gift-box/', until: '2026-10-25' };
    snap.siteVersion = 7;
    snap.liveVersion = 9;
    const db = await freshDb({ seedSql: buildSeedSql(snap) });
    const c = await buildCatalog(db);
    expect(validateCatalog(c)).toEqual([]);
    expect(c).toEqual(snap);
    await db.prepare("UPDATE products SET status = 'draft' WHERE slug = 'tulasi-honey'").run();
    const c2 = await buildCatalog(db);
    expect(c2.products.map((p) => p.slug)).not.toContain('tulasi-honey');
    expect(c2.variants.some((v) => v.productSlug === 'tulasi-honey')).toBe(false);
    expect(c2.pools.some((v) => v.productSlug === 'tulasi-honey')).toBe(false);
    expect(validateCatalog(c2)).toEqual([]);
  });

  test('live payload: shape, live and paused products only, never counts or private fields', async () => {
    const db = await freshDb();
    const mur = await pool(db, 'murungai-honey');
    await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 123_456, batch: { privateNote: 'SECRET-NOTE' } }, t(0));
    await countStock(db, OWNER, { counts: [{ poolId: (await pool(db, 'honey-sticks')).id, amount: 7 }] }, t(1));
    await db.prepare("UPDATE products SET status = 'paused' WHERE slug = 'litchi-honey'").run();
    await db.prepare("UPDATE products SET status = 'retired' WHERE slug = 'kombu-honey'").run();
    const hidden = await buildLivePayload(db, t(2));
    expect(Object.keys(hidden)).toEqual(['lv', 'show', 'sd', 'p', 'offer', 'note']);
    expect(hidden).toMatchObject({ show: false, sd: 'sold_out', offer: null, note: 'Delivery charges are confirmed on WhatsApp.' });
    // while Show prices is off, no price or MRP is published at all
    expect(hidden.p['murungai-honey']['250 g']).toEqual([null, null, 'in', 'murungai-honey:250g']);
    expect(Object.values(hidden.p).every((packs) => Object.values(packs).every((e) => e[0] === null && e[1] === null))).toBe(true);
    await db.prepare("UPDATE settings SET value = 'true' WHERE key = 'show_prices'").run();
    const live = await buildLivePayload(db, t(2));
    expect(live.show).toBe(true);
    expect(Object.keys(live.p)).toContain('litchi-honey');
    expect(Object.keys(live.p)).not.toContain('kombu-honey');
    expect(live.p['murungai-honey']['250 g']).toEqual([31000, null, 'in', 'murungai-honey:250g']);
    expect(live.p['honey-sticks']).toEqual({ '1 stick': [700, null, 'in', 'honey-sticks:1-stick'], 'Box of 10 (100 g)': [7000, null, 'out', 'honey-sticks:box-10'] });
    expect(live.p['litchi-honey']['100 g']).toEqual([null, null, 'in', 'litchi-honey:100g']);
    const text = JSON.stringify(live);
    for (const leak of ['123456', '123.5', 'SECRET', 'on_hand', 'onHand', 'low_at', 'track', 'version"', '@']) expect(text, leak).not.toContain(leak);
    const cat = JSON.stringify(await buildCatalog(db));
    for (const leak of ['123456', 'SECRET', 'on_hand', 'onHand', 'lowAt', 'low_at', 'track', '@']) expect(cat, leak).not.toContain(leak);
  });

  test('settings changes reach the live payload and bump the right versions', async () => {
    const db = await freshDb();
    expect(await getVersions(db)).toEqual({ siteVersion: 1, liveVersion: 1 });
    const r = await updateSettings(db, OWNER, { values: { show_prices: true, offer: { text: 'Free delivery in Madurai', href: null, until: '2026-11-30' } } }, t(0));
    expect(r).toEqual({ ok: true, value: { changed: ['show_prices', 'offer'], effects: { publish: 'now', live: true } } });
    expect(await getVersions(db)).toEqual({ siteVersion: 2, liveVersion: 2 });
    const live = await buildLivePayload(db, t(1));
    expect(live).toMatchObject({ lv: 2, show: true, offer: { text: 'Free delivery in Madurai' } });
    expect('link' in live.offer!).toBe(false);
    expect(liveOffer({ text: 'x', href: '/gift-box/', until: '2026-11-30' }, '2026-11-30T18:29:00Z')).toEqual({ text: 'x', link: '/gift-box/' });
    expect(liveOffer({ text: 'x', href: null, until: '2026-11-30' }, '2026-11-30T18:30:00Z')).toBeNull(); // 1 Dec IST
  });
});
