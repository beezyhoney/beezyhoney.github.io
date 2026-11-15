// Product editing for the admin (design §5 screens 5–6, amendments A2/A3): the Products list, the product editor
// (basics, photos, story, details, packs, Honey Finder, flowering, gift box), new products and copies, going live,
// pausing and retiring, shop order, and the reads the Stock screen needs.
//
// Same rules as the rest of src/server (see README.md):
// - writes are (db, actor, input, at?) → Result; owner only; one guarded D1 batch with its audit row;
// - editable rows carry `version`; a stale version is 'conflict' and changes nothing;
// - errors name the form field they belong to (`field`), using the editor's form field names;
// - a change the website bakes (anything on a product that is live, paused or retired) bumps site_version and
//   returns effects.publish = 'now' (the page then calls handleEffects → requestPublish); a change that
//   /api/live.json serves (prices, packs, status) also bumps live_version.
// Drafts never reach the website, so editing a draft has no effects. The slug is frozen once the product first
// went live (guarded UPDATE); before that a slug change also renames the pack and pool codes.
import { batchKey } from '../data/catalog.validate.mjs';
import { formatPoolAmount, type PoolLevel, type PoolUnit } from '../lib/availability';
import { formatINR } from '../lib/money';
import {
  type Actor, type D1, type D1Statement, type Effects, type Guard, type Result,
  all, auditInsert, fail, first, ok, ownerOnly, stmt, tryBatch, versionedUpdate,
} from './db';
import { bumpVersionStmt } from './settings';
import { listPools, type PoolView } from './stock';
import { nowIso } from './time';

// ───────────────────────────── constants ─────────────────────────────

export type CategoryId = 'comb-honey' | 'blossom-honey' | 'wild-rare' | 'from-the-hive';
export type ProductStatus = 'draft' | 'live' | 'paused' | 'retired';
export const CATEGORY_IDS: readonly CategoryId[] = ['comb-honey', 'blossom-honey', 'wild-rare', 'from-the-hive'];
export const TASTES = ['mild', 'floral', 'rich', 'herbal'] as const;
export const USES = ['daily', 'kids', 'remedy', 'gift', 'onthego'] as const;
export type Taste = (typeof TASTES)[number];
export type Use = (typeof USES)[number];

/** The 7-step honey colour grade (same as GRADES in src/data/products.ts; a unit test keeps them equal) */
export const GRADES: readonly [string, string][] = [
  ['Water white', '#F6F0D2'], ['Extra white', '#F1E3A0'], ['White', '#EACF73'], ['Extra light amber', '#E2B347'],
  ['Light amber', '#D4952A'], ['Amber', '#B46A16'], ['Dark amber', '#6B3A10'],
];

/** Background tints offered as swatches (the ones the shop uses today); any '#RRGGBB' is allowed too */
export const TONE_SWATCHES: readonly string[] = [
  '#EEF0D6', '#F7E3E6', '#DCE7E0', '#D3E5EF', '#F4EBD6', '#E8E1F0', '#F1E6D2', '#E4EEDC',
];

