// src/server/products-admin.ts on the D1 shim (seeded catalog).
import { describe, expect, test } from 'vitest';
import { validateCatalog } from '../../../src/data/catalog.validate.mjs';
import { GRADES as SITE_GRADES } from '../../../src/data/products';
import { buildCatalog, buildLivePayload } from '../../../src/server/catalog';
import {
  GRADES, addPool, checkProductInput, createProduct, getProductEditor, listProductsAdmin, moveProduct, packSuffix,
  saveProduct, savePacks, seasonOrder, setProductStatus, shortCodeCandidates, slugify, stockOverview, suggestBatchCodes,
  suggestShortCode, suggestSlug, type PackInput, type ProductEditor, type ProductInput,
} from '../../../src/server/products-admin';
import { addHarvest } from '../../../src/server/stock';
import { HELPER, OWNER, freshDb, pool, row, rows, t } from '../../helpers/db';

type Db = Awaited<ReturnType<typeof freshDb>>;
const setting = async (db: Db, key: string) => JSON.parse((await row<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key)).value);

/** The editor's current values as a save input */
function inputOf(e: ProductEditor, patch: Partial<ProductInput> = {}): ProductInput {
  return {
    id: e.id, version: e.version, name: e.name, category: e.category, kind: e.kind, badge: e.badge, withComb: e.withComb,
    tagline: e.tagline, tone: e.tone, photo: e.photo, card: e.card, gallery: e.gallery, specs: e.specs, colour: e.colour,
    about: e.about, love: e.love, useHead: e.useHead, use: e.use, store: e.store, finder: e.finder, bloom: e.bloom,
    bloomNote: e.bloomNote, inGiftBox: e.inGiftBox, ...patch,
  };
}
const packsOf = (e: ProductEditor): PackInput[] => e.packs.map((p) => ({ id: p.id, version: p.version, label: p.label, netGrams: p.netGrams, poolId: p.poolId, poolQty: p.poolQty, pricePaise: p.pricePaise, mrpPaise: p.mrpPaise, active: p.active, giftOk: p.giftOk }));

describe('helpers', () => {
  test('slugs, pack codes, short codes and season order', () => {
    expect(slugify('Jamun Honey')).toBe('jamun-honey');
    expect(slugify('  Neela Kurinji — Wild & Rare!! ')).toBe('neela-kurinji-wild-and-rare');
    expect(packSuffix('250 g')).toBe('250g');
    expect(packSuffix('Box of 10 (100 g)')).toBe('box-of-10-100g');
    expect(packSuffix('1 kg')).toBe('1kg');
    expect(shortCodeCandidates('Jamun Honey')[0]).toBe('JAM');
    expect(shortCodeCandidates('Honey with comb').every((c) => /^[A-Z]{2,4}$/.test(c))).toBe(true);
    expect(seasonOrder([1, 2, 12])).toEqual([12, 1, 2]);
    expect(seasonOrder([3, 4, 5])).toEqual([3, 4, 5]);
    expect(seasonOrder([11, 12, 1, 2, 6])).toEqual([11, 12, 1, 2, 6]);
  });

  test('GRADES matches the public site', () => {
    expect(GRADES).toEqual(SITE_GRADES);
  });

  test('suggested slug and short code avoid the ones in use', async () => {
    const db = await freshDb();
    expect(await suggestSlug(db, 'Murungai Honey')).toBe('murungai-honey-2');
    expect(await suggestSlug(db, 'Murungai Honey', 1)).toBe('murungai-honey');
    expect(await suggestShortCode(db, 'Murungai')).not.toBe('MUR');
    expect(await suggestShortCode(db, 'Jamun Honey')).toBe('JAM');
  });

  test('typing rules name the form field', () => {
    const base = { id: 1, version: 1, name: 'Jamun Honey', category: 'blossom-honey', kind: '', badge: '', withComb: false, tagline: '', tone: '#EEF0D6', photo: null, card: null, gallery: [], specs: [], colour: null, about: '', love: [], useHead: null, use: '', store: '', finder: null, bloom: null, bloomNote: null, inGiftBox: false } as ProductInput;
    expect(checkProductInput(base)).toBeNull();
    expect(checkProductInput({ ...base, name: 'J' })?.field).toBe('name');
    expect(checkProductInput({ ...base, tone: 'red' })?.field).toBe('tone');
    expect(checkProductInput({ ...base, slug: 'Bad Slug' })?.field).toBe('slug');
    expect(checkProductInput({ ...base, gallery: [{ src: 'a.jpg', caption: 'ok' }] })?.field).toBe('g_cap_0');
    expect(checkProductInput({ ...base, specs: [['Taste', '']] })?.field).toBe('spec_0');
    expect(checkProductInput({ ...base, colour: [5, 2] })?.field).toBe('colour');
    expect(checkProductInput({ ...base, finder: { taste: [], uses: ['daily'], rare: false } })?.field).toBe('finder');
    expect(checkProductInput({ ...base, bloom: [13] })?.field).toBe('bloom');
    expect(checkProductInput({ ...base, bloomNote: 'Once in 12 years' })?.field).toBe('bloom_note');
  });
});

