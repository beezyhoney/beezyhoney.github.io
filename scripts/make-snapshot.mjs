// Writes src/data/catalog.snapshot.json, the committed catalog the site is built from until the admin portal's
// public /api/catalog.json takes over (and the emergency source after that).
//
// Inputs:
// - test/fixtures/legacy-data.json: the product data as it was in products.ts / features.ts / batches.ts
//   (captured exactly by scripts/capture-legacy.mjs from git);
// - START_PRICES in src/data/prices.ts (the owner's 15 Nov 2026 price list);
// - the product short codes and stock pools below (amendment A3).
//
// This is a one-off migration step. Once the snapshot exists it is the source of truth, so this script will not
// overwrite a snapshot that differs from what it would write unless you pass --force.
//
// Usage: node scripts/make-snapshot.mjs [--force] [--check]
//   --check  only compare: exit 1 when the committed snapshot differs from what this script would write
// Needs Node 22.18+ / 24 (imports prices.ts with built-in TypeScript type stripping).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCatalog, CATALOG_FORMAT, FIELDS } from '../src/data/catalog.validate.mjs';

const root = path.resolve(import.meta.dirname, '..');
const OUT = path.join(root, 'src/data/catalog.snapshot.json');
const legacy = JSON.parse(readFileSync(path.join(root, 'test/fixtures/legacy-data.json'), 'utf8'));
const { START_PRICES } = await import(pathToFileURL(path.join(root, 'src/data/prices.ts')).href);

/** Product short codes (2–4 capitals; they start batch codes such as MUR-2611-01) */
export const SHORT_CODES = {
  'murungai-honey': 'MUR', 'multifloral-honey': 'MUL', 'forest-honey': 'FOR', 'sunflower-honey': 'SUN',
  'mustard-honey': 'MUS', 'coriander-honey': 'COR', 'native-honey': 'NAT', 'forest-coffee-honey': 'FCO',
  'karanji-honey': 'KAR', 'litchi-honey': 'LIT', 'tulasi-honey': 'TUL', 'dammar-honey': 'DAM',
  'kombu-honey': 'KOM', 'neela-kurinji-honey': 'NEE', 'beeswax-candles': 'BWC', 'honey-sticks': 'HST',
};

/** Seeded website settings (design §3.1 defaults, amendment A6: prices stay hidden until go-live) */
const SETTINGS = {
  showPrices: false,
  stockDisplay: 'sold_out',
  deliveryNote: 'Delivery charges are confirmed on WhatsApp.',
  offer: null,
  gift: { feePaise: 0, extras: Object.fromEntries(legacy.GIFT_EXTRAS.map((name) => [name, null])), bulkFrom: 20 },
};

const isHoney = (p) => p.category !== 'from-the-hive';
const grams = (label) => Number(/^(\d+) g$/.exec(label)?.[1] ?? NaN);

/**
 * Packs and stock pools of one product (amendment A3):
 * - every honey: one pool counted in grams; a pack uses its net weight;
 * - beeswax candles: one pool per size, in pieces;
 * - honey sticks: one pool of sticks, in pieces; '1 stick' uses 1, 'Box of 10 (100 g)' uses 10.
 */
function packsOf(p) {
  if (isHoney(p)) {
    const pool = { code: p.slug, productSlug: p.slug, name: p.name, unit: 'g' };
    const variants = p.packs.map((label) => {
      const g = grams(label);
      if (!Number.isInteger(g)) throw new Error(`${p.slug}: honey pack "${label}" is not "<n> g"`);
      return { label, slug: `${g}g`, netGrams: g, pool, poolQty: g };
    });
    return { pools: [pool], variants };
  }
  if (p.slug === 'beeswax-candles') {
    const variants = p.packs.map((label) => {
      const size = label.toLowerCase();
      const pool = { code: `${p.slug}:${size}`, productSlug: p.slug, name: `${p.name}, ${label}`, unit: 'piece' };
      return { label, slug: size, netGrams: null, pool, poolQty: 1 };
    });
    return { pools: variants.map((v) => v.pool), variants };
  }
  if (p.slug === 'honey-sticks') {
    const pool = { code: p.slug, productSlug: p.slug, name: 'Honey sticks', unit: 'piece' };
    const STICKS = { '1 stick': { slug: '1-stick', netGrams: 10, poolQty: 1 }, 'Box of 10 (100 g)': { slug: 'box-10', netGrams: 100, poolQty: 10 } };
    const variants = p.packs.map((label) => {
      if (!STICKS[label]) throw new Error(`honey-sticks: no pool rule for pack "${label}"`);
      return { label, ...STICKS[label], pool };
    });
    return { pools: [pool], variants };
  }
  throw new Error(`${p.slug}: no stock pool rule for this product`);
}

