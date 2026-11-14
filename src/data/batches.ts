// "Know your jar": every batch you pack, so customers can look up the batch number on their label.
// Add one line per batch, newest first, then push. The code is what you write in the label's BATCH NO. box.
//
//   code        letters/numbers on the label, e.g. 'MUR-2611-01' (product short code, year+month, batch)
//   product     the product's slug from products.ts, e.g. 'murungai-honey'
//   harvested   when the honey was taken from the hive, in words, e.g. 'October 2026'
//   packed      packing date, 'YYYY-MM-DD'
//   bestBefore  'YYYY-MM'
//   note        optional, one short sentence about this batch
//
// Example (copy, change and remove the // at the start):
//   { code: 'MUR-2611-01', product: 'murungai-honey', harvested: 'October 2026', packed: '2026-11-10', bestBefore: '2028-11', note: 'A light, early-season harvest.' },

export interface Batch {
  code: string;
  product: string;
  harvested: string;
  packed: string;
  bestBefore: string;
  note?: string;
}

export const BATCHES: Batch[] = [
];