describe('list and editor', () => {
  test('cards carry status, price range and stock in kg / pieces', async () => {
    const db = await freshDb();
    const list = await listProductsAdmin(db);
    expect(list).toHaveLength(16);
    const mur = list.find((p) => p.slug === 'murungai-honey')!;
    expect(mur).toMatchObject({ status: 'live', priceMin: 14000, priceMax: 65000, activePacks: 3, unpriced: 0 });
    expect(mur.stock).toEqual([{ poolId: 1, name: 'Murungai Honey', unit: 'g', amountText: '0.0 kg', level: 'untracked' }]);
    expect(list.find((p) => p.slug === 'karanji-honey')).toMatchObject({ priceMin: null, unpriced: 3 });
    expect(list.find((p) => p.slug === 'beeswax-candles')!.stock.map((s) => s.amountText)).toEqual(['0 pieces', '0 pieces', '0 pieces']);
  });

  test('stock overview: days of cover from the last 30 days', async () => {
    const db = await freshDb();
    const r = await stockOverview(db);
    expect(r.pools).toHaveLength(18);
    expect(r.low).toEqual([]);
    await addHarvest(db, OWNER, { poolId: (await pool(db, 'murungai-honey')).id, harvestedOn: '2026-11-15', amount: 1_000 }, t(0));
    const r2 = await stockOverview(db, { at: t(1) });
    expect(r2.low.map((p) => [p.code, p.level])).toEqual([['murungai-honey', 'low']]); // 1 kg ≤ the 2 kg low level
  });

  test('suggested batch codes for many products in one read', async () => {
    const db = await freshDb();
    await addHarvest(db, OWNER, { poolId: 1, harvestedOn: '2026-11-10', amount: 5_000 }, t(0));
    const m = await suggestBatchCodes(db, [1, 2], '2026-11-15');
    expect(m.get(1)).toBe('MUR-2611-02');
    expect(m.get(2)).toBe('MUL-2611-01');
  });
});

