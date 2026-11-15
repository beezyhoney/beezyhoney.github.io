// The catalog format: everything the public website is built from.
//
// This is exactly what the future public endpoint GET /api/catalog.json returns, what the committed
// src/data/catalog.snapshot.json holds, and what scripts/sync-catalog.mjs writes to
// src/data/generated/catalog.json for the build. src/data/catalog.ts loads it.
//
// Rules (checked by src/data/catalog.validate.mjs, which every build runs):
// - Only public data. Never stock counts (on hand, low-stock levels, tracking), customer data, orders,
//   private notes or admin emails. Every object is whitelisted: an unknown field fails the build.
// - Never draft products. Live, paused and retired products only.
// - Money is integer paise (₹310 = 31000). null = no price yet ("Price on WhatsApp").
// - Keys are camelCase. A missing optional value is null, never left out.
// - Lists are already in display order (sorted by `sort`), so the site does not need to re-sort,
//   but catalog.ts sorts again to be safe.

/** Version of this format. Bump it on any breaking change; the build refuses formats it does not know. */
export const CATALOG_FORMAT = 1;

/** The four shop sections. Fixed: adding one needs a code change (the D1 schema has the same CHECK). */
export type CategoryId = 'comb-honey' | 'blossom-honey' | 'wild-rare' | 'from-the-hive';

/** Honey Finder quiz answers a honey can match (see FINDER_QUESTIONS in features.ts). */
export type Taste = 'mild' | 'floral' | 'rich' | 'herbal';
export type Use = 'daily' | 'kids' | 'remedy' | 'gift' | 'onthego';

/**
 * Where a product shows on the site. Drafts never reach the catalog.
 * - live: listed everywhere (shop, carousel, finder, gift box) and has a product page.
 * - paused: not listed, but its product page stays (shown as not available) and old links work.
 * - retired: no product page; kept so old carts, batch lookups and name look-ups still resolve.
 */
export type ProductStatus = 'live' | 'paused' | 'retired';

/**
 * Availability of one pack, worked out on the server from its stock pool (amendment A3):
 * manual override wins; else tracking off → 'in'; on hand < pool quantity → 'out';
 * on hand ≤ low-stock level → 'low'; else 'in'. Counts are never published.
 */
export type Avail = 'in' | 'low' | 'out';

/** Unit a stock pool is counted in: grams for honey (shown to the owner as kg), pieces for candles and sticks. */
export type PoolUnit = 'g' | 'piece';

/** How stock shows on the site: only "Sold out", or also "Only a few left" for 'low'. */
export type StockDisplay = 'sold_out' | 'low_and_sold_out';

/** A Honey Finder profile: how a honey answers the quiz. First taste and first use count a little more. */
export interface FinderProfile {
  /** tastes this honey matches, strongest first */
  taste: Taste[];
  /** uses this honey suits, strongest first */
  uses: Use[];
  /** present and true only for rare, small-harvest honeys */
  rare?: boolean;
}

/** Flowering months, 1–12 (in season order, e.g. [12, 1, 2]), or 'all' for "most of the year". */
export type BloomMonths = number[] | 'all';

export interface CatalogCategory {
  /** fixed id, also the #anchor on /shop/ */
  id: CategoryId;
  /** short name, e.g. on the product page side label */
  name: string;
  /** section heading on /shop/ */
  title: string;
  /** section intro text on /shop/ (at most 600 characters) */
  intro: string;
  /** section photo: path relative to src/assets/img, e.g. 'cat-comb.jpg' or 'uploads/01JD….jpg' */
  image: string;
  /** true for the three honey sections; false for 'from-the-hive' (candles, sticks) */
  isHoney: boolean;
  /** display order of the sections, ascending */
  sort: number;
}

export interface CatalogProduct {
  /** URL slug: /shop/<slug>/. Lower-case letters, digits and hyphens. Frozen once the product first goes live. */
  slug: string;
  /** 2–4 capital letters, unique; starts batch codes, e.g. 'MUR' in MUR-2611-01 */
  shortCode: string;
  /** live, paused or retired (never draft) */
  status: ProductStatus;
  /** shop and carousel order, ascending (ties broken by slug) */
  sort: number;
  /** display name, e.g. 'Murungai Honey' */
  name: string;
  /** shop section */
  category: CategoryId;
  /** small label under the name, e.g. 'Monofloral' */
  kind: string;
  /** badge text on the product page, e.g. 'With honeycomb' */
  badge: string;
  /** true when every box has a piece of comb; the full name then gets ' with comb' */
  withComb: boolean;
  /** one-line description on cards and the product page */
  tagline: string;
  /** background tint for the product, '#RRGGBB' */
  tone: string;
  /** main photo (product hero, home carousel): path relative to src/assets/img */
  photo: string;
  /** shop card photo, or null to use `photo` */
  card: string | null;
  /** photo slider on the product page; the first caption is also the main photo's alt text */
  gallery: { src: string; caption: string }[];
  /** detail rows on the product page, e.g. ['Taste', 'Mild, lightly herbal'] */
  specs: [string, string][];
  /** colour range on the 7-step honey grade scale (0–6, see GRADES), or null when it does not apply */
  colour: [number, number] | null;
  /** main description paragraph */
  about: string;
  /** "Why you'll love it" points */
  love: string[];
  /** heading for the `use` text, or null for the default "How to enjoy" */
  useHead: string | null;
  /** how to enjoy / use it */
  use: string;
  /** storage advice */
  store: string;
  /** Honey Finder profile, or null when the product is not in the quiz (candles, sticks) */
  finder: FinderProfile | null;
  /** flowering months for the bloom calendar, or null when not shown on it */
  bloom: BloomMonths | null;
  /** note for honeys whose bloom is not every year; such honeys are never marked "in bloom now". null = none */
  bloomNote: string | null;
  /** true when the honey can be picked in the gift box builder */
  inGiftBox: boolean;
}

