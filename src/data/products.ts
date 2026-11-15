// Product types and helpers. The product data itself (text, photos, packs, prices) lives in the catalog:
// src/data/catalog.snapshot.json for now, the admin portal later. See catalog.ts and catalog.types.ts.
import type { Avail, CategoryId, ProductStatus } from './catalog.types';

export type { CategoryId } from './catalog.types';
export { PRODUCTS, PRODUCT_PAGES, ALL_PRODUCTS, CATEGORIES } from './catalog';

/** One pack of a product that can be ordered (active packs only, in pack order) */
export interface ProductVariant {
  /** stable pack code, e.g. 'murungai-honey:250g' */
  code: string;
  /** pack name, e.g. '250 g' (same as the matching entry in `packs`) */
  label: string;
  /** net weight in grams, or null (candles) */
  netGrams: number | null;
  /** price in paise, or null for "Price on WhatsApp" */
  pricePaise: number | null;
  /** MRP in paise when higher than the price, else null */
  mrpPaise: number | null;
  /** can go in a gift box */
  giftOk: boolean;
  /** availability level (counts are never published) */
  avail: Avail;
}

export interface Product {
  slug: string;
  name: string;
  category: CategoryId;
  kind: string;
  badge: string;
  withComb: boolean;
  tagline: string;
  tone: string;
  /** main photo: product hero, home carousel */
  photo: string;
  /** shop card photo (defaults to photo) */
  card?: string;
  /** photo slider on the product page */
  gallery: { src: string; caption: string }[];
  specs: [string, string][];
  /** colour range on the 7-step honey grade scale, if it applies */
  colour?: [number, number];
  about: string;
  love: string[];
  useHead?: string;
  use: string;
  /** names of the packs that can be ordered, in order (labels of `variants`) */
  packs: string[];
  store: string;
  /** live (listed), paused (page only) or retired (no page) */
  status: ProductStatus;
  /** 2–4 capital letters that start batch codes, e.g. 'MUR' */
  shortCode: string;
  /** the packs that can be ordered, with price and availability */
  variants: ProductVariant[];
}

export const GRADES: [string, string][] = [
  ['Water white', '#F6F0D2'], ['Extra white', '#F1E3A0'], ['White', '#EACF73'], ['Extra light amber', '#E2B347'],
  ['Light amber', '#D4952A'], ['Amber', '#B46A16'], ['Dark amber', '#6B3A10'],
];

export const productName = (p: Product) => p.name + (p.withComb ? ' with comb' : '');
