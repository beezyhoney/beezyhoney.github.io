// Product details the interactive pages need in the browser (quiz, gift box, batch lookup),
// with a small WebP thumbnail made at build time. Rendered into a JSON <script> on the page.
// Also the build-time price helpers: the baked #price-data table (contract 2) and the "From ₹…" price.
import { getImage } from 'astro:assets';
import { PRODUCTS, productName, type Product } from '../data/products';
import { FINDER_PROFILES, BLOOM } from '../data/features';
import { LIVE_VERSION, PRICE_TABLE, SETTINGS } from '../data/catalog';
import { link } from '../data/site';
import { img } from './images';
import type { PriceData } from '../scripts/live';

/** One pack as the browser sees it. Prices are null while settings.showPrices is off. */
export interface ClientOffer { code: string; label: string; price: number | null; mrp: number | null; avail: 'in' | 'low' | 'out'; giftOk: boolean }

export interface ClientProduct {
  slug: string; name: string; short: string; kind: string; tagline: string; tone: string;
  href: string; packs: string[]; taste: string; source: string; colour: [number, number] | null;
  honey: boolean; thumb: string; profile: (typeof FINDER_PROFILES)[string] | null; bloom: number[] | 'all' | null;
  /** live, paused or retired */
  status: Product['status'];
  /** the packs with code, price, MRP, availability and gift eligibility (prices null while prices are hidden) */
  offers: ClientOffer[];
  /** lowest pack price in paise ("From ₹125"), or null */
  fromPaise: number | null;
}

/** Packs of a product with the prices visitors may see (null while settings.showPrices is off). */
export function offersOf(p: Product): ClientOffer[] {
  const show = SETTINGS.showPrices;
  return p.variants.map((v) => ({
    code: v.code, label: v.label,
    price: show ? v.pricePaise : null,
    mrp: show && v.pricePaise !== null && v.mrpPaise !== null && v.mrpPaise > v.pricePaise ? v.mrpPaise : null,
    avail: v.avail, giftOk: v.giftOk,
  }));
}

/** Lowest price among the product's packs, in paise, or null (no prices, or prices hidden). */
export function fromPaise(p: Product): number | null {
  const prices = offersOf(p).map((o) => o.price).filter((x): x is number => x !== null);
  return prices.length ? Math.min(...prices) : null;
}

/** Every pack of the product is sold out. */
export const allPacksOut = (p: Product) => p.variants.length > 0 && p.variants.every((v) => v.avail === 'out');

/** `list` defaults to the live products; Know Your Jar passes ALL_PRODUCTS so old batches still resolve */
export async function clientProducts(list: Product[] = PRODUCTS): Promise<ClientProduct[]> {
  return Promise.all(list.map(async (p) => {
    const spec = (k: string) => p.specs.find(([key]) => key === k)?.[1] ?? '';
    return {
      slug: p.slug,
      name: productName(p),
      short: p.name,
      kind: p.kind,
      tagline: p.tagline,
      tone: p.tone,
      href: link(`/shop/${p.slug}/`),
      packs: p.packs,
      taste: spec('Taste'),
      source: spec('Source') || spec('Bee'),
      colour: p.colour ?? null,
      honey: p.category !== 'from-the-hive',
      thumb: (await getImage({ src: img(p.photo), width: 520, format: 'webp' })).src,
      profile: FINDER_PROFILES[p.slug] ?? null,
      bloom: BLOOM[p.slug] ?? null,
      status: p.status,
      offers: offersOf(p),
      fromPaise: fromPaise(p),
    };
  }));
}

/**
 * The price table baked into every page as <script type="application/json" id="price-data"> (contract 2):
 * the same shape as GET /api/live.json. While settings.showPrices is off, prices and MRPs are left out (null),
 * so nothing about prices is published until the owner switches them on.
 */
/** Today's date in India (IST), 'YYYY-MM-DD' */
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function bakedPriceData(): PriceData {
  const show = SETTINGS.showPrices;
  const p: PriceData['p'] = {};
  for (const [slug, packs] of Object.entries(PRICE_TABLE)) {
    p[slug] = {};
    for (const [label, e] of Object.entries(packs)) {
      const price = show ? e.pricePaise : null;
      const mrp = show && price !== null && e.mrpPaise !== null && e.mrpPaise > price ? e.mrpPaise : null;
      p[slug][label] = [price, mrp, e.avail, e.code];
    }
  }
  const o = SETTINGS.offer;
  return {
    lv: LIVE_VERSION,
    show,
    sd: SETTINGS.stockDisplay,
    p,
    // the offer ends after its `until` day (IST); live.ts also hides it once that day has passed, without a rebuild
    offer: o && !(o.until && o.until < istToday()) ? { text: o.text, ...(o.href ? { link: o.href } : {}), ...(o.until ? { until: o.until } : {}) } : null,
    note: SETTINGS.deliveryNote,
  };
}

/** JSON for a <script type="application/json">, safe against "</script>" inside text */
export { toJson } from './json';
