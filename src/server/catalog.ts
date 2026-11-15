// Public reads built from D1:
// - buildCatalog(): exactly the catalog format of src/data/catalog.types.ts (GET /api/catalog.json, the build)
// - buildLivePayload(): the GET /api/live.json body (contract 2)
// - lookupBatch(): one public batch for the Know Your Jar live lookup
// Nothing here ever returns stock amounts, low levels, tracking flags, customer data, drafts or private notes.
import type {
  Avail, BloomMonths, Catalog, CatalogBatch, CatalogCategory, CatalogPool, CatalogProduct, CatalogSettings,
  CatalogVariant, CategoryId, FinderProfile, PoolUnit, ProductStatus, StockDisplay,
} from '../data/catalog.types';
import { CATALOG_FORMAT } from '../data/catalog.types';
import { batchKey } from '../data/catalog.validate.mjs';
import { packAvailability, publicAvail, type AvailabilityOverride } from '../lib/availability';
import { type D1, stmt } from './db';
import { settingsFromRows, type SettingsValues } from './settings';
import { istDate, nowIso } from './time';

interface ProductRow {
  id: number; slug: string; short_code: string; status: ProductStatus; sort: number; name: string; category: CategoryId;
  kind: string; badge: string; with_comb: number; tagline: string; tone: string; photo: string; card_photo: string | null;
  specs_json: string; colour_min: number | null; colour_max: number | null; about: string; love_json: string;
  use_head: string | null; use_text: string; store_text: string; finder_json: string | null; bloom_json: string | null;
  bloom_note: string | null; in_gift_box: number;
}
interface VariantRow {
  code: string; slug: string; label: string; sort: number; active: number; net_grams: number | null; pool_code: string;
  pool_qty: number; price_paise: number | null; mrp_paise: number | null; gift_ok: number;
  track_stock: number; on_hand: number; low_at: number | null; availability: AvailabilityOverride;
}

const SETTINGS_SQL = 'SELECT key, value, version FROM settings';
/** Packs with their pool state (server side only: amounts never leave this module) */
const variantsSql = (where: string) => `SELECT v.code, p.slug, v.label, v.sort, v.active, v.net_grams, s.code AS pool_code,
    v.pool_qty, v.price_paise, v.mrp_paise, v.gift_ok, s.track_stock, s.on_hand, s.low_at, s.availability
  FROM variants v JOIN products p ON p.id = v.product_id JOIN stock_pools s ON s.id = v.pool_id
  WHERE ${where}
  ORDER BY p.sort, p.slug, v.sort, v.code`;

/** Availability the website may show for one pack row (stock display applied) */
function availOf(r: VariantRow, display: StockDisplay): Avail {
  const raw = packAvailability({ trackStock: r.track_stock === 1, onHand: r.on_hand, lowAt: r.low_at, availability: r.availability }, r.pool_qty);
  return publicAvail(raw, display);
}

/** Public settings in the catalog's camelCase shape */
export function catalogSettings(v: SettingsValues): CatalogSettings {
  return {
    showPrices: v.show_prices,
    stockDisplay: v.stock_display,
    deliveryNote: v.delivery_note,
    offer: v.offer === null ? null : { text: v.offer.text, href: v.offer.href, until: v.offer.until },
    gift: { feePaise: v.gift.feePaise, extras: { ...v.gift.extras }, bulkFrom: v.gift.bulkFrom },
  };
}

function finderOf(json: string | null): FinderProfile | null {
  if (json === null) return null;
  const f = JSON.parse(json) as FinderProfile;
  return { taste: [...f.taste], uses: [...f.uses], ...(f.rare === true ? { rare: true } : {}) };
}

/**
 * The whole public catalog from D1 (live, paused and retired products; never drafts), in display order and
 * with every object's fields in the order of catalog.validate.mjs FIELDS. One D1 round trip (a read batch).
 * Availability is the public level (stock display applied). Run validateCatalog() on it in tests.
 */