export interface CatalogVariant {
  /** stable pack code '<slug>:<pack>', never changes: 'murungai-honey:250g', 'beeswax-candles:small',
      'honey-sticks:1-stick', 'honey-sticks:box-10'. Lower-case letters, digits, ':' and '-'. */
  code: string;
  /** slug of the product this pack belongs to */
  productSlug: string;
  /** pack name shown to customers and in the WhatsApp message, e.g. '250 g', 'Small', 'Box of 10 (100 g)' */
  label: string;
  /** order of the packs within the product, ascending */
  sort: number;
  /** false when the pack is no longer sold; inactive packs are kept so old carts can be mapped */
  active: boolean;
  /** net weight in grams for ₹ per 100 g and kg sold, or null when weight does not apply (candles) */
  netGrams: number | null;
  /** code of the stock pool this pack draws from (see CatalogPool) */
  poolCode: string;
  /** how much of the pool one pack uses, in the pool's unit: grams for honey (= netGrams), pieces otherwise */
  poolQty: number;
  /** selling price in paise, or null for "Price on WhatsApp" */
  pricePaise: number | null;
  /** printed MRP in paise when higher than the price, or null when it is the same as the price */
  mrpPaise: number | null;
  /** true when this pack size can go in a gift box */
  giftOk: boolean;
  /** availability level; exact counts are never published */
  avail: Avail;
}

/** A stock pool (amendment A3): what the owner counts. Only its identity is public, never its counts. */
export interface CatalogPool {
  /** stable pool code: '<slug>' for one pool per product, '<slug>:<size>' when a product has several,
      e.g. 'murungai-honey', 'beeswax-candles:small', 'honey-sticks' */
  code: string;
  /** slug of the product the pool belongs to */
  productSlug: string;
  /** name the owner sees, e.g. 'Murungai Honey', 'Beeswax Candles, Small', 'Honey sticks' */
  name: string;
  /** 'g' (honey) or 'piece' (candles, sticks) */
  unit: PoolUnit;
}

/** Offer banner (v2). Shape is provisional until the offer banner is built. */
export interface CatalogOffer {
  /** banner text, e.g. 'Diwali gift boxes: order by 25 Oct' */
  text: string;
  /** site path the banner links to, e.g. '/gift-box/', or null for no link */
  href: string | null;
  /** last day to show it, 'YYYY-MM-DD' (IST), or null for no end date */
  until: string | null;
}

/** Website settings that the public site may see (D1 `settings`, public keys only). */
export interface CatalogSettings {
  /** master switch: false hides every price slot and Offer JSON-LD (default false until go-live) */
  showPrices: boolean;
  /** 'sold_out' (default) shows only Sold out; 'low_and_sold_out' also shows "Only a few left" */
  stockDisplay: StockDisplay;
  /** line under the cart total, e.g. 'Delivery charges are confirmed on WhatsApp.' */
  deliveryNote: string;
  /** offer banner, or null for none */
  offer: CatalogOffer | null;
  /** gift box pricing */
  gift: {
    /** packing fee per box in paise (0 = none) */
    feePaise: number;
    /** gift box extra (as named in GIFT_EXTRAS) → variant code it is priced as, or null for "price on WhatsApp" */
    extras: Record<string, string | null>;
    /** from this many boxes the total says "Bulk price confirmed on WhatsApp" */
    bulkFrom: number;
  };
}

/** A packed batch that customers can look up in Know Your Jar (public batches only). */
export interface CatalogBatch {
  /** code written on the label, e.g. 'MUR-2611-01'; unique ignoring case, spaces and punctuation */
  code: string;
  /** slug of the product in the jar (any status: a retired product's batches still resolve) */
  productSlug: string;
  /** when the honey was taken from the hive, in words, e.g. 'October 2026' */
  harvested: string;
  /** packing date, 'YYYY-MM-DD' */
  packed: string;
  /** best before, 'YYYY-MM' */
  bestBefore: string;
  /** one short public sentence about the batch, or null */
  note: string | null;
}

/** The whole catalog: the body of GET /api/catalog.json and of catalog.snapshot.json. */
export interface Catalog {
  /** format version, = CATALOG_FORMAT */
  format: typeof CATALOG_FORMAT;
  /** D1 settings.site_version: bumped by every owner save that needs a rebuild; shown in /build.json */
  siteVersion: number;
  /** D1 settings.live_version: bumped by every change that /api/live.json serves without a rebuild */
  liveVersion: number;
  /** the four shop sections, in display order */
  categories: CatalogCategory[];
  /** live, paused and retired products, in display order */
  products: CatalogProduct[];
  /** every pack of every product in the catalog, by product then pack order */
  variants: CatalogVariant[];
  /** stock pools of every product in the catalog (identity only, never counts) */
  pools: CatalogPool[];
  /** public website settings */
  settings: CatalogSettings;
  /** public batches for Know Your Jar, newest first */
  batches: CatalogBatch[];
}
