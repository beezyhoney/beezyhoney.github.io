// The catalog format and loader: prices (amendment A6), stock pools (A3), short codes, settings,
// product status handling and the whitelist that keeps private data out of the public catalog.
import { describe, expect, it } from 'vitest';
import snapshotJson from '../../../src/data/catalog.snapshot.json';
import { catalogData } from '../../../src/data/catalog';
import { CATALOG_FORMAT as TYPES_FORMAT, type Catalog } from '../../../src/data/catalog.types';
import { CATALOG_FORMAT, FIELDS, validateCatalog } from '../../../src/data/catalog.validate.mjs';
import { checkBatches } from '../../../src/data/batches';
import { START_PRICES } from '../../../src/data/prices';

const snapshot = snapshotJson as unknown as Catalog;
const copy = (): Catalog => structuredClone(snapshot);
const BLOSSOM = ['forest-coffee-honey', 'karanji-honey', 'litchi-honey', 'tulasi-honey'];
const HONEYS = snapshot.products.filter((p) => p.category !== 'from-the-hive').map((p) => p.slug);

describe('format', () => {
  it('the validator and the types agree on the format version', () => {
    expect(CATALOG_FORMAT).toBe(TYPES_FORMAT);
    expect(snapshot.format).toBe(CATALOG_FORMAT);
  });
  it('the snapshot is valid', () => expect(validateCatalog(snapshot)).toEqual([]));
  it('objects are written in the documented field order', () => {
    expect(Object.keys(snapshot)).toEqual(FIELDS.catalog);
    for (const p of snapshot.products) expect(Object.keys(p)).toEqual(FIELDS.product);
    for (const v of snapshot.variants) expect(Object.keys(v)).toEqual(FIELDS.variant);
    for (const p of snapshot.pools) expect(Object.keys(p)).toEqual(FIELDS.pool);
  });
  it('versions start at 1', () => {
    expect(snapshot.siteVersion).toBe(1);
    expect(snapshot.liveVersion).toBe(1);
  });
});

describe('short codes', () => {
  it('match the agreed list, in product order', () => {
    expect(snapshot.products.map((p) => p.shortCode)).toEqual(
      ['MUR', 'MUL', 'FOR', 'SUN', 'MUS', 'COR', 'NAT', 'FCO', 'KAR', 'LIT', 'TUL', 'DAM', 'KOM', 'NEE', 'BWC', 'HST']);
  });
});

describe('prices (START_PRICES → variants)', () => {
  it('47 packs: 35 priced, 12 "Price on WhatsApp" (the 4 Blossom honeys)', () => {
    expect(snapshot.variants).toHaveLength(47);
    const priced = snapshot.variants.filter((v) => v.pricePaise !== null);
    const open = snapshot.variants.filter((v) => v.pricePaise === null);
    expect(priced).toHaveLength(35);
    expect(open).toHaveLength(12);
    expect([...new Set(open.map((v) => v.productSlug))].sort()).toEqual([...BLOSSOM].sort());
  });
  it('every START_PRICES entry is on its pack, in paise, and every pack has an entry', () => {
    const seen = new Set<string>();
    for (const [slug, packs] of Object.entries(START_PRICES)) {
      for (const [label, rupees] of Object.entries(packs)) {
        const v = snapshot.variants.find((x) => x.productSlug === slug && x.label === label);
        expect(v, `${slug} ${label}`).toBeDefined();
        expect(v!.pricePaise).toBe(rupees === null ? null : rupees * 100);
        seen.add(v!.code);
      }
    }
    expect(seen.size).toBe(snapshot.variants.length);
  });
  it('MRP is not set yet (null = same as the price), and prices stay hidden', () => {
    expect(snapshot.variants.every((v) => v.mrpPaise === null)).toBe(true);
    expect(snapshot.settings.showPrices).toBe(false);
  });
  it('PRICE_TABLE carries the same prices by slug and pack label', () => {
    const { PRICE_TABLE } = catalogData(snapshot);
    expect(PRICE_TABLE['murungai-honey']['250 g']).toEqual({ code: 'murungai-honey:250g', pricePaise: 31000, mrpPaise: null, avail: 'in' });
    expect(PRICE_TABLE['honey-sticks']['Box of 10 (100 g)']).toEqual({ code: 'honey-sticks:box-10', pricePaise: 7000, mrpPaise: null, avail: 'in' });
    expect(PRICE_TABLE['litchi-honey']['100 g'].pricePaise).toBeNull();
    expect(Object.values(PRICE_TABLE).reduce((n, t) => n + Object.keys(t).length, 0)).toBe(47);
  });
});

