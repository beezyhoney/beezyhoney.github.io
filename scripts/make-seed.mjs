// Writes db/seed.sql: the first contents of the D1 database, generated from the committed catalog snapshot.
//
//   node scripts/make-seed.mjs                      write db/seed.sql from src/data/catalog.snapshot.json
//   node scripts/make-seed.mjs --check              exit 1 if db/seed.sql is not what this script would write
//   node scripts/make-seed.mjs --snapshot <file> --out <file>   seed another catalog (tests, rehearsals)
//
// What goes in (design §3.1 "Seed", amendment A3):
// - settings: every key with its default (src/server/settings.defaults.mjs); the public ones come from the
//   snapshot's settings (show_prices stays false until go-live, amendment A6).
// - images: every photo in src/assets/img (source 'repo') with its pixel size; public = 1 when a product or a
//   category uses it.
// - categories, products (with their gallery), stock pools (tracking off, 0 on hand, default low level),
//   packs with the snapshot's prices (= START_PRICES), and the snapshot's batches.
// - No admin_users rows (owners come from the ADMIN_EMAILS secret) and no personal data of any kind.
//
// The output is deterministic (fixed timestamps, explicit ids), so `--check` can guard it in tests.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCatalog, batchKey } from '../src/data/catalog.validate.mjs';
import { SETTINGS_DEFAULTS } from '../src/server/settings.defaults.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SNAPSHOT = join(ROOT, 'src/data/catalog.snapshot.json');
export const DEFAULT_OUT = join(ROOT, 'db/seed.sql');
export const IMAGE_DIR = join(ROOT, 'src/assets/img');
/** Every seeded row says it was written at this time, by 'seed' */
export const SEED_AT = '2026-11-15T00:00:00Z';
const BY = 'seed';

// ───────────────────────────── image sizes (JPEG SOF / PNG IHDR) ─────────────────────────────

/** Pixel size of a JPEG or PNG file, read from its header. Throws on anything else. */
export function imageSize(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), type: 'png' };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], type: 'jpeg' };
      if (marker === 0xda) break;
      i += 2 + len;
    }
    throw new Error('JPEG without a frame header');
  }
  throw new Error('not a JPEG or PNG file');
}

