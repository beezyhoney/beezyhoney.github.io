// Checks a catalog (see catalog.types.ts) before the site is built from it.
// Plain JavaScript on purpose: scripts/sync-catalog.mjs runs it in Node during every build,
// and src/data/catalog.ts runs it again when the site loads the catalog.
//
// Every object is whitelisted: a field that is not in the format is an error. This is what keeps
// stock counts, customer data and private notes out of the public catalog.

/** Must match CATALOG_FORMAT in catalog.types.ts (a test checks this). */
export const CATALOG_FORMAT = 1;

export const CATEGORY_IDS = ['comb-honey', 'blossom-honey', 'wild-rare', 'from-the-hive'];
export const PRODUCT_STATUSES = ['live', 'paused', 'retired'];
export const TASTES = ['mild', 'floral', 'rich', 'herbal'];
export const USES = ['daily', 'kids', 'remedy', 'gift', 'onthego'];
export const AVAILS = ['in', 'low', 'out'];
export const POOL_UNITS = ['g', 'piece'];
export const STOCK_DISPLAYS = ['sold_out', 'low_and_sold_out'];

/** The fields each object may have, in the order the snapshot writes them */
export const FIELDS = {
  catalog: ['format', 'siteVersion', 'liveVersion', 'categories', 'products', 'variants', 'pools', 'settings', 'batches'],
  category: ['id', 'name', 'title', 'intro', 'image', 'isHoney', 'sort'],
  product: ['slug', 'shortCode', 'status', 'sort', 'name', 'category', 'kind', 'badge', 'withComb', 'tagline', 'tone',
    'photo', 'card', 'gallery', 'specs', 'colour', 'about', 'love', 'useHead', 'use', 'store',
    'finder', 'bloom', 'bloomNote', 'inGiftBox'],
  galleryItem: ['src', 'caption'],
  finder: ['taste', 'uses', 'rare'],
  variant: ['code', 'productSlug', 'label', 'sort', 'active', 'netGrams', 'poolCode', 'poolQty', 'pricePaise', 'mrpPaise', 'giftOk', 'avail'],
  pool: ['code', 'productSlug', 'name', 'unit'],
  settings: ['showPrices', 'stockDisplay', 'deliveryNote', 'offer', 'gift'],
  offer: ['text', 'href', 'until'],
  gift: ['feePaise', 'extras', 'bulkFrom'],
  batch: ['code', 'productSlug', 'harvested', 'packed', 'bestBefore', 'note'],
};
/** Fields that may be left out (everything else is required, null where the type allows it) */
const OPTIONAL = { finder: ['rare'] };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/;
const CODE_RE = /^[a-z0-9:-]+$/;
const SHORT_RE = /^[A-Z]{2,4}$/;
const TONE_RE = /^#[0-9A-Fa-f]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Same rule as Know Your Jar: compare codes ignoring case, spaces and punctuation */
export const batchKey = (code) => String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === 'string';
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isDate = (v) => isStr(v) && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * Returns a list of problems (empty when the catalog is good). Never throws.
 * @param {unknown} c
 * @returns {string[]}
 */