export async function buildCatalog(db: D1): Promise<Catalog> {
  const STATUSES = ['live', 'paused', 'retired'];
  const [settingsRes, catRes, prodRes, galRes, poolRes, varRes, batchRes] = await db.batch([
    stmt(db, SETTINGS_SQL),
    stmt(db, 'SELECT id, name, title, intro, image, is_honey, sort FROM categories ORDER BY sort, id'),
    stmt(db, `SELECT id, slug, short_code, status, sort, name, category, kind, badge, with_comb, tagline, tone, photo, card_photo,
        specs_json, colour_min, colour_max, about, love_json, use_head, use_text, store_text, finder_json, bloom_json, bloom_note,
        in_gift_box
      FROM products WHERE status IN (?, ?, ?) ORDER BY sort, slug`, ...STATUSES),
    stmt(db, `SELECT pi.product_id, pi.image, pi.caption FROM product_images pi JOIN products p ON p.id = pi.product_id
      WHERE p.status IN (?, ?, ?) ORDER BY pi.product_id, pi.sort, pi.id`, ...STATUSES),
    stmt(db, `SELECT s.code, p.slug, s.name, s.unit FROM stock_pools s JOIN products p ON p.id = s.product_id
      WHERE p.status IN (?, ?, ?) ORDER BY p.sort, p.slug, s.sort, s.id`, ...STATUSES),
    stmt(db, variantsSql('p.status IN (?, ?, ?)'), ...STATUSES),
    stmt(db, `SELECT b.code, p.slug, b.harvested_label, b.packed_on, b.best_before, b.public_note
      FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.is_public = 1 AND b.status <> 'recalled' AND p.status IN (?, ?, ?)
      ORDER BY b.packed_on DESC, b.id DESC`, ...STATUSES),
  ]);
  const settings = settingsFromRows(settingsRes.results as { key: string; value: string; version: number }[]).values;

  const gallery = new Map<number, { src: string; caption: string }[]>();
  for (const g of galRes.results as { product_id: number; image: string; caption: string }[]) {
    if (!gallery.has(g.product_id)) gallery.set(g.product_id, []);
    gallery.get(g.product_id)!.push({ src: g.image, caption: g.caption });
  }

  const categories: CatalogCategory[] = (catRes.results as { id: CategoryId; name: string; title: string; intro: string; image: string; is_honey: number; sort: number }[])
    .map((c) => ({ id: c.id, name: c.name, title: c.title, intro: c.intro, image: c.image, isHoney: c.is_honey === 1, sort: c.sort }));

  const products: CatalogProduct[] = (prodRes.results as unknown as ProductRow[]).map((p) => ({
    slug: p.slug,
    shortCode: p.short_code,
    status: p.status,
    sort: p.sort,
    name: p.name,
    category: p.category,
    kind: p.kind,
    badge: p.badge,
    withComb: p.with_comb === 1,
    tagline: p.tagline,
    tone: p.tone,
    photo: p.photo,
    card: p.card_photo,
    gallery: gallery.get(p.id) ?? [],
    specs: JSON.parse(p.specs_json) as [string, string][],
    colour: p.colour_min === null || p.colour_max === null ? null : [p.colour_min, p.colour_max],
    about: p.about,
    love: JSON.parse(p.love_json) as string[],
    useHead: p.use_head,
    use: p.use_text,
    store: p.store_text,
    finder: finderOf(p.finder_json),
    bloom: p.bloom_json === null ? null : (JSON.parse(p.bloom_json) as BloomMonths),
    bloomNote: p.bloom_note,
    inGiftBox: p.in_gift_box === 1,
  }));

  const variants: CatalogVariant[] = (varRes.results as unknown as VariantRow[]).map((v) => ({
    code: v.code,
    productSlug: v.slug,
    label: v.label,
    sort: v.sort,
    active: v.active === 1,
    netGrams: v.net_grams,
    poolCode: v.pool_code,
    poolQty: v.pool_qty,
    pricePaise: v.price_paise,
    mrpPaise: v.mrp_paise,
    giftOk: v.gift_ok === 1,
    avail: availOf(v, settings.stock_display),
  }));

  const pools: CatalogPool[] = (poolRes.results as { code: string; slug: string; name: string; unit: PoolUnit }[])
    .map((s) => ({ code: s.code, productSlug: s.slug, name: s.name, unit: s.unit }));

  const batches: CatalogBatch[] = (batchRes.results as { code: string; slug: string; harvested_label: string; packed_on: string; best_before: string; public_note: string | null }[])
    .map((b) => ({ code: b.code, productSlug: b.slug, harvested: b.harvested_label, packed: b.packed_on, bestBefore: b.best_before, note: b.public_note }));

  return {
    format: CATALOG_FORMAT,
    siteVersion: settings.site_version,
    liveVersion: settings.live_version,
    categories,
    products,
    variants,
    pools,
    settings: catalogSettings(settings),
    batches,
  };
}