describe('stock pools (amendment A3)', () => {
  it('one gram pool per honey; every honey pack draws its net weight from it', () => {
    expect(HONEYS).toHaveLength(14);
    for (const slug of HONEYS) {
      const pools = snapshot.pools.filter((p) => p.productSlug === slug);
      expect(pools, slug).toEqual([{ code: slug, productSlug: slug, name: snapshot.products.find((p) => p.slug === slug)!.name, unit: 'g' }]);
      const packs = snapshot.variants.filter((v) => v.productSlug === slug);
      expect(packs.map((v) => v.code)).toEqual([`${slug}:100g`, `${slug}:250g`, `${slug}:500g`]);
      for (const v of packs) {
        expect(v.poolCode).toBe(slug);
        expect(v.netGrams).toBe(Number.parseInt(v.label, 10));
        expect(v.poolQty).toBe(v.netGrams);
      }
    }
  });
  it('beeswax candles: three pools (Small, Medium, Large) counted in pieces, one piece per pack', () => {
    const pools = snapshot.pools.filter((p) => p.productSlug === 'beeswax-candles');
    expect(pools.map((p) => [p.code, p.unit])).toEqual([
      ['beeswax-candles:small', 'piece'], ['beeswax-candles:medium', 'piece'], ['beeswax-candles:large', 'piece']]);
    const packs = snapshot.variants.filter((v) => v.productSlug === 'beeswax-candles');
    expect(packs.map((v) => [v.code, v.label, v.poolCode, v.poolQty, v.netGrams])).toEqual([
      ['beeswax-candles:small', 'Small', 'beeswax-candles:small', 1, null],
      ['beeswax-candles:medium', 'Medium', 'beeswax-candles:medium', 1, null],
      ['beeswax-candles:large', 'Large', 'beeswax-candles:large', 1, null],
    ]);
  });
  it('honey sticks: one pool of pieces; 1 stick uses 1, the box of 10 uses 10', () => {
    expect(snapshot.pools.filter((p) => p.productSlug === 'honey-sticks')).toEqual([
      { code: 'honey-sticks', productSlug: 'honey-sticks', name: 'Honey sticks', unit: 'piece' }]);
    const packs = snapshot.variants.filter((v) => v.productSlug === 'honey-sticks');
    expect(packs.map((v) => [v.code, v.label, v.poolCode, v.poolQty, v.netGrams])).toEqual([
      ['honey-sticks:1-stick', '1 stick', 'honey-sticks', 1, 10],
      ['honey-sticks:box-10', 'Box of 10 (100 g)', 'honey-sticks', 10, 100],
    ]);
  });
  it('18 pools in all, and they never carry counts', () => {
    expect(snapshot.pools).toHaveLength(18);
    for (const p of snapshot.pools) expect(Object.keys(p).sort()).toEqual(['code', 'name', 'productSlug', 'unit']);
  });
  it('every pack starts available', () => expect(snapshot.variants.every((v) => v.avail === 'in')).toBe(true));
});

describe('gift and settings', () => {
  it('gift_ok on honey 100 g and 250 g packs only; every honey is in the gift box', () => {
    for (const v of snapshot.variants) expect(v.giftOk, v.code).toBe(HONEYS.includes(v.productSlug) && ['100 g', '250 g'].includes(v.label));
    for (const p of snapshot.products) expect(p.inGiftBox, p.slug).toBe(HONEYS.includes(p.slug));
  });
  it('public settings have the seeded defaults', () => {
    expect(snapshot.settings).toEqual({
      showPrices: false, stockDisplay: 'sold_out', deliveryNote: 'Delivery charges are confirmed on WhatsApp.', offer: null,
      gift: { feePaise: 0, extras: { 'Beeswax candle': null, 'Honey sticks': null }, bulkFrom: 20 },
    });
  });
});