describe('saveProduct', () => {
  test('a live product: saved, photos public, site_version + 1, publish now; the catalog stays valid', async () => {
    const db = await freshDb();
    const e = (await getProductEditor(db, 1))!;
    const before = await setting(db, 'site_version');
    const r = await saveProduct(db, OWNER, inputOf(e, { tagline: 'New tagline.', bloom: [2, 1, 12] }), t(0));
    expect(r).toMatchObject({ ok: true, value: { version: 2, effects: { publish: 'now', live: false } } });
    expect(await setting(db, 'site_version')).toBe(before + 1);
    const p = await row<{ tagline: string; bloom_json: string }>(db, 'SELECT tagline, bloom_json FROM products WHERE id = 1');
    expect(p.tagline).toBe('New tagline.');
    expect(JSON.parse(p.bloom_json)).toEqual([12, 1, 2]);
    expect((await row<{ public: number }>(db, 'SELECT public FROM images WHERE path = ?', e.photo)).public).toBe(1);
    const audit = await row<{ action: string; summary: string }>(db, "SELECT action, summary FROM audit_log WHERE action = 'product.save'");
    expect(audit.summary).toContain('tagline');
    expect(validateCatalog(await buildCatalog(db))).toEqual([]);
  });

  test('stale version → conflict and nothing changes; helpers are refused; empty save is a no-op', async () => {
    const db = await freshDb();
    const e = (await getProductEditor(db, 1))!;
    expect(await saveProduct(db, HELPER, inputOf(e), t(0))).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await saveProduct(db, OWNER, inputOf(e, { version: 7, tagline: 'x' }), t(0))).toMatchObject({ ok: false, error: 'conflict' });
    expect(await saveProduct(db, OWNER, inputOf(e), t(0))).toMatchObject({ ok: true, value: { version: 1, effects: { publish: null } } });
    expect((await row<{ version: number }>(db, 'SELECT version FROM products WHERE id = 1')).version).toBe(1);
  });

  test('slug freeze: a live product keeps its slug; a draft renames its packs and pools with it', async () => {
    const db = await freshDb();
    const e = (await getProductEditor(db, 1))!;
    expect(await saveProduct(db, OWNER, inputOf(e, { slug: 'drumstick-honey' }), t(0))).toMatchObject({ ok: false, error: 'invalid', field: 'slug' });
    // the database guard too: a stale form that thinks the product was never live changes nothing
    const draft = await createProduct(db, OWNER, { name: 'Jamun Honey', category: 'blossom-honey' }, t(0));
    if (!draft.ok) throw new Error(draft.message);
    const d = (await getProductEditor(db, draft.value.id))!;
    expect(d.slugFrozen).toBe(false);
    const r = await saveProduct(db, OWNER, inputOf(d, { slug: 'jamun-blossom-honey' }), t(1));
    expect(r).toMatchObject({ ok: true, value: { slug: 'jamun-blossom-honey', effects: { publish: null } } });
    expect((await rows<{ code: string }>(db, 'SELECT code FROM variants WHERE product_id = ? ORDER BY sort', d.id)).map((x) => x.code))
      .toEqual(['jamun-blossom-honey:100g', 'jamun-blossom-honey:250g', 'jamun-blossom-honey:500g']);
    expect((await row<{ code: string }>(db, 'SELECT code FROM stock_pools WHERE product_id = ?', d.id)).code).toBe('jamun-blossom-honey');
    expect(await saveProduct(db, OWNER, inputOf((await getProductEditor(db, d.id))!, { slug: 'murungai-honey' }), t(2))).toMatchObject({ ok: false, error: 'conflict', field: 'slug' });
  });

  test('a product on the website must keep what it needs', async () => {
    const db = await freshDb();
    const e = (await getProductEditor(db, 1))!;
    expect(await saveProduct(db, OWNER, inputOf(e, { photo: null }), t(0))).toMatchObject({ ok: false, field: 'photo' });
    expect(await saveProduct(db, OWNER, inputOf(e, { about: '' }), t(0))).toMatchObject({ ok: false, field: 'about' });
    expect(await saveProduct(db, OWNER, inputOf(e, { gallery: [] }), t(0))).toMatchObject({ ok: false, field: 'gallery' });
  });

  test('a repo photo the build has but the database does not is added; an unknown one is refused', async () => {
    const db = await freshDb();
    const e = (await getProductEditor(db, 1))!;
    expect(await saveProduct(db, OWNER, inputOf(e, { card: 'new-shot.jpg' }), t(0))).toMatchObject({ ok: false, field: 'card' });
    const r = await saveProduct(db, OWNER, inputOf(e, { card: 'new-shot.jpg' }), t(0), { library: new Map([['new-shot.jpg', { width: 1200, height: 1600 }]]) });
    expect(r.ok).toBe(true);
    expect(await row(db, "SELECT source, width, public FROM images WHERE path = 'new-shot.jpg'")).toEqual({ source: 'repo', width: 1200, public: 1 });
  });
});