/** One pack in /api/live.json: [pricePaise | null, mrpPaise | null, availability, variant code] */
export type LiveEntry = [number | null, number | null, Avail, string];

/** Body of GET /api/live.json (contract 2) */
export interface LivePayload {
  lv: number;
  show: boolean;
  sd: StockDisplay;
  p: Record<string, Record<string, LiveEntry>>;
  offer: { text: string; link?: string } | null;
  note: string;
}

/** The offer to show today (IST), in the live.json shape, or null when there is none or it has ended */
export function liveOffer(offer: SettingsValues['offer'], at: string = nowIso()): LivePayload['offer'] {
  if (!offer) return null;
  if (offer.until !== null && istDate(at) > offer.until) return null;
  return offer.href ? { text: offer.text, link: offer.href } : { text: offer.text };
}

/**
 * The /api/live.json body: live and paused products, active packs only, current prices and public availability.
 * Two queries in one read batch (settings + packs). `at` decides whether the offer has ended.
 */
export async function buildLivePayload(db: D1, at: string = nowIso()): Promise<LivePayload> {
  const [settingsRes, varRes] = await db.batch([
    stmt(db, SETTINGS_SQL),
    stmt(db, variantsSql("p.status IN ('live', 'paused') AND v.active = 1")),
  ]);
  const s = settingsFromRows(settingsRes.results as { key: string; value: string; version: number }[]).values;
  const p: LivePayload['p'] = {};
  // While "Show prices" is off no price or MRP leaves the server (the same as the baked #price-data table).
  const show = s.show_prices === true;
  for (const v of varRes.results as unknown as VariantRow[]) {
    (p[v.slug] ??= {})[v.label] = [show ? v.price_paise : null, show ? v.mrp_paise : null, availOf(v, s.stock_display), v.code];
  }
  return { lv: s.live_version, show: s.show_prices, sd: s.stock_display, p, offer: liveOffer(s.offer, at), note: s.delivery_note };
}

/** site_version and live_version (one small read; for cache keys) */
export async function getVersions(db: D1): Promise<{ siteVersion: number; liveVersion: number }> {
  const rows = (await stmt(db, "SELECT key, value FROM settings WHERE key IN ('site_version', 'live_version')").all<{ key: string; value: string }>()).results;
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.value ?? 1);
  return { siteVersion: get('site_version'), liveVersion: get('live_version') };
}

/**
 * Public Know Your Jar lookup: the batch whose code matches ignoring case, spaces and punctuation, if it is
 * public, not recalled, and its product is on the website. Public fields only.
 */
export async function lookupBatch(db: D1, code: string): Promise<(CatalogBatch & { productName: string }) | null> {
  const key = batchKey(String(code ?? '').slice(0, 40));
  if (key.length < 3) return null;
  const b = await stmt(db, `SELECT b.code, p.slug, p.name, b.harvested_label, b.packed_on, b.best_before, b.public_note
    FROM batches b JOIN products p ON p.id = b.product_id
    WHERE b.code_key = ? AND b.is_public = 1 AND b.status <> 'recalled' AND p.status IN ('live', 'paused', 'retired')`, key)
    .first<{ code: string; slug: string; name: string; harvested_label: string; packed_on: string; best_before: string; public_note: string | null }>();
  if (!b) return null;
  return { code: b.code, productSlug: b.slug, harvested: b.harvested_label, packed: b.packed_on, bestBefore: b.best_before, note: b.public_note, productName: b.name };
}