describe('product status', () => {
  const mixed = () => {
    const c = copy();
    c.products.find((p) => p.slug === 'litchi-honey')!.status = 'paused';
    c.products.find((p) => p.slug === 'kombu-honey')!.status = 'retired';
    c.products.find((p) => p.slug === 'honey-sticks')!.sort = 0; // moves to the front
    c.batches = [
      { code: 'LIT-2603-01', productSlug: 'litchi-honey', harvested: 'March 2026', packed: '2026-03-20', bestBefore: '2028-03', note: null },
      { code: 'KOM-2511-01', productSlug: 'kombu-honey', harvested: 'November 2025', packed: '2025-11-30', bestBefore: '2027-11', note: 'Wild comb.' },
    ];
    return c;
  };
  it('PRODUCTS = live (sorted), PRODUCT_PAGES = live + paused, ALL_PRODUCTS = everything', () => {
    const d = catalogData(mixed());
    expect(d.PRODUCTS.map((p) => p.slug)).not.toContain('litchi-honey');
    expect(d.PRODUCTS.map((p) => p.slug)).not.toContain('kombu-honey');
    expect(d.PRODUCTS[0].slug).toBe('honey-sticks');
    expect(d.PRODUCT_PAGES.map((p) => p.slug)).toContain('litchi-honey');
    expect(d.PRODUCT_PAGES.map((p) => p.slug)).not.toContain('kombu-honey');
    expect(d.ALL_PRODUCTS).toHaveLength(16);
    expect(d.PRICE_TABLE['litchi-honey']).toBeDefined();
    expect(d.PRICE_TABLE['kombu-honey']).toBeUndefined();
  });
  it('batches of paused or retired products still pass the Know Your Jar check (ALL_PRODUCTS), not just live ones', () => {
    const d = catalogData(mixed());
    expect(d.BATCHES).toEqual([
      { code: 'LIT-2603-01', product: 'litchi-honey', harvested: 'March 2026', packed: '2026-03-20', bestBefore: '2028-03' },
      { code: 'KOM-2511-01', product: 'kombu-honey', harvested: 'November 2025', packed: '2025-11-30', bestBefore: '2027-11', note: 'Wild comb.' },
    ]);
    expect(() => checkBatches(d.BATCHES, d.ALL_PRODUCTS)).not.toThrow();
    expect(() => checkBatches(d.BATCHES, d.PRODUCTS)).toThrow(/unknown product "litchi-honey"/);
  });
  it('inactive packs are dropped from packs, variants and the price table', () => {
    const c = copy();
    c.variants.find((v) => v.code === 'murungai-honey:500g')!.active = false;
    const p = catalogData(c).PRODUCTS.find((x) => x.slug === 'murungai-honey')!;
    expect(p.packs).toEqual(['100 g', '250 g']);
    expect(p.variants.map((v) => v.code)).toEqual(['murungai-honey:100g', 'murungai-honey:250g']);
    expect(catalogData(c).PRICE_TABLE['murungai-honey']['500 g']).toBeUndefined();
  });
});

describe('validation and the public whitelist', () => {
  const problems = (mutate: (c: any) => void) => { const c = copy(); mutate(c); return validateCatalog(c).join('\n'); };
  it('rejects stock counts or any other unknown field', () => {
    expect(problems((c) => { c.pools[0].onHand = 99500; })).toMatch(/pools\[0\].*unknown field "onHand"/);
    expect(problems((c) => { c.variants[0].stockOnHand = 4; })).toMatch(/unknown field "stockOnHand"/);
    expect(problems((c) => { c.variants[0].lowAt = 5; })).toMatch(/unknown field "lowAt"/);
    expect(problems((c) => { c.products[0].privateNote = 'x'; })).toMatch(/unknown field "privateNote"/);
    expect(problems((c) => { c.settings.business = {}; })).toMatch(/unknown field "business"/);
    expect(problems((c) => { c.orders = []; })).toMatch(/unknown field "orders"/);
  });
  it('rejects drafts, unknown formats and broken references', () => {
    expect(problems((c) => { c.products[0].status = 'draft'; })).toMatch(/drafts are never published/);
    expect(problems((c) => { c.format = 2; })).toMatch(/format/);
    expect(problems((c) => { c.variants[0].poolCode = 'nope'; })).toMatch(/unknown pool "nope"/);
    expect(problems((c) => { c.batches.push({ code: 'X-1', productSlug: 'nope', harvested: 'May 2026', packed: '2026-05-01', bestBefore: '2028-05', note: null }); })).toMatch(/unknown product "nope"/);
    expect(problems((c) => { c.products[1].shortCode = 'MUR'; })).toMatch(/used twice/);
    expect(problems((c) => { c.settings.gift.extras['Honey sticks'] = 'honey-sticks:box-99'; })).toMatch(/unknown pack/);
  });
  it('checks money and stock rules', () => {
    expect(problems((c) => { c.variants[0].pricePaise = 140.5; })).toMatch(/pricePaise/);
    expect(problems((c) => { c.variants[0].mrpPaise = c.variants[0].pricePaise - 100; })).toMatch(/mrpPaise/);
    expect(problems((c) => { c.variants[0].poolQty = 99; })).toMatch(/must equal netGrams/);
    expect(problems((c) => { c.variants[0].avail = 'soon'; })).toMatch(/avail/);
    expect(problems((c) => { c.variants.filter((v: any) => v.productSlug === 'dammar-honey').forEach((v: any) => { v.active = false; }); }))
      .toMatch(/live product needs at least one active pack/);
  });
  it('catalogData refuses an invalid catalog with a readable message', () => {
    const c: any = copy();
    c.products[0].tone = 'yellow';
    expect(() => catalogData(c, 'test catalog')).toThrow(/test catalog is not a valid catalog.*\n.*tone/);
  });
});
