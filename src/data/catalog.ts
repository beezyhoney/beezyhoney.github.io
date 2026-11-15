// Loads the catalog (see catalog.types.ts) and turns it into the data the pages use.
//
// Source: src/data/generated/catalog.json when it exists (written by scripts/sync-catalog.mjs, which
// `npm run build` and `npm run dev` run first; gitignored), otherwise the committed src/data/catalog.snapshot.json.
// The catalog is validated on load, so a bad catalog stops the build with a clear message.
//
// products.ts, features.ts and batches.ts re-export what they used to define from here, so existing
// imports keep working.
import type { Catalog, CatalogBatch, CatalogCategory, CatalogProduct, CatalogVariant, CatalogPool, CatalogSettings, CategoryId, FinderProfile, BloomMonths, Avail } from './catalog.types';
import type { Product, ProductVariant } from './products';
import type { Batch } from './batches';
import { assertCatalog } from './catalog.validate.mjs';
import snapshot from './catalog.snapshot.json';

const GENERATED = './generated/catalog.json';
const generated = import.meta.glob<Catalog>('./generated/catalog.json', { eager: true, import: 'default' });

/** Which file the catalog came from */
export const CATALOG_SOURCE: 'generated' | 'snapshot' = generated[GENERATED] ? 'generated' : 'snapshot';

/** One shop section, as the pages use it */
export interface Category { id: CategoryId; name: string; title: string; intro: string; image: string }

/** A pack's price and availability, for price slots and the order message */
export interface PriceEntry {
  /** variant code, e.g. 'murungai-honey:250g' */
  code: string;
  /** price in paise, or null for "Price on WhatsApp" */
  pricePaise: number | null;
  /** MRP in paise when higher than the price, else null */
  mrpPaise: number | null;
  avail: Avail;
}

/** Everything the site derives from one catalog */
export interface CatalogData {
  /** live products in shop order: listings, carousel, finder, gift box, bloom calendar */
  PRODUCTS: Product[];
  /** live and paused products: the products that have a page */
  PRODUCT_PAGES: Product[];
  /** live, paused and retired products: Know Your Jar, cart thumbnails, name look-ups */
  ALL_PRODUCTS: Product[];
  CATEGORIES: Category[];
  /** Honey Finder profile per product slug */
  FINDER_PROFILES: Record<string, FinderProfile>;
  /** flowering months per product slug */
  BLOOM: Record<string, BloomMonths>;
  /** honeys whose bloom is not every year */
  BLOOM_NOTE: Record<string, string>;
  /** slug → pack label → price and availability, for products that have a page; active packs only */
  PRICE_TABLE: Record<string, Record<string, PriceEntry>>;
  /** public website settings (show prices, stock display, delivery note, offer, gift box) */
  SETTINGS: CatalogSettings;
  /** stock pools (identity only, never counts) */
  POOLS: CatalogPool[];
  /** public batches for Know Your Jar, newest first */
  BATCHES: Batch[];
  SITE_VERSION: number;
  LIVE_VERSION: number;
}

const bySortThen = <T extends { sort: number }>(key: (x: T) => string) => (a: T, b: T) =>
  a.sort - b.sort || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** Product in the shape (and key order) products.ts always had, plus status, shortCode and active packs */
function toProduct(p: CatalogProduct, packs: CatalogVariant[]): Product {
  const variants: ProductVariant[] = packs.map((v) => ({
    code: v.code, label: v.label, netGrams: v.netGrams, pricePaise: v.pricePaise, mrpPaise: v.mrpPaise, giftOk: v.giftOk, avail: v.avail,
  }));
  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    kind: p.kind,
    badge: p.badge,
    withComb: p.withComb,
    tagline: p.tagline,
    tone: p.tone,
    photo: p.photo,
    ...(p.card !== null ? { card: p.card } : {}),
    gallery: p.gallery.map((g) => ({ src: g.src, caption: g.caption })),
    specs: p.specs.map(([k, v]): [string, string] => [k, v]),
    ...(p.colour !== null ? { colour: [p.colour[0], p.colour[1]] as [number, number] } : {}),
    about: p.about,
    love: [...p.love],
    ...(p.useHead !== null ? { useHead: p.useHead } : {}),
    use: p.use,
    packs: packs.map((v) => v.label),
    store: p.store,
    status: p.status,
    shortCode: p.shortCode,
    variants,
  };
}

const toBatch = (b: CatalogBatch): Batch => ({
  code: b.code, product: b.productSlug, harvested: b.harvested, packed: b.packed, bestBefore: b.bestBefore,
  ...(b.note !== null ? { note: b.note } : {}),
});

/** Derives every export from a catalog. Pure, so tests can run it on any catalog. */
export function catalogData(raw: unknown, source = 'catalog'): CatalogData {
  const c = assertCatalog(raw, source) as Catalog;
  const products = [...c.products].sort(bySortThen<CatalogProduct>((p) => p.slug));
  const packsOf = new Map<string, CatalogVariant[]>(products.map((p) => [p.slug, []]));
  for (const v of [...c.variants].sort(bySortThen<CatalogVariant>((x) => x.code))) packsOf.get(v.productSlug)!.push(v);
  const active = (slug: string) => packsOf.get(slug)!.filter((v) => v.active);

  const all = products.map((p) => toProduct(p, active(p.slug)));
  const pages = all.filter((p) => p.status === 'live' || p.status === 'paused');

  const FINDER_PROFILES: Record<string, FinderProfile> = {};
  const BLOOM: Record<string, BloomMonths> = {};
  const BLOOM_NOTE: Record<string, string> = {};
  for (const p of products) {
    if (p.finder) FINDER_PROFILES[p.slug] = { taste: [...p.finder.taste], uses: [...p.finder.uses], ...(p.finder.rare ? { rare: true } : {}) };
    if (p.bloom !== null) BLOOM[p.slug] = p.bloom === 'all' ? 'all' : [...p.bloom];
    if (p.bloomNote !== null) BLOOM_NOTE[p.slug] = p.bloomNote;
  }

  const PRICE_TABLE: Record<string, Record<string, PriceEntry>> = {};
  for (const p of pages) {
    PRICE_TABLE[p.slug] = Object.fromEntries(p.variants.map((v) => [v.label, { code: v.code, pricePaise: v.pricePaise, mrpPaise: v.mrpPaise, avail: v.avail }]));
  }

  return {
    PRODUCTS: all.filter((p) => p.status === 'live'),
    PRODUCT_PAGES: pages,
    ALL_PRODUCTS: all,
    CATEGORIES: [...c.categories].sort(bySortThen<CatalogCategory>((x) => x.id)).map(({ id, name, title, intro, image }) => ({ id, name, title, intro, image })),
    FINDER_PROFILES,
    BLOOM,
    BLOOM_NOTE,
    PRICE_TABLE,
    SETTINGS: structuredClone(c.settings),
    POOLS: c.pools.map((p) => ({ ...p })),
    BATCHES: c.batches.map(toBatch),
    SITE_VERSION: c.siteVersion,
    LIVE_VERSION: c.liveVersion,
  };
}

const data = catalogData(
  generated[GENERATED] ?? snapshot,
  CATALOG_SOURCE === 'generated' ? 'src/data/generated/catalog.json' : 'src/data/catalog.snapshot.json',
);

export const {
  PRODUCTS, PRODUCT_PAGES, ALL_PRODUCTS, CATEGORIES, FINDER_PROFILES, BLOOM, BLOOM_NOTE,
  PRICE_TABLE, SETTINGS, POOLS, BATCHES, SITE_VERSION, LIVE_VERSION,
} = data;