export function validateCatalog(c) {
  const errs = [];
  const err = (where, msg) => errs.push(`${where}: ${msg}`);
  const shape = (where, o, kind) => {
    if (!isObj(o)) { err(where, 'must be an object'); return false; }
    const allowed = FIELDS[kind];
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(where, `unknown field "${k}" (not allowed in the public catalog)`);
    for (const k of allowed) if (!(k in o) && !(OPTIONAL[kind] ?? []).includes(k)) err(where, `missing field "${k}"`);
    return true;
  };
  const list = (where, v) => { if (!Array.isArray(v)) { err(where, 'must be a list'); return []; } return v; };
  const text = (where, v, max) => { if (!isText(v)) err(where, 'must be non-empty text'); else if (max && v.length > max) err(where, `must be at most ${max} characters`); };
  const textOrNull = (where, v) => { if (v !== null && !isText(v)) err(where, 'must be non-empty text or null'); };
  const bool = (where, v) => { if (typeof v !== 'boolean') err(where, 'must be true or false'); };
  const int = (where, v, min = -Infinity) => { if (!isInt(v) || v < min) err(where, `must be a whole number${min > -Infinity ? ` ≥ ${min}` : ''}`); };
  const image = (where, v) => {
    if (!isText(v)) return err(where, 'must be an image path');
    if (v.startsWith('/') || v.includes('..') || v.includes('\\') || !/\.(jpe?g|png)$/.test(v)) err(where, `"${v}" must be a .jpg/.jpeg/.png path relative to src/assets/img`);
  };

  if (!shape('catalog', c, 'catalog')) return errs;
  if (c.format !== CATALOG_FORMAT) err('catalog.format', `is ${JSON.stringify(c.format)}, this site understands format ${CATALOG_FORMAT}`);
  int('catalog.siteVersion', c.siteVersion, 1);
  int('catalog.liveVersion', c.liveVersion, 1);

  // categories
  const catIds = new Set();
  list('catalog.categories', c.categories).forEach((cat, i) => {
    const w = `categories[${i}]${isObj(cat) && isStr(cat.id) ? ` (${cat.id})` : ''}`;
    if (!shape(w, cat, 'category')) return;
    if (!CATEGORY_IDS.includes(cat.id)) err(w, `id must be one of ${CATEGORY_IDS.join(', ')}`);
    else if (catIds.has(cat.id)) err(w, 'listed twice');
    catIds.add(cat.id);
    text(`${w}.name`, cat.name); text(`${w}.title`, cat.title); text(`${w}.intro`, cat.intro, 600);
    image(`${w}.image`, cat.image); bool(`${w}.isHoney`, cat.isHoney); int(`${w}.sort`, cat.sort);
  });

  // products
  const slugs = new Map();
  const shortCodes = new Set();
  list('catalog.products', c.products).forEach((p, i) => {
    const w = `products[${i}]${isObj(p) && isStr(p.slug) ? ` (${p.slug})` : ''}`;
    if (!shape(w, p, 'product')) return;
    if (!isStr(p.slug) || !SLUG_RE.test(p.slug)) err(`${w}.slug`, 'must be 3–60 lower-case letters, digits or hyphens');
    else if (slugs.has(p.slug)) err(w, 'slug listed twice');
    slugs.set(p.slug, p);
    if (!isStr(p.shortCode) || !SHORT_RE.test(p.shortCode)) err(`${w}.shortCode`, 'must be 2–4 capital letters');
    else if (shortCodes.has(p.shortCode)) err(`${w}.shortCode`, `"${p.shortCode}" is used twice`);
    shortCodes.add(p.shortCode);
    if (!PRODUCT_STATUSES.includes(p.status)) err(`${w}.status`, `must be one of ${PRODUCT_STATUSES.join(', ')} (drafts are never published)`);
    int(`${w}.sort`, p.sort);
    text(`${w}.name`, p.name, 60);
    if (!catIds.has(p.category)) err(`${w}.category`, `unknown category "${p.category}"`);
    text(`${w}.kind`, p.kind); text(`${w}.badge`, p.badge); bool(`${w}.withComb`, p.withComb);
    text(`${w}.tagline`, p.tagline, 140);
    if (!isStr(p.tone) || !TONE_RE.test(p.tone)) err(`${w}.tone`, 'must look like #EEF0D6');
    image(`${w}.photo`, p.photo);
    if (p.card !== null) image(`${w}.card`, p.card);
    list(`${w}.gallery`, p.gallery).forEach((g, j) => {
      if (!shape(`${w}.gallery[${j}]`, g, 'galleryItem')) return;
      image(`${w}.gallery[${j}].src`, g.src); text(`${w}.gallery[${j}].caption`, g.caption, 140);
    });
    list(`${w}.specs`, p.specs).forEach((s, j) => {
      if (!Array.isArray(s) || s.length !== 2 || !isText(s[0]) || !isText(s[1])) err(`${w}.specs[${j}]`, 'must be [label, value]');
    });
    if (p.colour !== null && !(Array.isArray(p.colour) && p.colour.length === 2 && isInt(p.colour[0]) && isInt(p.colour[1])
      && p.colour[0] >= 0 && p.colour[0] <= p.colour[1] && p.colour[1] <= 6)) err(`${w}.colour`, 'must be null or [from, to] with 0 ≤ from ≤ to ≤ 6');
    text(`${w}.about`, p.about);
    list(`${w}.love`, p.love).forEach((l, j) => text(`${w}.love[${j}]`, l));
    textOrNull(`${w}.useHead`, p.useHead); text(`${w}.use`, p.use); text(`${w}.store`, p.store);
    if (p.finder !== null && shape(`${w}.finder`, p.finder, 'finder')) {
      const f = p.finder;
      if (!Array.isArray(f.taste) || !f.taste.length || f.taste.some((t) => !TASTES.includes(t))) err(`${w}.finder.taste`, `must list some of ${TASTES.join(', ')}`);
      if (!Array.isArray(f.uses) || !f.uses.length || f.uses.some((u) => !USES.includes(u))) err(`${w}.finder.uses`, `must list some of ${USES.join(', ')}`);
      if ('rare' in f && f.rare !== true) err(`${w}.finder.rare`, 'is only written when true');
    }
    if (p.bloom !== null && p.bloom !== 'all') {
      const ok = Array.isArray(p.bloom) && p.bloom.length > 0 && p.bloom.every((m) => isInt(m) && m >= 1 && m <= 12)
        && new Set(p.bloom).size === p.bloom.length;
      if (!ok) err(`${w}.bloom`, 'must be null, "all" or a list of different months 1–12');
    }
    textOrNull(`${w}.bloomNote`, p.bloomNote);
    if (p.bloomNote !== null && p.bloom === null) err(`${w}.bloomNote`, 'needs bloom months');
    bool(`${w}.inGiftBox`, p.inGiftBox);
  });

  // stock pools
  const pools = new Map();
  list('catalog.pools', c.pools).forEach((pool, i) => {
    const w = `pools[${i}]${isObj(pool) && isStr(pool.code) ? ` (${pool.code})` : ''}`;
    if (!shape(w, pool, 'pool')) return;
    if (!isStr(pool.code) || !CODE_RE.test(pool.code)) err(`${w}.code`, 'must use a-z, 0-9, ":" and "-"');
    else if (pools.has(pool.code)) err(w, 'code listed twice');
    if (!slugs.has(pool.productSlug)) err(`${w}.productSlug`, `unknown product "${pool.productSlug}"`);
    else if (isStr(pool.code) && pool.code !== pool.productSlug && !pool.code.startsWith(`${pool.productSlug}:`)) err(`${w}.code`, `must be "${pool.productSlug}" or start with "${pool.productSlug}:"`);
    text(`${w}.name`, pool.name, 80);
    if (!POOL_UNITS.includes(pool.unit)) err(`${w}.unit`, `must be one of ${POOL_UNITS.join(', ')}`);
    pools.set(pool.code, pool);
  });

  // variants (packs)
  const variants = new Map();
  const labels = new Set();
  list('catalog.variants', c.variants).forEach((v, i) => {
    const w = `variants[${i}]${isObj(v) && isStr(v.code) ? ` (${v.code})` : ''}`;
    if (!shape(w, v, 'variant')) return;
    if (!isStr(v.code) || !CODE_RE.test(v.code)) err(`${w}.code`, 'must use a-z, 0-9, ":" and "-"');
    else if (variants.has(v.code)) err(w, 'code listed twice');
    variants.set(v.code, v);
    if (!slugs.has(v.productSlug)) err(`${w}.productSlug`, `unknown product "${v.productSlug}"`);
    else if (isStr(v.code) && !v.code.startsWith(`${v.productSlug}:`)) err(`${w}.code`, `must start with "${v.productSlug}:"`);
    text(`${w}.label`, v.label, 40);
    if (labels.has(`${v.productSlug}\u0000${v.label}`)) err(`${w}.label`, `"${v.label}" is used twice for ${v.productSlug}`);
    labels.add(`${v.productSlug}\u0000${v.label}`);
    int(`${w}.sort`, v.sort); bool(`${w}.active`, v.active);
    if (v.netGrams !== null) int(`${w}.netGrams`, v.netGrams, 1);
    const pool = pools.get(v.poolCode);
    if (!pool) err(`${w}.poolCode`, `unknown pool "${v.poolCode}"`);
    else if (pool.productSlug !== v.productSlug) err(`${w}.poolCode`, `pool "${v.poolCode}" belongs to another product`);
    int(`${w}.poolQty`, v.poolQty, 1);
    if (pool?.unit === 'g' && v.poolQty !== v.netGrams) err(`${w}.poolQty`, 'must equal netGrams for a pool counted in grams');
    if (v.pricePaise !== null && (!isInt(v.pricePaise) || v.pricePaise < 100 || v.pricePaise > 10_000_000)) err(`${w}.pricePaise`, 'must be null or whole paise between 100 and 1,00,00,000');
    if (v.mrpPaise !== null && (v.pricePaise === null || !isInt(v.mrpPaise) || v.mrpPaise < v.pricePaise)) err(`${w}.mrpPaise`, 'must be null, or whole paise ≥ the price (and needs a price)');
    bool(`${w}.giftOk`, v.giftOk);
    if (!AVAILS.includes(v.avail)) err(`${w}.avail`, `must be one of ${AVAILS.join(', ')}`);
  });
  for (const p of slugs.values()) {
    if (p.status === 'live' && ![...variants.values()].some((v) => v.productSlug === p.slug && v.active === true)) err(`products (${p.slug})`, 'a live product needs at least one active pack');
  }

  // settings
  const s = c.settings;
  if (shape('settings', s, 'settings')) {
    bool('settings.showPrices', s.showPrices);
    if (!STOCK_DISPLAYS.includes(s.stockDisplay)) err('settings.stockDisplay', `must be one of ${STOCK_DISPLAYS.join(', ')}`);
    text('settings.deliveryNote', s.deliveryNote, 200);
    if (s.offer !== null && shape('settings.offer', s.offer, 'offer')) {
      text('settings.offer.text', s.offer.text, 120);
      if (s.offer.href !== null && !(isStr(s.offer.href) && s.offer.href.startsWith('/') && !s.offer.href.startsWith('//'))) err('settings.offer.href', 'must be null or a site path starting with /');
      if (s.offer.until !== null && !isDate(s.offer.until)) err('settings.offer.until', 'must be null or YYYY-MM-DD');
    }
    if (shape('settings.gift', s.gift, 'gift')) {
      int('settings.gift.feePaise', s.gift.feePaise, 0);
      int('settings.gift.bulkFrom', s.gift.bulkFrom, 1);
      if (!isObj(s.gift.extras)) err('settings.gift.extras', 'must be an object');
      else for (const [name, code] of Object.entries(s.gift.extras)) {
        if (code !== null && !variants.has(code)) err(`settings.gift.extras["${name}"]`, `unknown pack "${code}"`);
      }
    }
  }

  // batches
  const keys = new Set();
  list('catalog.batches', c.batches).forEach((b, i) => {
    const w = `batches[${i}]${isObj(b) && isStr(b.code) ? ` (${b.code})` : ''}`;
    if (!shape(w, b, 'batch')) return;
    const key = isStr(b.code) ? batchKey(b.code) : '';
    if (!key) err(`${w}.code`, 'is empty');
    else if (keys.has(key)) err(`${w}.code`, 'is listed twice');
    keys.add(key);
    if (!slugs.has(b.productSlug)) err(`${w}.productSlug`, `unknown product "${b.productSlug}"`);
    text(`${w}.harvested`, b.harvested);
    if (!isDate(b.packed)) err(`${w}.packed`, 'must look like 2026-11-10');
    if (!isStr(b.bestBefore) || !MONTH_RE.test(b.bestBefore)) err(`${w}.bestBefore`, 'must look like 2028-11');
    textOrNull(`${w}.note`, b.note);
  });

  return errs;
}

/** Throws one error listing every problem (at most 25) */
export function assertCatalog(c, source = 'catalog') {
  const errs = validateCatalog(c);
  if (errs.length) {
    const more = errs.length > 25 ? `\n  … and ${errs.length - 25} more` : '';
    throw new Error(`${source} is not a valid catalog (${errs.length} problem${errs.length === 1 ? '' : 's'}):\n  ${errs.slice(0, 25).join('\n  ')}${more}`);
  }
  return c;
}