describe('packs', () => {
  test('prices, MRP, labels and a new pack: price history, live + site bumps, valid catalog', async () => {
    const db = await freshDb();
    const e = (await getProductEditor(db, 1))!;
    const lv = await setting(db, 'live_version');
    const packs = packsOf(e);
    packs[1] = { ...packs[1], pricePaise: 33000, mrpPaise: 35000 };
    packs.push({ label: '1 kg', netGrams: 1000, poolId: e.pools[0].id, poolQty: null, pricePaise: 120000, mrpPaise: null, active: true, giftOk: false });
    const r = await savePacks(db, OWNER, { productId: 1, packs }, t(0));
    expect(r).toMatchObject({ ok: true, value: { changed: 1, added: 1, effects: { publish: 'now', live: true } } });
    expect(await setting(db, 'live_version')).toBe(lv + 1);
    expect(await row(db, "SELECT code, pool_qty, price_paise FROM variants WHERE label = '1 kg'")).toEqual({ code: 'murungai-honey:1kg', pool_qty: 1000, price_paise: 120000 });
    const hist = await rows<{ old_price_paise: number | null; new_price_paise: number }>(db, 'SELECT old_price_paise, new_price_paise FROM price_history ORDER BY id');
    expect(hist).toEqual([{ old_price_paise: 31000, new_price_paise: 33000 }, { old_price_paise: null, new_price_paise: 120000 }]);
    await db.prepare("UPDATE settings SET value = 'true' WHERE key = 'show_prices'").run(); // live.json carries prices only while shown
    expect((await buildLivePayload(db)).p['murungai-honey']['250 g']).toEqual([33000, 35000, 'in', 'murungai-honey:250g']);
    expect(validateCatalog(await buildCatalog(db))).toEqual([]);
  });

  test('rules: MRP below price, duplicate names, last active pack, stale version', async () => {
    const db = await freshDb();
    const e = (await getProductEditor(db, 1))!;
    const p = packsOf(e);
    expect(await savePacks(db, OWNER, { productId: 1, packs: [{ ...p[0], mrpPaise: 100 }, p[1], p[2]] }, t(0))).toMatchObject({ ok: false, field: `pack_${p[0].id}` });
    // the second pack with the same name is the one marked
    expect(await savePacks(db, OWNER, { productId: 1, packs: [{ ...p[0], label: '250 g' }, p[1], p[2]] }, t(0))).toMatchObject({ ok: false, field: `pack_${p[1].id}` });
    expect(await savePacks(db, OWNER, { productId: 1, packs: p.map((x) => ({ ...x, active: false })) }, t(0))).toMatchObject({ ok: false, field: 'packs' });
    expect(await savePacks(db, OWNER, { productId: 1, packs: [{ ...p[0], version: 9, pricePaise: 15000 }, p[1], p[2]] }, t(0))).toMatchObject({ ok: false, error: 'conflict' });
    expect((await row<{ price_paise: number }>(db, 'SELECT price_paise FROM variants WHERE id = ?', p[0].id)).price_paise).toBe(14000);
    // a repeated submit of the same form changes nothing the second time
    const form = [{ ...p[0], pricePaise: 15000 }, p[1], p[2]];
    expect((await savePacks(db, OWNER, { productId: 1, packs: form }, t(1))).ok).toBe(true);
    expect(await savePacks(db, OWNER, { productId: 1, packs: form }, t(1))).toMatchObject({ ok: false, error: 'conflict' });
    expect(await rows(db, 'SELECT id FROM price_history')).toHaveLength(1);
  });

  test('a new stock in pieces for a product from the hive', async () => {
    const db = await freshDb();
    const r = await addPool(db, OWNER, { productId: 15, name: 'Beeswax Candles, Tealight', unit: 'piece' }, t(0));
    expect(r).toMatchObject({ ok: true, value: { code: 'beeswax-candles:tealight' } });
    expect(await addPool(db, OWNER, { productId: 1, name: 'Second stock', unit: 'g' }, t(0))).toMatchObject({ ok: false, field: 'pool_unit' });
  });
});