const ordered = (kind, o) => Object.fromEntries(FIELDS[kind].filter((k) => k in o).map((k) => [k, o[k]]));

// Every price must match a pack and every pack must have a price entry (null allowed)
for (const [slug, prices] of Object.entries(START_PRICES)) {
  const p = legacy.PRODUCTS.find((x) => x.slug === slug);
  if (!p) throw new Error(`prices.ts: unknown product "${slug}"`);
  for (const label of Object.keys(prices)) if (!p.packs.includes(label)) throw new Error(`prices.ts: ${slug} has no pack "${label}"`);
}

const categories = legacy.CATEGORIES.map((c, i) => ordered('category', { ...c, isHoney: c.id !== 'from-the-hive', sort: i + 1 }));
const products = [];
const variants = [];
const pools = [];
legacy.PRODUCTS.forEach((p, i) => {
  const shortCode = SHORT_CODES[p.slug];
  if (!shortCode) throw new Error(`${p.slug}: no short code`);
  const finder = legacy.FINDER_PROFILES[p.slug] ?? null;
  products.push(ordered('product', {
    slug: p.slug, shortCode, status: 'live', sort: i + 1,
    name: p.name, category: p.category, kind: p.kind, badge: p.badge, withComb: p.withComb, tagline: p.tagline, tone: p.tone,
    photo: p.photo, card: p.card ?? null, gallery: p.gallery, specs: p.specs, colour: p.colour ?? null,
    about: p.about, love: p.love, useHead: p.useHead ?? null, use: p.use, store: p.store,
    finder: finder && ordered('finder', finder),
    bloom: legacy.BLOOM[p.slug] ?? null,
    bloomNote: legacy.BLOOM_NOTE[p.slug] ?? null,
    // today's gift box offers every honey (gift-box.astro: clientProducts().filter(p => p.honey))
    inGiftBox: isHoney(p),
  }));
  const packs = packsOf(p);
  pools.push(...packs.pools.map((pool) => ordered('pool', pool)));
  packs.variants.forEach((v, j) => {
    if (!(p.slug in START_PRICES) || !(v.label in START_PRICES[p.slug])) throw new Error(`prices.ts: no entry for ${p.slug} "${v.label}" (use null for no price)`);
    const rupees = START_PRICES[p.slug][v.label];
    variants.push(ordered('variant', {
      code: `${p.slug}:${v.slug}`, productSlug: p.slug, label: v.label, sort: j + 1, active: true,
      netGrams: v.netGrams, poolCode: v.pool.code, poolQty: v.poolQty,
      pricePaise: rupees === null ? null : Math.round(rupees * 100),
      mrpPaise: null, // null = MRP is the same as the price (owner decision pending, design §13 q4)
      // design §3.1: gift_ok for honey 100 g and 250 g packs (the gift box jar sizes)
      giftOk: isHoney(p) && legacy.GIFT_JARS.includes(v.label),
      avail: 'in', // owner, 15 Nov 2026: everything is in stock; tracking stays off until the first harvest or count
    }));
  });
});

const batches = legacy.BATCHES.map((b) => ordered('batch', {
  code: b.code, productSlug: b.product, harvested: b.harvested, packed: b.packed, bestBefore: b.bestBefore, note: b.note ?? null,
}));

const catalog = ordered('catalog', {
  format: CATALOG_FORMAT, siteVersion: 1, liveVersion: 1, categories, products, variants, pools, settings: SETTINGS, batches,
});
assertCatalog(catalog, 'the new snapshot');

const json = JSON.stringify(catalog, null, 2) + '\n';
const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
const summary = `${products.length} products, ${variants.length} packs (${variants.filter((v) => v.pricePaise !== null).length} priced), ${pools.length} stock pools, ${batches.length} batches`;
if (process.argv.includes('--check')) {
  if (current === json) { console.log(`catalog.snapshot.json is up to date: ${summary}`); process.exit(0); }
  console.error('catalog.snapshot.json differs from what make-snapshot.mjs would write'); process.exit(1);
}
if (current !== null && current !== json && !process.argv.includes('--force')) {
  console.error('catalog.snapshot.json already exists and differs (it may have been edited since). Re-run with --force to overwrite it.');
  process.exit(1);
}
writeFileSync(OUT, json);
console.log(`wrote ${path.relative(root, OUT)}: ${summary}`);