/** Every photo under src/assets/img (relative paths with '/'), with size and bytes */
export function listRepoImages(dir = IMAGE_DIR) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        // uploads/ holds photos downloaded from KV at build time (gitignored): they are not repo photos
        if (relative(dir, full).replace(/\\/g, '/') === 'uploads') continue;
        walk(full);
      } else if (/\.(jpe?g|png)$/i.test(name)) {
        const { width, height } = imageSize(readFileSync(full));
        out.push({ path: relative(dir, full).replace(/\\/g, '/'), width, height, bytes: st.size });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ───────────────────────────── SQL text ─────────────────────────────

/** SQL literal for a JS value: null, integer, boolean (0/1) or text */
export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`not a whole number: ${v}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}
const json = (v) => lit(JSON.stringify(v));
const row = (values) => `(${values.map(lit).join(', ')})`;

function insert(table, columns, rows) {
  if (!rows.length) return [];
  return [`INSERT INTO ${table} (${columns.join(', ')}) VALUES\n  ${rows.map(row).join(',\n  ')};`];
}

/**
 * Builds the seed SQL for a catalog.
 * @param {object} snapshot a catalog (catalog.types.ts); validated first
 * @param {{ images?: {path:string,width:number,height:number,bytes:number}[] }} [opts]
 * @returns {string}
 */
export function buildSeedSql(snapshot, opts = {}) {
  const c = assertCatalog(snapshot, 'seed catalog');
  const images = opts.images ?? listRepoImages();
  const imagePaths = new Set(images.map((i) => i.path));

  // photos the website uses → public
  const used = new Set();
  for (const cat of c.categories) used.add(cat.image);
  for (const p of c.products) {
    used.add(p.photo);
    if (p.card) used.add(p.card);
    for (const g of p.gallery) used.add(g.src);
  }
  for (const path of used) {
    if (!imagePaths.has(path)) throw new Error(`photo "${path}" is used by the catalog but missing from src/assets/img`);
  }

  const productId = new Map(c.products.map((p, i) => [p.slug, i + 1]));
  const poolId = new Map(c.pools.map((p, i) => [p.code, i + 1]));
  const lowDefault = SETTINGS_DEFAULTS.alerts.lowDefault;

  // public settings come from the snapshot, the rest from the defaults
  const fromSnapshot = {
    show_prices: c.settings.showPrices,
    stock_display: c.settings.stockDisplay,
    delivery_note: c.settings.deliveryNote,
    offer: c.settings.offer,
    gift: c.settings.gift,
    site_version: c.siteVersion,
    live_version: c.liveVersion,
  };
  const settings = Object.entries({ ...SETTINGS_DEFAULTS, ...fromSnapshot })
    .map(([key, value]) => [key, JSON.stringify(value), 1, SEED_AT, BY]);

  const poolSort = new Map();
  const pools = c.pools.map((pool, i) => {
    const n = poolSort.get(pool.productSlug) ?? 0;
    poolSort.set(pool.productSlug, n + 1);
    return [i + 1, productId.get(pool.productSlug), pool.code, pool.name, pool.unit, n, 0, 0,
      lowDefault[pool.unit], 'auto', null, 1, SEED_AT, BY];
  });

  const sql = [
    '-- Beezy Honey: first contents of the D1 database.',
    '-- GENERATED by scripts/make-seed.mjs from src/data/catalog.snapshot.json. Do not edit; run the script.',
    '-- Apply once to a freshly migrated database: node scripts/db-local.mjs seed (local),',
    '-- or wrangler d1 execute beezy --remote --file db/seed.sql (production, Phase 7).',
    '-- No admin_users rows: owners come from the ADMIN_EMAILS secret. No personal data.',
    '',
    ...insert('settings', ['key', 'value', 'version', 'updated_at', 'updated_by'], settings),
    '',
    ...insert('images', ['path', 'source', 'thumb_path', 'width', 'height', 'bytes', 'public', 'created_at', 'created_by'],
      images.map((im) => [im.path, 'repo', null, im.width, im.height, im.bytes, used.has(im.path) ? 1 : 0, SEED_AT, BY])),
    '',
    ...insert('categories', ['id', 'name', 'title', 'intro', 'image', 'is_honey', 'sort', 'version', 'updated_at', 'updated_by'],
      c.categories.map((cat) => [cat.id, cat.name, cat.title, cat.intro, cat.image, cat.isHoney, cat.sort, 1, SEED_AT, BY])),
    '',
  ];

  // one INSERT per product keeps every statement far below D1's statement size limit
  c.products.forEach((p, i) => {
    sql.push(...insert('products', ['id', 'slug', 'short_code', 'status', 'sort', 'name', 'category', 'kind', 'badge',
      'with_comb', 'tagline', 'tone', 'photo', 'card_photo', 'specs_json', 'colour_min', 'colour_max', 'about', 'love_json',
      'use_head', 'use_text', 'store_text', 'finder_json', 'bloom_json', 'bloom_note', 'in_gift_box', 'first_live_at',
      'version', 'created_at', 'updated_at', 'updated_by'], [[
      i + 1, p.slug, p.shortCode, p.status, p.sort, p.name, p.category, p.kind, p.badge,
      p.withComb, p.tagline, p.tone, p.photo, p.card, JSON.stringify(p.specs),
      p.colour ? p.colour[0] : null, p.colour ? p.colour[1] : null, p.about, JSON.stringify(p.love),
      p.useHead, p.use, p.store, p.finder === null ? null : JSON.stringify(p.finder),
      p.bloom === null ? null : JSON.stringify(p.bloom), p.bloomNote, p.inGiftBox, SEED_AT,
      1, SEED_AT, SEED_AT, BY]]));
  });
  sql.push('');

  const gallery = [];
  for (const p of c.products) {
    p.gallery.forEach((g, j) => gallery.push([productId.get(p.slug), g.src, g.caption, j + 1]));
  }
  sql.push(...insert('product_images', ['product_id', 'image', 'caption', 'sort'], gallery), '');

  sql.push(...insert('stock_pools', ['id', 'product_id', 'code', 'name', 'unit', 'sort', 'track_stock', 'on_hand', 'low_at',
    'availability', 'tracking_since', 'version', 'updated_at', 'updated_by'], pools), '');

  sql.push(...insert('variants', ['id', 'product_id', 'code', 'label', 'sort', 'net_grams', 'pool_id', 'pool_qty',
    'price_paise', 'mrp_paise', 'active', 'gift_ok', 'version', 'updated_at', 'updated_by'],
  c.variants.map((v, i) => [i + 1, productId.get(v.productSlug), v.code, v.label, v.sort, v.netGrams, poolId.get(v.poolCode),
    v.poolQty, v.pricePaise, v.mrpPaise, v.active, v.giftOk, 1, SEED_AT, BY])), '');

  // catalog batches are newest first; insert oldest first so ids grow with time
  const batches = [...c.batches].reverse().map((b) => [b.code, batchKey(b.code), productId.get(b.productSlug),
    null, b.harvested, b.packed, b.bestBefore, b.note, null, 1, 'active', 1, SEED_AT, BY, SEED_AT, BY]);
  sql.push(...insert('batches', ['code', 'code_key', 'product_id', 'harvest_id', 'harvested_label', 'packed_on', 'best_before',
    'public_note', 'private_note', 'is_public', 'status', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'], batches));

  return `${sql.join('\n').replace(/\n+$/, '')}\n`;
}

/** Writes the seed atomically (temp file + rename) */
export function writeSeed(out, text) {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, out);
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const snapshotPath = resolve(arg('--snapshot') ?? DEFAULT_SNAPSHOT);
  const out = resolve(arg('--out') ?? DEFAULT_OUT);
  const text = buildSeedSql(JSON.parse(readFileSync(snapshotPath, 'utf8')));
  const c = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const summary = `${c.products.length} products, ${c.variants.length} packs (${c.variants.filter((v) => v.pricePaise !== null).length} priced), `
    + `${c.pools.length} stock pools, ${c.batches.length} batches`;
  if (argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(out, 'utf8'); } catch { /* missing */ }
    if (current.replace(/\r\n/g, '\n') !== text) {
      console.error(`make-seed: ${relative(ROOT, out)} is out of date; run node scripts/make-seed.mjs`);
      process.exit(1);
    }
    console.log(`make-seed: ${relative(ROOT, out)} is up to date (${summary})`);
    return;
  }
  writeSeed(out, text);
  console.log(`make-seed: wrote ${relative(ROOT, out)} (${summary})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`make-seed: ${e.message}`);
    process.exit(1);
  }
}