describe('new product, copy, go live, order', () => {
  test('blank honey: draft with a gram pool and 3 unpriced packs; a double tap makes one product', async () => {
    const db = await freshDb();
    const key = '0b6f2b1e-4c1d-4f55-9a2b-6a7d2c1e9f00';
    const a = await createProduct(db, OWNER, { name: 'Jamun Honey', category: 'blossom-honey', idemKey: key }, t(0));
    const b = await createProduct(db, OWNER, { name: 'Jamun Honey', category: 'blossom-honey', idemKey: key }, t(0));
    expect(a).toMatchObject({ ok: true, value: { slug: 'jamun-honey', duplicate: false } });
    expect(b).toMatchObject({ ok: true, value: { duplicate: true } });
    if (!a.ok) return;
    expect(await rows(db, "SELECT id FROM products WHERE name = 'Jamun Honey'")).toHaveLength(1);
    const e = (await getProductEditor(db, a.value.id))!;
    expect(e).toMatchObject({ status: 'draft', shortCode: 'JAM', slugFrozen: false });
    expect(e.pools).toMatchObject([{ code: 'jamun-honey', unit: 'g' }]);
    expect(e.packs.map((p) => [p.label, p.pricePaise, p.giftOk])).toEqual([['100 g', null, true], ['250 g', null, true], ['500 g', null, false]]);
    // drafts never reach the catalog
    expect((await buildCatalog(db)).products.some((p) => p.slug === 'jamun-honey')).toBe(false);
  });

  test('go live needs a main photo, a captioned gallery and an active pack; then the slug freezes', async () => {
    const db = await freshDb();
    const c = await createProduct(db, OWNER, { name: 'Jamun Honey', category: 'blossom-honey' }, t(0));
    if (!c.ok) throw new Error(c.message);
    let e = (await getProductEditor(db, c.value.id))!;
    expect(await setProductStatus(db, OWNER, { id: e.id, version: e.version, action: 'go_live' }, t(1))).toMatchObject({ ok: false, field: 'photo' });
    const s1 = await saveProduct(db, OWNER, inputOf(e, { photo: 'murungai-main.jpg' }), t(1));
    expect(s1.ok).toBe(true);
    e = (await getProductEditor(db, e.id))!;
    expect(await setProductStatus(db, OWNER, { id: e.id, version: e.version, action: 'go_live' }, t(2))).toMatchObject({ ok: false, field: 'gallery' });
    const s2 = await saveProduct(db, OWNER, inputOf(e, {
      gallery: [{ src: 'murungai-main.jpg', caption: 'A jar of jamun honey' }], badge: 'Single flower', tagline: 'From jamun trees.',
      about: 'Dark and fruity.', use: 'By the spoon.', finder: { taste: ['rich'], uses: ['remedy'], rare: false },
    }), t(2));
    expect(s2.ok).toBe(true);
    e = (await getProductEditor(db, e.id))!;
    const live = await setProductStatus(db, OWNER, { id: e.id, version: e.version, action: 'go_live' }, t(3));
    expect(live).toMatchObject({ ok: true, value: { status: 'live', effects: { publish: 'now', live: true } } });
    e = (await getProductEditor(db, e.id))!;
    expect(e).toMatchObject({ status: 'live', slugFrozen: true, firstLiveAt: t(3) });
    const cat = await buildCatalog(db);
    expect(validateCatalog(cat)).toEqual([]);
    expect(cat.products.find((p) => p.slug === 'jamun-honey')?.status).toBe('live');
    expect(await saveProduct(db, OWNER, inputOf(e, { slug: 'jamun-blossom' }), t(4))).toMatchObject({ ok: false, field: 'slug' });
    // pause → retire → back on the website keeps first_live_at
    e = (await getProductEditor(db, e.id))!;
    expect((await setProductStatus(db, OWNER, { id: e.id, version: e.version, action: 'pause' }, t(5))).ok).toBe(true);
    e = (await getProductEditor(db, e.id))!;
    expect((await setProductStatus(db, OWNER, { id: e.id, version: e.version, action: 'retire' }, t(6))).ok).toBe(true);
    e = (await getProductEditor(db, e.id))!;
    expect(await setProductStatus(db, OWNER, { id: e.id, version: e.version, action: 'pause' }, t(7))).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(validateCatalog(await buildCatalog(db))).toEqual([]);
  });

  test('copy repeats texts, gallery, packs and prices with new empty stock', async () => {
    const db = await freshDb();
    await addHarvest(db, OWNER, { poolId: 1, harvestedOn: '2026-11-15', amount: 50_000 }, t(0));
    const c = await createProduct(db, OWNER, { name: 'Murungai Honey Gift', category: '', copyFromId: 1 }, t(1));
    if (!c.ok) throw new Error(c.message);
    const e = (await getProductEditor(db, c.value.id))!;
    const src = (await getProductEditor(db, 1))!;
    expect(e).toMatchObject({ status: 'draft', category: src.category, about: src.about, tone: src.tone, photo: src.photo });
    expect(e.gallery).toEqual(src.gallery);
    expect(e.packs.map((p) => [p.label, p.pricePaise])).toEqual(src.packs.map((p) => [p.label, p.pricePaise]));
    expect(e.pools).toMatchObject([{ code: 'murungai-honey-gift', amountText: '0.0 kg' }]);
    const candles = await createProduct(db, OWNER, { name: 'Pillar Candles', category: '', copyFromId: 15 }, t(2));
    if (!candles.ok) throw new Error(candles.message);
    expect((await getProductEditor(db, candles.value.id))!.pools.map((p) => p.code)).toEqual(['pillar-candles:small', 'pillar-candles:medium', 'pillar-candles:large']);
  });

  test('up/down renumbers the shop order; moving a draft does not publish', async () => {
    const db = await freshDb();
    const r = await moveProduct(db, OWNER, { id: 2, direction: 'up' }, t(0));
    expect(r).toMatchObject({ ok: true, value: { effects: { publish: 'now' } } });
    expect((await rows<{ id: number }>(db, 'SELECT id FROM products ORDER BY sort, slug')).slice(0, 3).map((x) => x.id)).toEqual([2, 1, 3]);
    expect(await moveProduct(db, OWNER, { id: 2, direction: 'up' }, t(1))).toMatchObject({ ok: false, error: 'not_allowed' });
    const c = await createProduct(db, OWNER, { name: 'Jamun Honey', category: 'blossom-honey' }, t(2));
    if (!c.ok) throw new Error(c.message);
    expect(await moveProduct(db, OWNER, { id: c.value.id, direction: 'up' }, t(3))).toMatchObject({ ok: true, value: { effects: { publish: null } } });
  });
});
