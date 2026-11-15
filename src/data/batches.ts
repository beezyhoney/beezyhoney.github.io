// "Know your jar": every batch you pack, so customers can look up the batch number on their label.
// The batches come from the catalog (see catalog.ts): `batches` in src/data/catalog.snapshot.json for now,
// and the admin portal's harvest entry later. Newest first. The code is what you write in the label's BATCH NO. box.
//
//   code         letters/numbers on the label, e.g. 'MUR-2611-01' (product short code, year+month, batch)
//   productSlug  the product's slug, e.g. 'murungai-honey' (here in Batch it is called `product`)
//   harvested    when the honey was taken from the hive, in words, e.g. 'October 2026'
//   packed       packing date, 'YYYY-MM-DD'
//   bestBefore   'YYYY-MM'
//   note         one short sentence about this batch, or null
//
// Example entry in the catalog's "batches" list:
//   { "code": "MUR-2611-01", "productSlug": "murungai-honey", "harvested": "October 2026", "packed": "2026-11-10",
//     "bestBefore": "2028-11", "note": "A light, early-season harvest." }

export { BATCHES } from './catalog';

export interface Batch {
  code: string;
  product: string;
  harvested: string;
  packed: string;
  bestBefore: string;
  note?: string;
}

/** Same rule as the lookup on the page: compare codes ignoring case, spaces and punctuation */
export const batchKeyOf = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Checks every batch at build time, so a typo stops the build instead of showing a broken result.
 * `products` should be every product a batch may belong to: live, paused and retired (ALL_PRODUCTS),
 * so pausing or retiring a product never breaks the lookup of jars already sold.
 */
export function checkBatches(batches: Batch[], products: { slug: string }[]): void {
  const seen = new Set<string>();
  for (const b of batches) {
    const where = `Catalog batch "${b.code}"`;
    if (!batchKeyOf(b.code ?? '')) throw new Error(`${where}: the code is empty`);
    if (seen.has(batchKeyOf(b.code))) throw new Error(`${where}: this code is listed twice`);
    seen.add(batchKeyOf(b.code));
    if (!products.some((p) => p.slug === b.product)) throw new Error(`${where}: unknown product "${b.product}" (use a product slug from the catalog)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.packed) || Number.isNaN(Date.parse(b.packed))) throw new Error(`${where}: packed must look like 2026-11-10`);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.bestBefore)) throw new Error(`${where}: bestBefore must look like 2028-11`);
    if (!b.harvested?.trim()) throw new Error(`${where}: harvested is empty`);
  }
}