export const LIMITS = {
  name: 60, kind: 40, badge: 40, tagline: 140, caption: [3, 140] as const, specLabel: 40, specValue: 80, specs: 10,
  about: 2000, love: 6, loveItem: 160, useHead: 60, useText: 600, storeText: 400, bloomNote: 200, gallery: 20,
  packLabel: 40, packs: 12,
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/;
const SHORT_RE = /^[A-Z]{2,4}$/;
const TONE_RE = /^#[0-9A-Fa-f]{6}$/;
const IMAGE_RE = /^(?!\/)(?!.*\.\.)[^\\]{1,200}\.(jpe?g|png)$/i;
const MAX_GRAMS = 100_000;          // one pack: 100 kg at most
const MAX_POOL_QTY = 100_000;

// ───────────────────────────── small helpers ─────────────────────────────

/** URL slug from a name: 'Jamun Honey' → 'jamun-honey' (a–z, 0–9, single hyphens) */
export function slugify(text: string): string {
  return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
}

/** Pack code suffix from a pack label: '250 g' → '250g', 'Box of 10 (100 g)' → 'box-of-10-100g', '1 kg' → '1kg' */
export function packSuffix(label: string): string {
  const s = String(label ?? '').toLowerCase().replace(/(\d)\s+(kg|g|ml|l)\b/g, '$1$2');
  return slugify(s).slice(0, 30).replace(/-+$/g, '') || 'pack';
}

/** True when `slug` is a valid URL slug (3–60 a–z, 0–9 and inner hyphens) */
export const isSlug = (slug: string): boolean => SLUG_RE.test(slug) && !slug.includes('--');

/**
 * Flowering months in season order, as the bloom calendar expects them: the list starts after the longest gap,
 * so a winter bloom reads December – February: {1, 2, 12} → [12, 1, 2]; {3, 4, 5} → [3, 4, 5].
 */
export function seasonOrder(months: number[]): number[] {
  const set = [...new Set(months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
  if (set.length <= 1 || set.length === 12) return set;
  let bestGap = -1;
  let start = 0;
  for (let i = 0; i < set.length; i++) {
    const next = set[(i + 1) % set.length];
    const gap = (next - set[i] + 12) % 12;
    if (gap > bestGap) { bestGap = gap; start = (i + 1) % set.length; }
  }
  return [...set.slice(start), ...set.slice(0, start)];
}

/** Rough short code candidates from a name: 'Jamun Honey' → JAM, JMN, JA, JAMU, … (capitals only) */
export function shortCodeCandidates(name: string): string[] {
  const words = String(name ?? '').toUpperCase().normalize('NFKD').replace(/[^A-Z ]+/g, ' ').split(/\s+/)
    .filter((w) => w && !['HONEY', 'WITH', 'AND', 'THE', 'OF', 'COMB'].includes(w));
  const w = words[0] ?? 'NEW';
  const consonants = w[0] + w.slice(1).replace(/[AEIOU]/g, '');
  const out = [
    w.slice(0, 3),
    consonants.slice(0, 3),
    words.length > 1 ? (w[0] + words[1][0] + (words[1][1] ?? w[1] ?? 'X')) : '',
    w.slice(0, 2),
    w.slice(0, 4),
    consonants.slice(0, 4),
    w[0] + (w[2] ?? '') + (w[3] ?? ''),
  ];
  return [...new Set(out.filter((c) => SHORT_RE.test(c)))];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const len = (s: string) => [...s].length;

/**
 * Guards for writing several rows of one table in a batch all-or-nothing. Statement k may run only while rows
 * 0…k−1 were already changed by this batch (version + 1, stamped with `at` and `by`) and rows k… still have the
 * version the form saw. A stale version anywhere turns every statement into a no-op, and a repeated submit of the
 * same form finds row 0 already changed, so it changes nothing either.
 */
export function multiRowGuards(table: 'variants' | 'products' | 'stock_pools', rows: { id: number; version: number }[], at: string, by: string) {
  const sql = `(SELECT COUNT(*) FROM json_each(?) j JOIN ${table} r ON r.id = json_extract(j.value, '$[0]')
      AND r.version = json_extract(j.value, '$[1]') AND (json_extract(j.value, '$[2]') = 0 OR (r.updated_at = ? AND r.updated_by = ?))) = ?`;
  const at_ = (k: number): Guard => ({
    sql,
    params: [JSON.stringify(rows.map((r, i) => [r.id, i < k ? r.version + 1 : r.version, i < k ? 1 : 0])), at, by, rows.length],
  });
  return { before: at_, after: at_(rows.length) };
}

// ───────────────────────────── reads ─────────────────────────────

export interface ProductListItem {
  id: number;
  slug: string;
  name: string;
  status: ProductStatus;
  sort: number;
  category: CategoryId;
  shortCode: string;
  /** main photo path (repo photo or upload), or null for a draft without one */
  photo: string | null;
  card: string | null;
  /** lowest and highest price of the active packs (paise), null when none has a price */
  priceMin: number | null;
  priceMax: number | null;
  activePacks: number;
  /** active packs with no price ("Price on WhatsApp") */
  unpriced: number;
  /** stock per pool, in the owner's words */
  stock: { poolId: number; name: string; unit: PoolUnit; amountText: string; level: PoolLevel }[];
  version: number;
}

/** Every product (drafts too) in shop order, with price range and stock summary. One read batch + the pools. */
export async function listProductsAdmin(db: D1): Promise<ProductListItem[]> {
  const [prodRes, priceRes] = await db.batch([
    stmt(db, 'SELECT id, slug, name, status, sort, category, short_code, photo, card_photo, version FROM products ORDER BY sort, slug'),
    stmt(db, `SELECT product_id, MIN(price_paise) AS lo, MAX(price_paise) AS hi, COUNT(*) AS n,
        SUM(CASE WHEN price_paise IS NULL THEN 1 ELSE 0 END) AS unpriced
      FROM variants WHERE active = 1 GROUP BY product_id`),
  ]);
  const pools = await listPools(db, { includeRetired: true, includeDrafts: true });
  const prices = new Map((priceRes.results as { product_id: number; lo: number | null; hi: number | null; n: number; unpriced: number }[]).map((r) => [r.product_id, r]));
  type P = { id: number; slug: string; name: string; status: ProductStatus; sort: number; category: CategoryId; short_code: string; photo: string | null; card_photo: string | null; version: number };
  return (prodRes.results as unknown as P[]).map((p) => {
    const pr = prices.get(p.id);
    return {
      id: p.id, slug: p.slug, name: p.name, status: p.status, sort: p.sort, category: p.category, shortCode: p.short_code,
      photo: p.photo, card: p.card_photo, priceMin: pr?.lo ?? null, priceMax: pr?.hi ?? null, activePacks: pr?.n ?? 0,
      unpriced: pr?.unpriced ?? 0, version: p.version,
      stock: pools.filter((s) => s.productId === p.id).map((s) => ({ poolId: s.id, name: s.name, unit: s.unit, amountText: s.amountText, level: s.level })),
    };
  });
}

export interface EditorPack {
  id: number;
  code: string;
  label: string;
  sort: number;
  netGrams: number | null;
  poolId: number;
  poolQty: number;
  pricePaise: number | null;
  mrpPaise: number | null;
  active: boolean;
  giftOk: boolean;
  version: number;
}

export interface EditorPool { id: number; code: string; name: string; unit: PoolUnit; sort: number; amountText: string }

export interface ProductEditor {
  id: number;
  slug: string;
  shortCode: string;
  status: ProductStatus;
  sort: number;
  name: string;
  category: CategoryId;
  kind: string;
  badge: string;
  withComb: boolean;
  tagline: string;
  tone: string;
  photo: string | null;
  card: string | null;
  gallery: { src: string; caption: string }[];
  specs: [string, string][];
  colour: [number, number] | null;
  about: string;
  love: string[];
  useHead: string | null;
  use: string;
  store: string;
  finder: { taste: Taste[]; uses: Use[]; rare: boolean } | null;
  bloom: number[] | 'all' | null;
  bloomNote: string | null;
  inGiftBox: boolean;
  firstLiveAt: string | null;
  /** true once the product has been on the website: the slug can no longer change */
  slugFrozen: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  packs: EditorPack[];
  pools: EditorPool[];
}

type ProductRow = {
  id: number; slug: string; short_code: string; status: ProductStatus; sort: number; name: string; category: CategoryId; kind: string;
  badge: string; with_comb: number; tagline: string; tone: string; photo: string | null; card_photo: string | null; specs_json: string;
  colour_min: number | null; colour_max: number | null; about: string; love_json: string; use_head: string | null; use_text: string;
  store_text: string; finder_json: string | null; bloom_json: string | null; bloom_note: string | null; in_gift_box: number;
  first_live_at: string | null; version: number; created_at: string; updated_at: string; updated_by: string;
};

const parseJson = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

/** Everything the product editor shows, or null */
export async function getProductEditor(db: D1, id: number): Promise<ProductEditor | null> {
  const [pRes, gRes, vRes, sRes] = await db.batch([
    stmt(db, 'SELECT * FROM products WHERE id = ?', id),
    stmt(db, 'SELECT image, caption FROM product_images WHERE product_id = ? ORDER BY sort, id', id),
    stmt(db, `SELECT id, code, label, sort, net_grams, pool_id, pool_qty, price_paise, mrp_paise, active, gift_ok, version
      FROM variants WHERE product_id = ? ORDER BY sort, id`, id),
    stmt(db, 'SELECT id, code, name, unit, sort, on_hand FROM stock_pools WHERE product_id = ? ORDER BY sort, id', id),
  ]);
  const p = pRes.results[0] as unknown as ProductRow | undefined;
  if (!p) return null;
  const finder = parseJson<{ taste: Taste[]; uses: Use[]; rare?: boolean } | null>(p.finder_json, null);
  return {
    id: p.id, slug: p.slug, shortCode: p.short_code, status: p.status, sort: p.sort, name: p.name, category: p.category,
    kind: p.kind, badge: p.badge, withComb: p.with_comb === 1, tagline: p.tagline, tone: p.tone, photo: p.photo, card: p.card_photo,
    gallery: (gRes.results as { image: string; caption: string }[]).map((g) => ({ src: g.image, caption: g.caption })),
    specs: parseJson<[string, string][]>(p.specs_json, []),
    colour: p.colour_min === null || p.colour_max === null ? null : [p.colour_min, p.colour_max],
    about: p.about, love: parseJson<string[]>(p.love_json, []), useHead: p.use_head, use: p.use_text, store: p.store_text,
    finder: finder ? { taste: finder.taste ?? [], uses: finder.uses ?? [], rare: finder.rare === true } : null,
    bloom: parseJson<number[] | 'all' | null>(p.bloom_json, null), bloomNote: p.bloom_note, inGiftBox: p.in_gift_box === 1,
    firstLiveAt: p.first_live_at, slugFrozen: p.first_live_at !== null, version: p.version, createdAt: p.created_at,
    updatedAt: p.updated_at, updatedBy: p.updated_by,
    packs: (vRes.results as { id: number; code: string; label: string; sort: number; net_grams: number | null; pool_id: number; pool_qty: number; price_paise: number | null; mrp_paise: number | null; active: number; gift_ok: number; version: number }[])
      .map((v) => ({ id: v.id, code: v.code, label: v.label, sort: v.sort, netGrams: v.net_grams, poolId: v.pool_id, poolQty: v.pool_qty, pricePaise: v.price_paise, mrpPaise: v.mrp_paise, active: v.active === 1, giftOk: v.gift_ok === 1, version: v.version })),
    pools: (sRes.results as { id: number; code: string; name: string; unit: PoolUnit; sort: number; on_hand: number }[])
      .map((s) => ({ id: s.id, code: s.code, name: s.name, unit: s.unit, sort: s.sort, amountText: formatPoolAmount(s.on_hand, s.unit) })),
  };
}

/** Products for pickers (id, name, status, category, short code), shop order */
export async function productChoices(db: D1): Promise<{ id: number; name: string; slug: string; status: ProductStatus; category: CategoryId; shortCode: string }[]> {
  const rows = await all<{ id: number; name: string; slug: string; status: ProductStatus; category: CategoryId; short_code: string }>(db,
    'SELECT id, name, slug, status, category, short_code FROM products ORDER BY sort, slug');
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, status: r.status, category: r.category, shortCode: r.short_code }));
}

/** The four shop sections (id, name) in display order */
export async function categoryChoices(db: D1): Promise<{ id: CategoryId; name: string; isHoney: boolean }[]> {
  const rows = await all<{ id: CategoryId; name: string; is_honey: number }>(db, 'SELECT id, name, is_honey FROM categories ORDER BY sort, id');
  return rows.map((r) => ({ id: r.id, name: r.name, isHoney: r.is_honey === 1 }));
}

export interface ImageRow { path: string; source: 'repo' | 'upload'; thumbPath: string | null; width: number; height: number; public: boolean; createdAt: string }

/** Every known photo: uploads first (newest first), then repo photos by name */
export async function listImages(db: D1): Promise<ImageRow[]> {
  const rows = await all<{ path: string; source: 'repo' | 'upload'; thumb_path: string | null; width: number; height: number; public: number; created_at: string }>(db,
    `SELECT path, source, thumb_path, width, height, public, created_at FROM images
      ORDER BY CASE source WHEN 'upload' THEN 0 ELSE 1 END, CASE source WHEN 'upload' THEN created_at END DESC, path`);
  return rows.map((r) => ({ path: r.path, source: r.source, thumbPath: r.thumb_path, width: r.width, height: r.height, public: r.public === 1, createdAt: r.created_at }));
}

/** Suggested free slug for a name ('jamun-honey', then 'jamun-honey-2' …), never `exceptId`'s own */
export async function suggestSlug(db: D1, name: string, exceptId?: number): Promise<string> {
  let base = slugify(name);
  if (base.length < 3) base = `${base || 'product'}-honey`.replace(/^-/, '');
  base = base.slice(0, 56).replace(/-+$/g, '');
  const taken = new Set((await all<{ slug: string }>(db, 'SELECT slug FROM products WHERE id <> ?', exceptId ?? 0)).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now() % 100_000}`;
}

/** Suggested free short code for a name (JAM, JMN, …), never `exceptId`'s own */
export async function suggestShortCode(db: D1, name: string, exceptId?: number): Promise<string> {
  const taken = new Set((await all<{ short_code: string }>(db, 'SELECT short_code FROM products WHERE id <> ?', exceptId ?? 0)).map((r) => r.short_code));
  for (const c of shortCodeCandidates(name)) if (!taken.has(c)) return c;
  const first = (shortCodeCandidates(name)[0] ?? 'NEW').slice(0, 1);
  for (let a = 0; a < 26; a++) for (let b = 0; b < 26; b++) {
    const c = `${first}${String.fromCharCode(65 + a)}${String.fromCharCode(65 + b)}`;
    if (!taken.has(c)) return c;
  }
  return 'ZZZZ';
}

/** Distinct tones in use plus the standard swatches (for the tone picker) */
export async function toneChoices(db: D1): Promise<string[]> {
  const used = (await all<{ tone: string }>(db, 'SELECT DISTINCT tone FROM products ORDER BY tone')).map((r) => r.tone.toUpperCase());
  return [...new Set([...TONE_SWATCHES.map((t) => t.toUpperCase()), ...used])];
}

// ───────────────────────────── stock screen reads ─────────────────────────────

/** Pool units sold in the last `days` days, per pool (sales minus reversals), in ONE query */
export async function poolUsageAll(db: D1, days = 30, at: string = nowIso()): Promise<Map<number, number>> {
  const since = `${new Date(Date.parse(at) - days * 86_400_000).toISOString().slice(0, 19)}Z`;
  const rows = await all<{ pool_id: number; used: number }>(db, `SELECT pool_id, -SUM(delta) AS used FROM stock_moves
    WHERE reason IN ('sale', 'sale_reversal') AND created_at >= ? GROUP BY pool_id`, since);
  return new Map(rows.map((r) => [r.pool_id, Math.max(0, r.used)]));
}

export interface StockRow extends PoolView {
  /** pool units used in the last 30 days */
  used30: number;
  /** days the stock lasts at the last 30 days' pace; null when nothing sold or tracking is off */
  daysOfCover: number | null;
}

/** The Stock screen: every pool with its 30-day use and days of cover, and the low-stock list (shortest cover first) */
export async function stockOverview(db: D1, opts: { includeRetired?: boolean; includeDrafts?: boolean; at?: string } = {}): Promise<{ pools: StockRow[]; low: StockRow[] }> {
  const [pools, usage] = await Promise.all([listPools(db, opts), poolUsageAll(db, 30, opts.at)]);
  const rows: StockRow[] = pools.map((p) => {
    const used30 = usage.get(p.id) ?? 0;
    const daysOfCover = p.trackStock && used30 > 0 ? Math.max(0, Math.floor(p.onHand / (used30 / 30))) : (p.trackStock && p.onHand <= 0 ? 0 : null);
    return { ...p, used30, daysOfCover };
  });
  const low = rows
    .filter((r) => r.trackStock && (r.level === 'negative' || r.level === 'empty' || r.level === 'low' || (r.daysOfCover !== null && r.daysOfCover < 30)))
    .sort((a, b) => (a.daysOfCover ?? Number.MAX_SAFE_INTEGER) - (b.daysOfCover ?? Number.MAX_SAFE_INTEGER) || a.onHand - b.onHand || a.name.localeCompare(b.name));
  return { pools: rows, low };
}

// ───────────────────────────── product input checks ─────────────────────────────

export interface ProductInput {
  id: number;
  version: number;
  name: string;
  category: string;
  kind: string;
  badge: string;
  withComb: boolean;
  tagline: string;
  tone: string;
  /** new slug (ignored when equal; refused once the product has been live) */
  slug?: string;
  shortCode?: string;
  photo: string | null;
  card: string | null;
  gallery: { src: string; caption: string }[];
  specs: [string, string][];
  colour: [number, number] | null;
  about: string;
  love: string[];
  useHead: string | null;
  use: string;
  store: string;
  finder: { taste: string[]; uses: string[]; rare: boolean } | null;
  bloom: number[] | 'all' | null;
  bloomNote: string | null;
  inGiftBox: boolean;
}

/** Photos the build knows (from /photo-library.json): path → size. Lets a repo photo that has no images row yet be used. */
export type PhotoLibrary = ReadonlyMap<string, { width: number; height: number }>;

/** Form field names the editor uses for each part (errors carry these in `field`) */
export const PRODUCT_FIELDS = [
  'name', 'category', 'kind', 'badge', 'tagline', 'tone', 'slug', 'short_code', 'photo', 'card', 'gallery', 'specs',
  'colour', 'about', 'love', 'use_head', 'use_text', 'store_text', 'finder', 'bloom', 'bloom_note',
] as const;

const bad = (field: string, message: string) => fail('invalid', message, { field });

/** Checks the editor input (typing rules only; database rules come later). Returns a Failure or null. */
export function checkProductInput(i: ProductInput): ReturnType<typeof fail> | null {
  if (!i || typeof i !== 'object') return fail('invalid', 'Nothing to save.');
  const name = i.name?.trim() ?? '';
  if (len(name) < 2 || len(name) > LIMITS.name) return bad('name', `The name needs 2–${LIMITS.name} characters.`);
  if (!CATEGORY_IDS.includes(i.category as CategoryId)) return bad('category', 'Choose a shop section.');
  if (len(i.kind ?? '') > LIMITS.kind) return bad('kind', `Keep the kind to ${LIMITS.kind} characters.`);
  if (len(i.badge ?? '') > LIMITS.badge) return bad('badge', `Keep the badge to ${LIMITS.badge} characters.`);
  if (len(i.tagline ?? '') > LIMITS.tagline) return bad('tagline', `Keep the tagline to ${LIMITS.tagline} characters.`);
  if (!TONE_RE.test(i.tone ?? '')) return bad('tone', 'Pick a background colour, or type one like #EEF0D6.');
  if (i.slug !== undefined && !isSlug(i.slug)) return bad('slug', 'The web address needs 3–60 small letters, numbers and single hyphens, like jamun-honey.');
  if (i.shortCode !== undefined && !SHORT_RE.test(i.shortCode)) return bad('short_code', 'The short code is 2–4 capital letters, like JAM.');
  for (const p of [i.photo, i.card]) if (p !== null && p !== undefined && !IMAGE_RE.test(p)) return bad(p === i.photo ? 'photo' : 'card', 'This photo cannot be used.');
  if (!Array.isArray(i.gallery) || i.gallery.length > LIMITS.gallery) return bad('gallery', `The gallery can have up to ${LIMITS.gallery} photos.`);
  const seen = new Set<string>();
  for (const [k, g] of i.gallery.entries()) {
    if (!IMAGE_RE.test(g.src)) return bad(`g_cap_${k}`, 'This photo cannot be used.');
    if (seen.has(g.src)) return bad(`g_cap_${k}`, 'This photo is in the gallery twice.');
    seen.add(g.src);
    const c = g.caption?.trim() ?? '';
    if (len(c) < LIMITS.caption[0] || len(c) > LIMITS.caption[1]) return bad(`g_cap_${k}`, `Write a caption of ${LIMITS.caption[0]}–${LIMITS.caption[1]} characters (it is also read out to blind visitors).`);
  }
  if (!Array.isArray(i.specs) || i.specs.length > LIMITS.specs) return bad('specs', `Up to ${LIMITS.specs} detail rows.`);
  for (const [k, [l, v]] of i.specs.entries()) {
    if (!l?.trim() || !v?.trim()) return bad(`spec_${k}`, 'Fill in both the label and the value, or leave the row empty.');
    if (len(l) > LIMITS.specLabel || len(v) > LIMITS.specValue) return bad(`spec_${k}`, `Keep the label to ${LIMITS.specLabel} and the value to ${LIMITS.specValue} characters.`);
  }
  if (i.colour !== null) {
    const [a, b] = i.colour;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > 6 || a > b) return bad('colour', 'Pick the lightest and the darkest colour (lightest first).');
  }
  if (len(i.about ?? '') > LIMITS.about) return bad('about', `Keep the description to ${LIMITS.about} characters.`);
  if (!Array.isArray(i.love) || i.love.length > LIMITS.love) return bad('love', `Up to ${LIMITS.love} points.`);
  for (const [k, l] of i.love.entries()) {
    if (!l.trim()) return bad(`love_${k}`, 'Write the point or leave it empty.');
    if (len(l) > LIMITS.loveItem) return bad(`love_${k}`, `Keep each point to ${LIMITS.loveItem} characters.`);
  }
  if (i.useHead !== null && (len(i.useHead) < 1 || len(i.useHead) > LIMITS.useHead)) return bad('use_head', `Keep the heading to ${LIMITS.useHead} characters.`);
  if (len(i.use ?? '') > LIMITS.useText) return bad('use_text', `Keep this to ${LIMITS.useText} characters.`);
  if (len(i.store ?? '') > LIMITS.storeText) return bad('store_text', `Keep this to ${LIMITS.storeText} characters.`);
  if (i.finder !== null) {
    if (!i.finder.taste.length || i.finder.taste.some((t) => !(TASTES as readonly string[]).includes(t))) return bad('finder', 'Tick at least one taste for the Honey Finder (or switch it off).');
    if (!i.finder.uses.length || i.finder.uses.some((u) => !(USES as readonly string[]).includes(u))) return bad('finder', 'Tick at least one use for the Honey Finder (or switch it off).');
  }
  if (i.bloom !== null && i.bloom !== 'all') {
    if (!Array.isArray(i.bloom) || !i.bloom.length || i.bloom.some((m) => !Number.isInteger(m) || m < 1 || m > 12) || new Set(i.bloom).size !== i.bloom.length) {
      return bad('bloom', 'Tick the flowering months, choose "Most of the year", or switch the calendar off.');
    }
  }
  if (i.bloomNote !== null) {
    if (i.bloom === null) return bad('bloom_note', 'A flowering note needs flowering months.');
    if (len(i.bloomNote) < 1 || len(i.bloomNote) > LIMITS.bloomNote) return bad('bloom_note', `Keep the note to ${LIMITS.bloomNote} characters.`);
  }
  return null;
}

/** What a product needs before it can be on the website (live, paused or retired). Returns the first gap or null. */
export function websiteGaps(p: { photo: string | null; kind: string; badge: string; tagline: string; about: string; use: string; store: string; gallery: { caption: string }[] }, activePacks: number): ReturnType<typeof fail> | null {
  if (!p.photo) return bad('photo', 'Choose a main photo first.');
  if (!p.gallery.length) return bad('gallery', 'Add at least one gallery photo with a caption first.');
  for (const [k, g] of p.gallery.entries()) {
    if (len(g.caption.trim()) < LIMITS.caption[0]) return bad(`g_cap_${k}`, 'Every gallery photo needs a caption first.');
  }
  const texts: [string, string, string][] = [
    ['kind', p.kind, 'Write the kind (for example Monofloral) first.'],
    ['badge', p.badge, 'Write the badge (for example With honeycomb) first.'],
    ['tagline', p.tagline, 'Write the tagline first.'],
    ['about', p.about, 'Write the description first.'],
    ['use_text', p.use, 'Write how to enjoy it first.'],
    ['store_text', p.store, 'Write how to store it first.'],
  ];
  for (const [field, v, msg] of texts) if (!v.trim()) return bad(field, msg);
  if (activePacks < 1) return bad('packs', 'Add at least one pack that is switched on first.');
  return null;
}

/** Statement that makes photos public, only while the guard holds */
function publicImagesStmt(db: D1, paths: string[], guard?: Guard): D1Statement {
  return stmt(db, `UPDATE images SET public = 1 WHERE public = 0 AND path IN (SELECT value FROM json_each(?))${guard ? ` AND ${guard.sql}` : ''}`,
    JSON.stringify([...new Set(paths)]), ...(guard?.params ?? []));
}

/** Rows for repo photos the build has but the database does not know yet (INSERT OR IGNORE) */
function repoImageStmts(db: D1, paths: string[], known: Set<string>, library: PhotoLibrary | undefined, at: string, by: string): D1Statement[] | { missing: string } {
  const out: D1Statement[] = [];
  for (const p of new Set(paths)) {
    if (known.has(p)) continue;
    const lib = library?.get(p);
    if (!lib || p.startsWith('uploads/')) return { missing: p };
    out.push(stmt(db, `INSERT OR IGNORE INTO images (path, source, thumb_path, width, height, bytes, public, created_at, created_by)
      VALUES (?, 'repo', NULL, ?, ?, NULL, 0, ?, ?)`, p, lib.width, lib.height, at, by));
  }
  return out;
}

const productGuard = (id: number, version: number, at: string, by: string): Guard =>
  ({ sql: 'EXISTS (SELECT 1 FROM products WHERE id = ? AND version = ? AND updated_at = ? AND updated_by = ?)', params: [id, version, at, by] });

// ───────────────────────────── save ─────────────────────────────

export interface ProductSaved {
  version: number;
  slug: string;
  effects: Effects;
}

/**
 * The editor's Save: every product field and the gallery, version-checked, in one batch.
 * - The slug can change only while the product has never been live (the UPDATE is guarded); a change also renames
 *   the pack and pool codes ('old-slug:250g' → 'new-slug:250g').
 * - A product on the website must keep what the website needs (photo, gallery captions, texts).
 * - On a product on the website: photos become public, site_version + 1, effects.publish = 'now'.
 * Errors: forbidden, not_found, invalid (field), conflict (version, slug or short code taken).
 */
export async function saveProduct(db: D1, actor: Actor, input: ProductInput, at: string = nowIso(), opts: { library?: PhotoLibrary } = {}): Promise<Result<ProductSaved>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const problem = checkProductInput(input);
  if (problem) return problem;
  const cur = await first<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', input.id);
  if (!cur) return fail('not_found', 'This product does not exist.');
  if (!Number.isSafeInteger(input.version)) return fail('invalid', 'Reload the page and try again.');
  if (input.version !== cur.version) return fail('conflict', 'Someone else saved this product meanwhile. Reload the page; your typing is kept as a draft.');

  const slug = input.slug && input.slug !== cur.slug ? input.slug : cur.slug;
  if (slug !== cur.slug && cur.first_live_at !== null) return bad('slug', 'The web address cannot change after the product has been on the website (old links would break).');
  const shortCode = input.shortCode && input.shortCode !== cur.short_code ? input.shortCode : cur.short_code;
  if (slug !== cur.slug && await first(db, 'SELECT 1 AS x FROM products WHERE slug = ? AND id <> ?', slug, cur.id)) return fail('conflict', `The web address ${slug} is already used by another product.`, { field: 'slug' });
  if (shortCode !== cur.short_code && await first(db, 'SELECT 1 AS x FROM products WHERE short_code = ? AND id <> ?', shortCode, cur.id)) return fail('conflict', `The short code ${shortCode} is already used by another product.`, { field: 'short_code' });

  const onSite = cur.status !== 'draft';
  const gallery = input.gallery.map((g) => ({ src: g.src, caption: g.caption.trim() }));
  const text = {
    kind: input.kind.trim(), badge: input.badge.trim(), tagline: input.tagline.trim(), about: input.about.trim(), use: input.use.trim(), store: input.store.trim(),
  };
  if (onSite) {
    const activePacks = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM variants WHERE product_id = ? AND active = 1', cur.id))?.n ?? 0;
    const gap = websiteGaps({ photo: input.photo, gallery, ...text }, activePacks);
    if (gap) return fail('invalid', `${gap.message.replace(/ first\.$/, '.')} A product on the website needs it.`, { field: gap.field });
  }

  // photos: every one must be known (uploads always are; repo photos may come from the build's photo library)
  const paths = [input.photo, input.card, ...gallery.map((g) => g.src)].filter((p): p is string => !!p);
  const known = new Set((await all<{ path: string }>(db, 'SELECT path FROM images WHERE path IN (SELECT value FROM json_each(?))', JSON.stringify(paths))).map((r) => r.path));
  const by = actor.email;
  const imgStmts = repoImageStmts(db, paths, known, opts.library, at, by);
  if (!Array.isArray(imgStmts)) {
    const field = imgStmts.missing === input.photo ? 'photo' : imgStmts.missing === input.card ? 'card' : 'gallery';
    return bad(field, 'One of the chosen photos no longer exists. Reload the page and choose again.');
  }

  const finderJson = input.finder ? JSON.stringify({ taste: input.finder.taste, uses: input.finder.uses, ...(input.finder.rare ? { rare: true } : {}) }) : null;
  const curBloom = parseJson<number[] | 'all' | null>(cur.bloom_json, null);
  // keep the stored season order when the months did not change
  const bloom = Array.isArray(input.bloom) && Array.isArray(curBloom) && curBloom.length === input.bloom.length && curBloom.every((m) => input.bloom!.includes(m as number))
    ? curBloom : Array.isArray(input.bloom) ? seasonOrder(input.bloom) : input.bloom;
  const set: Record<string, unknown> = {
    slug, short_code: shortCode, name: input.name.trim(), category: input.category, kind: text.kind, badge: text.badge,
    with_comb: input.withComb ? 1 : 0, tagline: text.tagline, tone: input.tone.toUpperCase(), photo: input.photo, card_photo: input.card,
    specs_json: JSON.stringify(input.specs.map(([l, v]) => [l.trim(), v.trim()])),
    colour_min: input.colour ? input.colour[0] : null, colour_max: input.colour ? input.colour[1] : null,
    about: text.about, love_json: JSON.stringify(input.love.map((l) => l.trim())), use_head: input.useHead?.trim() || null,
    use_text: text.use, store_text: text.store, finder_json: finderJson, bloom_json: bloom === null ? null : JSON.stringify(bloom),
    bloom_note: input.bloomNote?.trim() || null, in_gift_box: input.inGiftBox ? 1 : 0,
  };
  // what changed (for the audit and to skip empty saves)
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    if ((cur as unknown as Record<string, unknown>)[k] !== v) { before[k] = (cur as unknown as Record<string, unknown>)[k]; after[k] = v; }
  }
  const curGallery = (await all<{ image: string; caption: string }>(db, 'SELECT image, caption FROM product_images WHERE product_id = ? ORDER BY sort, id', cur.id));
  const galleryChanged = JSON.stringify(curGallery.map((g) => [g.image, g.caption])) !== JSON.stringify(gallery.map((g) => [g.src, g.caption]));
  if (galleryChanged) { before.gallery = curGallery.length; after.gallery = gallery.length; }
  if (!Object.keys(after).length) return ok({ version: cur.version, slug: cur.slug, effects: { publish: null, live: false } });

  const guard = productGuard(cur.id, cur.version + 1, at, by);
  const statements: D1Statement[] = [
    ...imgStmts,
    versionedUpdate(db, {
      table: 'products', key: ['id', cur.id], version: cur.version, set, actor, at,
      // the frozen-slug rule, in the database: once first_live_at is set, the slug must stay
      guard: { sql: '(first_live_at IS NULL OR slug = ?)', params: [slug] },
    }),
  ];
  if (slug !== cur.slug) {
    statements.push(
      stmt(db, `UPDATE variants SET code = ? || substr(code, instr(code, ':')), updated_at = ?, updated_by = ? WHERE product_id = ? AND ${guard.sql}`, slug, at, by, cur.id, ...guard.params),
      stmt(db, `UPDATE stock_pools SET code = CASE WHEN instr(code, ':') > 0 THEN ? || substr(code, instr(code, ':')) ELSE ? END, updated_at = ?, updated_by = ?
        WHERE product_id = ? AND ${guard.sql}`, slug, slug, at, by, cur.id, ...guard.params),
    );
  }
  if (galleryChanged) {
    statements.push(
      stmt(db, `DELETE FROM product_images WHERE product_id = ? AND ${guard.sql}`, cur.id, ...guard.params),
      stmt(db, `INSERT INTO product_images (product_id, image, caption, sort)
        SELECT ?, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), j.key + 1 FROM json_each(?) j WHERE ${guard.sql}`,
      cur.id, JSON.stringify(gallery.map((g) => [g.src, g.caption])), ...guard.params),
    );
  }
  if (onSite) {
    statements.push(publicImagesStmt(db, paths, guard), bumpVersionStmt(db, 'site_version', at, by, guard));
  }
  const changedWords = Object.keys(after).map((k) => FIELD_WORDS[k] ?? k);
  statements.push(auditInsert(db, {
    at, actor, action: 'product.save', entity: 'product', entityId: cur.id,
    summary: clip(`${set.name as string}: ${changedWords.join(', ')} changed${slug !== cur.slug ? ` (web address /shop/${slug}/)` : ''}`, 500),
    before, after,
  }, guard));

  const res = await tryBatch(db, statements, { unique: 'The web address or short code is already used by another product.' });
  if (!res.ok) return res;
  if (res.value[imgStmts.length].meta.changes !== 1) return fail('conflict', 'Someone else saved this product meanwhile. Reload the page; your typing is kept as a draft.');
  return ok({ version: cur.version + 1, slug, effects: { publish: onSite ? 'now' : null, live: false } });
}

const FIELD_WORDS: Record<string, string> = {
  slug: 'web address', short_code: 'short code', name: 'name', category: 'shop section', kind: 'kind', badge: 'badge',
  with_comb: 'comb', tagline: 'tagline', tone: 'background colour', photo: 'main photo', card_photo: 'card photo',
  specs_json: 'details', colour_min: 'colour grade', colour_max: 'colour grade', about: 'description', love_json: 'why you’ll love it',
  use_head: 'how-to heading', use_text: 'how to enjoy', store_text: 'storage', finder_json: 'Honey Finder', bloom_json: 'flowering',
  bloom_note: 'flowering note', in_gift_box: 'gift box', gallery: 'gallery',
};

// ───────────────────────────── packs ─────────────────────────────

export interface PackInput {
  /** existing pack id; leave out for a new pack */
  id?: number;
  /** the version the form saw (existing packs) */
  version?: number;
  label: string;
  netGrams: number | null;
  poolId: number;
  /** pool units per pack; for a gram pool it is always the net grams */
  poolQty: number | null;
  pricePaise: number | null;
  mrpPaise: number | null;
  active: boolean;
  giftOk: boolean;
}

export interface PacksSaved {
  changed: number;
  added: number;
  priceChanges: { variantId: number; label: string; oldPrice: number | null; newPrice: number | null; oldMrp: number | null; newMrp: number | null }[];
  effects: Effects;
}

/** Field name of a pack's form row (errors carry it): 'pack_<id>' or 'pack_new' */
export const packField = (p: { id?: number }) => (p.id ? `pack_${p.id}` : 'pack_new');

/**
 * "Save packs" (and "Add pack"): label, net grams, pool + pool quantity, price, MRP, active and gift OK of every
 * pack, plus an optional new pack, all-or-nothing (each pack's version is checked).
 * Prices go to price_history. On a product that is live or paused, a change bumps live_version (prices and
 * availability show in about a minute); on any product on the website it also bumps site_version (publish 'now').
 * Packs are never deleted: switch them off. A live product keeps at least one active pack.
 */
export async function savePacks(db: D1, actor: Actor, input: { productId: number; packs: PackInput[]; reason?: string }, at: string = nowIso()): Promise<Result<PacksSaved>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const product = await first<{ id: number; slug: string; name: string; status: ProductStatus }>(db, 'SELECT id, slug, name, status FROM products WHERE id = ?', input?.productId);
  if (!product) return fail('not_found', 'This product does not exist.');
  const packs = input.packs ?? [];
  if (!packs.length) return fail('invalid', 'Nothing to save.');
  const [curRes, poolRes, codeRes] = await db.batch([
    stmt(db, 'SELECT id, code, label, sort, net_grams, pool_id, pool_qty, price_paise, mrp_paise, active, gift_ok, version FROM variants WHERE product_id = ? ORDER BY sort, id', product.id),
    stmt(db, 'SELECT id, unit, name FROM stock_pools WHERE product_id = ?', product.id),
    stmt(db, 'SELECT code FROM variants'),
  ]);
  type V = { id: number; code: string; label: string; sort: number; net_grams: number | null; pool_id: number; pool_qty: number; price_paise: number | null; mrp_paise: number | null; active: number; gift_ok: number; version: number };
  const current = new Map((curRes.results as unknown as V[]).map((v) => [v.id, v]));
  const pools = new Map((poolRes.results as { id: number; unit: PoolUnit; name: string }[]).map((p) => [p.id, p]));
  const allCodes = new Set((codeRes.results as { code: string }[]).map((r) => r.code));
  const existing = packs.filter((p) => p.id);
  const added = packs.filter((p) => !p.id);
  if (current.size + added.length > LIMITS.packs) return fail('invalid', `A product can have up to ${LIMITS.packs} packs.`, { field: 'pack_new' });

  // check and normalise every row
  const labels = new Map<string, string>();
  const rows: { input: PackInput; label: string; netGrams: number | null; poolQty: number; price: number | null; mrp: number | null }[] = [];
  for (const p of packs) {
    const field = packField(p);
    if (p.id && !current.has(p.id)) return fail('conflict', 'A pack on this page no longer exists. Reload the page.', { field });
    const label = (p.label ?? '').trim().replace(/\s+/g, ' ');
    if (len(label) < 1 || len(label) > LIMITS.packLabel) return bad(field, `Give the pack a name of 1–${LIMITS.packLabel} characters, like 250 g.`);
    const key = label.toLowerCase();
    if (labels.has(key)) return bad(field, `Two packs are called "${label}". Each pack needs its own name.`);
    labels.set(key, field);
    const pool = pools.get(p.poolId);
    if (!pool) return bad(field, 'Choose which stock this pack takes from.');
    if (p.netGrams !== null && !(Number.isSafeInteger(p.netGrams) && p.netGrams > 0 && p.netGrams <= MAX_GRAMS)) return bad(field, 'Net weight must be whole grams, like 250.');
    let poolQty: number;
    if (pool.unit === 'g') {
      if (p.netGrams === null) return bad(field, 'Honey packs need their net weight in grams.');
      poolQty = p.netGrams;
    } else {
      if (!(p.poolQty !== null && Number.isSafeInteger(p.poolQty) && p.poolQty > 0 && p.poolQty <= MAX_POOL_QTY)) return bad(field, 'Say how many pieces one pack uses, like 1 or 10.');
      poolQty = p.poolQty;
    }
    const price = p.pricePaise;
    if (price !== null && !(Number.isSafeInteger(price) && price >= 100 && price <= 10_000_000)) return bad(field, 'The price must be between ₹1 and ₹1,00,000, or empty for "Price on WhatsApp".');
    let mrp = p.mrpPaise;
    if (mrp !== null) {
      if (price === null) return bad(field, 'An MRP needs a price. Enter the price too, or clear the MRP.');
      if (!(Number.isSafeInteger(mrp) && mrp <= 10_000_000)) return bad(field, 'The MRP is too big.');
      if (mrp < price) return bad(field, 'The MRP cannot be lower than the price.');
      if (mrp === price) mrp = null; // same as the price
    }
    rows.push({ input: p, label, netGrams: p.netGrams, poolQty, price, mrp });
  }
  // every existing pack must be on the form (so "the last active pack" is judged on the whole list)
  for (const id of current.keys()) if (!existing.some((p) => p.id === id)) return fail('conflict', 'The packs changed meanwhile. Reload the page.');
  if (product.status === 'live' && !rows.some((r) => r.input.active)) return fail('invalid', 'A product on the website needs at least one pack switched on. Pause the product instead.', { field: 'packs' });

  // what changed
  const changes: { row: (typeof rows)[number]; cur: V }[] = [];
  for (const r of rows) {
    if (!r.input.id) continue;
    const c = current.get(r.input.id)!;
    if (r.input.version !== c.version) return fail('conflict', 'Someone else changed these packs meanwhile. Reload the page.', { field: packField(r.input) });
    const same = c.label === r.label && c.net_grams === r.netGrams && c.pool_id === r.input.poolId && c.pool_qty === r.poolQty
      && c.price_paise === r.price && c.mrp_paise === r.mrp && (c.active === 1) === r.input.active && (c.gift_ok === 1) === r.input.giftOk;
    if (!same) changes.push({ row: r, cur: c });
  }
  const news = rows.filter((r) => !r.input.id);
  if (!changes.length && !news.length) return ok({ changed: 0, added: 0, priceChanges: [], effects: { publish: null, live: false } });

  const by = actor.email;
  const guards = multiRowGuards('variants', changes.map((c) => ({ id: c.cur.id, version: c.cur.version })), at, by);
  const statements: D1Statement[] = [];
  changes.forEach((c, k) => {
    statements.push(stmt(db, `UPDATE variants SET label = ?, net_grams = ?, pool_id = ?, pool_qty = ?, price_paise = ?, mrp_paise = ?, active = ?, gift_ok = ?,
        version = version + 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND version = ? AND ${guards.before(k).sql}`,
    c.row.label, c.row.netGrams, c.row.input.poolId, c.row.poolQty, c.row.price, c.row.mrp, c.row.input.active ? 1 : 0, c.row.input.giftOk ? 1 : 0,
    at, by, c.cur.id, c.cur.version, ...guards.before(k).params));
  });
  const done = changes.length ? guards.after : null;
  const priceChanges = changes.filter((c) => c.cur.price_paise !== c.row.price || c.cur.mrp_paise !== c.row.mrp)
    .map((c) => ({ variantId: c.cur.id, label: c.row.label, oldPrice: c.cur.price_paise, newPrice: c.row.price, oldMrp: c.cur.mrp_paise, newMrp: c.row.mrp }));
  for (const pc of priceChanges) {
    statements.push(stmt(db, `INSERT INTO price_history (variant_id, old_price_paise, new_price_paise, old_mrp_paise, new_mrp_paise, reason, at, by)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${done!.sql}`, pc.variantId, pc.oldPrice, pc.newPrice, pc.oldMrp, pc.newMrp, (input.reason ?? 'Product editor').slice(0, 120), at, by, ...done!.params));
  }
  // new packs: code '<slug>:<suffix>', after the existing ones
  let sort = Math.max(0, ...[...current.values()].map((v) => v.sort));
  const newCodes: string[] = [];
  for (const r of news) {
    const base = `${product.slug}:${packSuffix(r.label)}`;
    let code = base;
    for (let n = 2; allCodes.has(code) || newCodes.includes(code); n++) code = `${base}-${n}`;
    newCodes.push(code);
    sort += 1;
    statements.push(stmt(db, `INSERT INTO variants (product_id, code, label, sort, net_grams, pool_id, pool_qty, price_paise, mrp_paise, active, gift_ok, version, updated_at, updated_by)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?${done ? ` WHERE ${done.sql}` : ''}`,
    product.id, code, r.label, sort, r.netGrams, r.input.poolId, r.poolQty, r.price, r.mrp, r.input.active ? 1 : 0, r.input.giftOk ? 1 : 0, at, by, ...(done?.params ?? [])));
    if (r.price !== null) {
      statements.push(stmt(db, `INSERT INTO price_history (variant_id, old_price_paise, new_price_paise, old_mrp_paise, new_mrp_paise, reason, at, by)
        SELECT id, NULL, ?, NULL, ?, 'New pack', ?, ? FROM variants WHERE code = ?`, r.price, r.mrp, at, by, code));
    }
  }
  const onSite = product.status !== 'draft';
  const live = product.status === 'live' || product.status === 'paused';
  if (live) statements.push(bumpVersionStmt(db, 'live_version', at, by, done ?? undefined));
  if (onSite) statements.push(bumpVersionStmt(db, 'site_version', at, by, done ?? undefined));
  const words = [
    ...changes.map((c) => {
      const bits: string[] = [];
      if (c.cur.label !== c.row.label) bits.push(`renamed ${c.cur.label} → ${c.row.label}`);
      if (c.cur.price_paise !== c.row.price) bits.push(`price ${money(c.cur.price_paise)} → ${money(c.row.price)}`);
      if (c.cur.mrp_paise !== c.row.mrp) bits.push(`MRP ${money(c.cur.mrp_paise)} → ${money(c.row.mrp)}`);
      if ((c.cur.active === 1) !== c.row.input.active) bits.push(c.row.input.active ? 'switched on' : 'switched off');
      if ((c.cur.gift_ok === 1) !== c.row.input.giftOk) bits.push(c.row.input.giftOk ? 'gift box OK' : 'not for gift boxes');
      if (c.cur.net_grams !== c.row.netGrams || c.cur.pool_id !== c.row.input.poolId || c.cur.pool_qty !== c.row.poolQty) bits.push('stock use changed');
      return `${c.row.label} ${bits.join(', ')}`;
    }),
    ...news.map((r) => `new pack ${r.label}${r.price !== null ? ` at ${money(r.price)}` : ''}`),
  ];
  statements.push(auditInsert(db, {
    at, actor, action: 'product.packs', entity: 'product', entityId: product.id,
    summary: clip(`${product.name}: ${words.join('; ')}`, 500),
    before: Object.fromEntries(changes.map((c) => [c.cur.id, { label: c.cur.label, price: c.cur.price_paise, mrp: c.cur.mrp_paise, active: c.cur.active === 1 }])),
    after: { ...Object.fromEntries(changes.map((c) => [c.cur.id, { label: c.row.label, price: c.row.price, mrp: c.row.mrp, active: c.row.input.active }])), added: newCodes },
  }, done ?? undefined));

  const res = await tryBatch(db, statements, { unique: 'Two packs would get the same name or code. Reload the page and try again.' });
  if (!res.ok) return res;
  if (changes.length && res.value[0].meta.changes !== 1) return fail('conflict', 'Someone else changed these packs meanwhile. Reload the page.');
  return ok({ changed: changes.length, added: news.length, priceChanges, effects: { publish: onSite ? 'now' : null, live } });
}

const money = (p: number | null) => (p === null ? 'Price on WhatsApp' : formatINR(p));

/**
 * "Add stock pool": a new pool for a product (e.g. a new candle size). Honey products have one gram pool;
 * pools in pieces may be added freely. Tracking starts off (first count switches it on).
 */
export async function addPool(db: D1, actor: Actor, input: { productId: number; name: string; unit: PoolUnit }, at: string = nowIso()): Promise<Result<{ poolId: number; code: string }>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const product = await first<{ id: number; slug: string; name: string }>(db, 'SELECT id, slug, name FROM products WHERE id = ?', input?.productId);
  if (!product) return fail('not_found', 'This product does not exist.');
  if (input.unit !== 'g' && input.unit !== 'piece') return bad('pool_unit', 'Choose kg (honey) or pieces.');
  const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
  if (len(name) < 2 || len(name) > 80) return bad('pool_name', 'Give the stock a name of 2–80 characters, like Beeswax Candles, Large.');
  const pools = await all<{ code: string; unit: PoolUnit; sort: number; name: string }>(db, 'SELECT code, unit, sort, name FROM stock_pools WHERE product_id = ?', product.id);
  if (pools.some((p) => p.name.toLowerCase() === name.toLowerCase())) return bad('pool_name', 'This product already has stock with that name.');
  if (input.unit === 'g' && pools.some((p) => p.unit === 'g')) return bad('pool_unit', 'A honey has one stock in kg. Use it for every jar size.');
  const allCodes = new Set((await all<{ code: string }>(db, 'SELECT code FROM stock_pools')).map((r) => r.code));
  let code = pools.length === 0 && !allCodes.has(product.slug) ? product.slug : `${product.slug}:${packSuffix(name.replace(new RegExp(`^${product.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ ,]*`, 'i'), '')) || 'stock'}`;
  for (let n = 2; allCodes.has(code); n++) code = `${code.replace(/-\d+$/, '')}-${n}`;
  const lowDefault = await first<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'alerts'");
  const low = (() => { try { return (JSON.parse(lowDefault?.value ?? 'null') as { lowDefault: { g: number; piece: number } }).lowDefault[input.unit]; } catch { return input.unit === 'g' ? 2000 : 5; } })();
  const by = actor.email;
  const res = await tryBatch(db, [
    stmt(db, `INSERT INTO stock_pools (product_id, code, name, unit, sort, track_stock, on_hand, low_at, availability, tracking_since, version, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'auto', NULL, 1, ?, ?)`, product.id, code, name, input.unit, Math.max(-1, ...pools.map((p) => p.sort)) + 1, low ?? null, at, by),
    stmt(db, `INSERT INTO audit_log (at, actor, action, entity, entity_id, summary)
      SELECT ?, ?, 'stock.pool_add', 'pool', CAST(id AS TEXT), ? FROM stock_pools WHERE code = ?`, at, by, `New stock for ${product.name}: ${name} (${input.unit === 'g' ? 'kg' : 'pieces'})`, code),
    stmt(db, 'SELECT id FROM stock_pools WHERE code = ?', code),
  ], { unique: 'This stock already exists. Reload the page.' });
  if (!res.ok) return res;
  return ok({ poolId: (res.value[2].results[0] as { id: number }).id, code });
}

// ───────────────────────────── new product and copies ─────────────────────────────

export interface NewProductInput {
  name: string;
  category: string;
  /** copy texts, photos, packs (with prices) and the stock layout from this product */
  copyFromId?: number | null;
  /** the form's key: a double tap makes one product */
  idemKey?: string | null;
}

/**
 * "New product" / "Copy from an existing product": a draft with a suggested slug and short code.
 * A blank honey gets one stock in kg and packs 100 g, 250 g and 500 g (no prices yet); a blank product from the hive
 * gets one stock in pieces and no packs. A copy repeats the source's texts, photos, gallery, packs and prices,
 * with new (empty, untracked) stock of the same shape. Returns { id, duplicate }.
 */
export async function createProduct(db: D1, actor: Actor, input: NewProductInput, at: string = nowIso()): Promise<Result<{ id: number; slug: string; duplicate: boolean }>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const name = (input?.name ?? '').trim().replace(/\s+/g, ' ');
  if (len(name) < 2 || len(name) > LIMITS.name) return bad('name', `The name needs 2–${LIMITS.name} characters.`);
  const key = input.idemKey && /^[0-9a-f-]{36}$/.test(input.idemKey) ? input.idemKey : null;
  const since = `${new Date(Date.parse(at) - 3_600_000).toISOString().slice(0, 19)}Z`;
  if (key) {
    const dup = await first<{ entity_id: string }>(db, `SELECT entity_id FROM audit_log WHERE at >= ? AND action = 'product.create'
      AND json_extract(after_json, '$.key') = ? LIMIT 1`, since, key);
    if (dup) {
      const p = await first<{ id: number; slug: string }>(db, 'SELECT id, slug FROM products WHERE id = ?', Number(dup.entity_id));
      if (p) return ok({ id: p.id, slug: p.slug, duplicate: true });
    }
  }
  let src: ProductRow | null = null;
  if (input.copyFromId) {
    src = await first<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', input.copyFromId);
    if (!src) return bad('copy_from', 'The product to copy no longer exists.');
  }
  const category = input.category || src?.category || '';
  if (!CATEGORY_IDS.includes(category as CategoryId)) return bad('category', 'Choose a shop section.');
  const cat = await first<{ is_honey: number }>(db, 'SELECT is_honey FROM categories WHERE id = ?', category);
  if (!cat) return bad('category', 'Choose a shop section.');
  const slug = await suggestSlug(db, name);
  const shortCode = await suggestShortCode(db, name);
  const sortRow = await first<{ s: number }>(db, 'SELECT COALESCE(MAX(sort), 0) AS s FROM products');
  const by = actor.email;
  const idOf = '(SELECT id FROM products WHERE slug = ?)';
  const statements: D1Statement[] = [];
  const notDup = key ? { sql: `NOT EXISTS (SELECT 1 FROM audit_log WHERE at >= ? AND action = 'product.create' AND json_extract(after_json, '$.key') = ?)`, params: [since, key] } : null;

  if (src) {
    statements.push(stmt(db, `INSERT INTO products (slug, short_code, status, sort, name, category, kind, badge, with_comb, tagline, tone, photo, card_photo,
        specs_json, colour_min, colour_max, about, love_json, use_head, use_text, store_text, finder_json, bloom_json, bloom_note, in_gift_box,
        first_live_at, version, created_at, updated_at, updated_by)
      SELECT ?, ?, 'draft', ?, ?, ?, kind, badge, with_comb, tagline, tone, photo, card_photo, specs_json, colour_min, colour_max, about, love_json,
        use_head, use_text, store_text, finder_json, bloom_json, bloom_note, in_gift_box, NULL, 1, ?, ?, ?
      FROM products WHERE id = ?${notDup ? ` AND ${notDup.sql}` : ''}`, slug, shortCode, (sortRow?.s ?? 0) + 1, name, category, at, at, by, src.id, ...(notDup?.params ?? [])));
    statements.push(stmt(db, `INSERT INTO product_images (product_id, image, caption, sort)
      SELECT ${idOf}, image, caption, sort FROM product_images WHERE product_id = ? AND EXISTS ${idOf.replace('SELECT id', 'SELECT 1')}`, slug, src.id, slug));
    const srcPools = await all<{ id: number; code: string; name: string; unit: PoolUnit; sort: number; low_at: number | null }>(db,
      'SELECT id, code, name, unit, sort, low_at FROM stock_pools WHERE product_id = ? ORDER BY sort, id', src.id);
    const taken = new Set((await all<{ code: string }>(db, 'SELECT code FROM stock_pools')).map((r) => r.code));
    const poolCode = new Map<number, string>();
    for (const sp of srcPools) {
      const suffix = sp.code.includes(':') ? sp.code.slice(sp.code.indexOf(':')) : '';
      let code = `${slug}${suffix}`;
      for (let n = 2; taken.has(code); n++) code = `${slug}${suffix}-${n}`;
      taken.add(code);
      poolCode.set(sp.id, code);
      const poolName = sp.name.toLowerCase().startsWith(src.name.toLowerCase()) ? `${name}${sp.name.slice(src.name.length)}` : sp.name;
      statements.push(stmt(db, `INSERT INTO stock_pools (product_id, code, name, unit, sort, track_stock, on_hand, low_at, availability, tracking_since, version, updated_at, updated_by)
        SELECT id, ?, ?, ?, ?, 0, 0, ?, 'auto', NULL, 1, ?, ? FROM products WHERE slug = ?`, code, poolName.slice(0, 80), sp.unit, sp.sort, sp.low_at, at, by, slug));
    }
    const srcPacks = await all<{ code: string; label: string; sort: number; net_grams: number | null; pool_id: number; pool_qty: number; price_paise: number | null; mrp_paise: number | null; active: number; gift_ok: number }>(db,
      'SELECT code, label, sort, net_grams, pool_id, pool_qty, price_paise, mrp_paise, active, gift_ok FROM variants WHERE product_id = ? ORDER BY sort, id', src.id);
    const vTaken = new Set((await all<{ code: string }>(db, 'SELECT code FROM variants')).map((r) => r.code));
    for (const v of srcPacks) {
      let code = `${slug}${v.code.slice(v.code.indexOf(':'))}`;
      for (let n = 2; vTaken.has(code); n++) code = `${slug}${v.code.slice(v.code.indexOf(':'))}-${n}`;
      vTaken.add(code);
      statements.push(stmt(db, `INSERT INTO variants (product_id, code, label, sort, net_grams, pool_id, pool_qty, price_paise, mrp_paise, active, gift_ok, version, updated_at, updated_by)
        SELECT p.id, ?, ?, ?, ?, s.id, ?, ?, ?, ?, ?, 1, ?, ? FROM products p JOIN stock_pools s ON s.product_id = p.id AND s.code = ? WHERE p.slug = ?`,
      code, v.label, v.sort, v.net_grams, v.pool_qty, v.price_paise, v.mrp_paise, v.active, v.gift_ok, at, by, poolCode.get(v.pool_id), slug));
    }
  } else {
    statements.push(stmt(db, `INSERT INTO products (slug, short_code, status, sort, name, category, kind, badge, with_comb, tagline, tone, photo, card_photo,
        specs_json, colour_min, colour_max, about, love_json, use_head, use_text, store_text, finder_json, bloom_json, bloom_note, in_gift_box,
        first_live_at, version, created_at, updated_at, updated_by)
      SELECT ?, ?, 'draft', ?, ?, ?, ?, ?, ?, '', '#F4EBD6', NULL, NULL, '[]', NULL, NULL, '', '[]', NULL, '', ?, NULL, NULL, NULL, 0, NULL, 1, ?, ?, ?
      ${notDup ? `WHERE ${notDup.sql}` : ''}`, slug, shortCode, (sortRow?.s ?? 0) + 1, name, category,
    cat.is_honey ? 'Monofloral' : '', cat.is_honey && category === 'comb-honey' ? 'With honeycomb' : '', category === 'comb-honey' ? 1 : 0,
    cat.is_honey ? 'Store at room temperature with the lid closed. Always use a dry spoon.' : '', at, at, by, ...(notDup?.params ?? [])));
    const low = cat.is_honey ? 2000 : 5;
    statements.push(stmt(db, `INSERT INTO stock_pools (product_id, code, name, unit, sort, track_stock, on_hand, low_at, availability, tracking_since, version, updated_at, updated_by)
      SELECT id, ?, ?, ?, 0, 0, 0, ?, 'auto', NULL, 1, ?, ? FROM products WHERE slug = ?`, slug, name, cat.is_honey ? 'g' : 'piece', low, at, by, slug));
    if (cat.is_honey) {
      for (const [k, g] of [100, 250, 500].entries()) {
        statements.push(stmt(db, `INSERT INTO variants (product_id, code, label, sort, net_grams, pool_id, pool_qty, price_paise, mrp_paise, active, gift_ok, version, updated_at, updated_by)
          SELECT p.id, ?, ?, ?, ?, s.id, ?, NULL, NULL, 1, ?, 1, ?, ? FROM products p JOIN stock_pools s ON s.product_id = p.id AND s.code = ? WHERE p.slug = ?`,
        `${slug}:${g}g`, `${g} g`, k + 1, g, g, g <= 250 ? 1 : 0, at, by, slug, slug));
      }
    }
  }
  statements.push(stmt(db, `INSERT INTO audit_log (at, actor, action, entity, entity_id, summary, after_json)
    SELECT ?, ?, 'product.create', 'product', CAST(id AS TEXT), ?, ? FROM products WHERE slug = ? AND created_at = ? AND updated_by = ?`,
  at, by, src ? `New product ${name} (copy of ${src.name}), draft` : `New product ${name}, draft`, JSON.stringify({ slug, shortCode, copyOf: src?.id ?? null, key }), slug, at, by));
  statements.push(stmt(db, 'SELECT id FROM products WHERE slug = ?', slug));
  const res = await tryBatch(db, statements, { unique: 'A product with this web address already exists. Try again.' });
  if (!res.ok) return res;
  const row = res.value[res.value.length - 1].results[0] as { id: number } | undefined;
  if (!row) {
    // the key was used meanwhile (double tap): return that product
    if (key) {
      const dup = await first<{ entity_id: string }>(db, `SELECT entity_id FROM audit_log WHERE at >= ? AND action = 'product.create' AND json_extract(after_json, '$.key') = ? LIMIT 1`, since, key);
      const p = dup ? await first<{ id: number; slug: string }>(db, 'SELECT id, slug FROM products WHERE id = ?', Number(dup.entity_id)) : null;
      if (p) return ok({ id: p.id, slug: p.slug, duplicate: true });
    }
    return fail('conflict', 'The product could not be made. Reload the page and try again.');
  }
  return ok({ id: row.id, slug, duplicate: false });
}

// ───────────────────────────── status and order ─────────────────────────────

export type StatusAction = 'go_live' | 'pause' | 'retire';
const STATUS_FROM: Record<StatusAction, ProductStatus[]> = { go_live: ['draft', 'paused', 'retired'], pause: ['live'], retire: ['live', 'paused'] };
const STATUS_TO: Record<StatusAction, ProductStatus> = { go_live: 'live', pause: 'paused', retire: 'retired' };
const STATUS_WORDS: Record<StatusAction, string> = { go_live: 'is on the website', pause: 'paused', retire: 'retired' };

/**
 * "Show on website" (go_live), "Pause", "Retire". Going live needs a main photo, at least one gallery photo with
 * captions, the texts the website shows, and at least one active pack; the first time it also freezes the slug
 * (first_live_at). Photos become public. Every change bumps site_version and live_version (publish 'now').
 */
export async function setProductStatus(db: D1, actor: Actor, input: { id: number; version: number; action: StatusAction }, at: string = nowIso()): Promise<Result<{ version: number; status: ProductStatus; effects: Effects }>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  if (!(input?.action in STATUS_TO)) return fail('invalid', 'Unknown action.');
  const p = await first<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', input.id);
  if (!p) return fail('not_found', 'This product does not exist.');
  if (input.version !== p.version) return fail('conflict', 'Someone else saved this product meanwhile. Reload the page.');
  const to = STATUS_TO[input.action];
  if (p.status === to) return fail('conflict', `${p.name} ${STATUS_WORDS[input.action]} already.`);
  if (!STATUS_FROM[input.action].includes(p.status)) return fail('not_allowed', input.action === 'retire' ? 'A draft has never been on the website, so there is nothing to retire.' : 'This change is not possible now.');
  const gallery = await all<{ image: string; caption: string }>(db, 'SELECT image, caption FROM product_images WHERE product_id = ? ORDER BY sort, id', p.id);
  const activePacks = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM variants WHERE product_id = ? AND active = 1', p.id))?.n ?? 0;
  if (to !== 'draft') {
    const gap = websiteGaps({ photo: p.photo, kind: p.kind, badge: p.badge, tagline: p.tagline, about: p.about, use: p.use_text, store: p.store_text, gallery: gallery.map((g) => ({ caption: g.caption })) }, to === 'live' ? activePacks : Math.max(1, activePacks));
    if (gap) return fail('invalid', `${gap.message.replace(/ first\.$/, '')} before it can go on the website.`, { field: gap.field });
  }
  const by = actor.email;
  const guard = productGuard(p.id, p.version + 1, at, by);
  const paths = [p.photo, p.card_photo, ...gallery.map((g) => g.image)].filter((x): x is string => !!x);
  const statements: D1Statement[] = [
    versionedUpdate(db, { table: 'products', key: ['id', p.id], version: p.version, actor, at,
      set: { status: to, ...(to === 'live' && p.first_live_at === null ? { first_live_at: at } : {}) },
      guard: { sql: 'status = ?', params: [p.status] } }),
    publicImagesStmt(db, paths, guard),
    bumpVersionStmt(db, 'site_version', at, by, guard),
    bumpVersionStmt(db, 'live_version', at, by, guard),
    auditInsert(db, { at, actor, action: `product.${to}`, entity: 'product', entityId: p.id,
      summary: `${p.name} ${STATUS_WORDS[input.action]}${to === 'live' && p.first_live_at === null ? ' for the first time (web address /shop/' + p.slug + '/ is now fixed)' : ''}`,
      before: { status: p.status }, after: { status: to } }, guard),
  ];
  const res = await tryBatch(db, statements);
  if (!res.ok) return { ...res, message: 'Something the website needs is missing. Check the product and try again.' };
  if (res.value[0].meta.changes !== 1) return fail('conflict', 'Someone else saved this product meanwhile. Reload the page.');
  return ok({ version: p.version + 1, status: to, effects: { publish: 'now', live: true } });
}

/**
 * Up / down arrow on the Products list: moves a product one place in the shop order and numbers every product
 * 1…n. One guarded statement (it changes nothing if the order changed meanwhile). Publishes only when the order
 * of the products on the website changed.
 */
export async function moveProduct(db: D1, actor: Actor, input: { id: number; direction: 'up' | 'down' }, at: string = nowIso()): Promise<Result<{ effects: Effects }>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  if (input?.direction !== 'up' && input?.direction !== 'down') return fail('invalid', 'Choose up or down.');
  const rows = await all<{ id: number; name: string; status: ProductStatus; sort: number }>(db, 'SELECT id, name, status, sort FROM products ORDER BY sort, slug');
  const i = rows.findIndex((r) => r.id === input.id);
  if (i < 0) return fail('not_found', 'This product does not exist.');
  const j = input.direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= rows.length) return fail('not_allowed', input.direction === 'up' ? 'This product is already first.' : 'This product is already last.');
  const order = rows.map((r) => r.id);
  [order[i], order[j]] = [order[j], order[i]];
  const onSite = (ids: number[]) => ids.filter((id) => rows.find((r) => r.id === id)!.status !== 'draft').join(',');
  const publicChanged = onSite(rows.map((r) => r.id)) !== onSite(order);
  const by = actor.email;
  const expected = rows.map((r) => `${r.id}:${r.sort}`).join(',');
  const guard: Guard = { sql: "(SELECT group_concat(x, ',') FROM (SELECT id || ':' || sort AS x FROM products ORDER BY sort, slug)) = ?", params: [expected] };
  const after: Guard = { sql: "(SELECT group_concat(x, ',') FROM (SELECT id || ':' || sort AS x FROM products ORDER BY sort, slug)) = ?", params: [order.map((id, k) => `${id}:${k + 1}`).join(',')] };
  const statements: D1Statement[] = [
    stmt(db, `UPDATE products SET sort = (SELECT j.key + 1 FROM json_each(?) j WHERE j.value = products.id), updated_at = ?, updated_by = ?
      WHERE ${guard.sql}`, JSON.stringify(order), at, by, ...guard.params),
    ...(publicChanged ? [bumpVersionStmt(db, 'site_version', at, by, after)] : []),
    auditInsert(db, { at, actor, action: 'product.order', entity: 'product', entityId: rows[i].id,
      summary: `Shop order: ${rows[i].name} moved ${input.direction} (now before/after ${rows[j].name})` }, after),
  ];
  const res = await tryBatch(db, statements);
  if (!res.ok) return res;
  if (res.value[0].meta.changes === 0) return fail('conflict', 'The order changed meanwhile. Reload the page.');
  return ok({ effects: { publish: publicChanged ? 'now' : null, live: false } });
}

// ───────────────────────────── misc reads for screens ─────────────────────────────

/**
 * Suggested batch codes '<SHORT>-<YYMM>-<NN>' for many products at once (same rule as stock.ts suggestBatchCode,
 * but one read batch instead of two queries per product: the Add harvest form lists every honey).
 */
export async function suggestBatchCodes(db: D1, productIds: number[], date: string): Promise<Map<number, string>> {
  const [pRes, bRes] = await db.batch([
    stmt(db, 'SELECT id, short_code FROM products WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(productIds)),
    stmt(db, 'SELECT code_key FROM batches'),
  ]);
  const keys = (bRes.results as { code_key: string }[]).map((r) => r.code_key);
  const yymm = `${date.slice(2, 4)}${date.slice(5, 7)}`;
  const out = new Map<number, string>();
  for (const p of pRes.results as { id: number; short_code: string }[]) {
    const prefix = `${p.short_code}${yymm}`;
    let max = 0;
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      const n = Number(k.slice(prefix.length));
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
    out.set(p.id, `${p.short_code}-${yymm}-${String(max + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Batch-code key for a typed code (re-exported for screens) */
export { batchKey };
