// Stock pools and pack availability (amendment A3), shared by the server (live.json, catalog, alerts),
// the admin screens and tests. Pure functions, no I/O.
//
// Stock is counted per POOL, the owner's way: grams for each honey (shown as kg), pieces for candles (one pool
// per size) and honey sticks. A pack uses `poolQty` of its pool (250 g jar = 250; 'Box of 10 (100 g)' = 10 sticks).
//
// Availability of one pack (contract 7), first rule that applies:
//   1. manual override on the pool ('in' or 'out') wins
//   2. tracking off            → 'in'  (until the first harvest or count, the site says "In stock")
//   3. on hand < pool qty      → 'out' (cannot fill one pack)
//   4. on hand ≤ low level     → 'low'
//   5. otherwise               → 'in'
// Exact amounts are never published; with stock display 'sold_out' (the default) the site shows 'low' as 'in'.

export type Avail = 'in' | 'low' | 'out';
export type AvailabilityOverride = 'auto' | 'in' | 'out';
export type PoolUnit = 'g' | 'piece';
export type StockDisplay = 'sold_out' | 'low_and_sold_out';

/** The part of a stock pool that decides availability */
export interface PoolState {
  /** false until the first harvest or count */
  trackStock: boolean;
  /** amount on hand in the pool's unit; may be negative */
  onHand: number;
  /** "low" level in the pool's unit, or null for no low level */
  lowAt: number | null;
  /** manual override: 'auto' follows the stock */
  availability: AvailabilityOverride;
}

/** Availability of one pack that uses `poolQty` of the pool */
export function packAvailability(pool: PoolState, poolQty: number): Avail {
  if (pool.availability === 'in' || pool.availability === 'out') return pool.availability;
  if (!pool.trackStock) return 'in';
  if (pool.onHand < Math.max(1, poolQty)) return 'out';
  if (pool.lowAt !== null && pool.onHand <= pool.lowAt) return 'low';
  return 'in';
}

/** What the website shows for an availability level: with 'sold_out' display, 'low' is shown as 'in' */
export function publicAvail(avail: Avail, display: StockDisplay): Avail {
  return avail === 'low' && display === 'sold_out' ? 'in' : avail;
}

/** Owner-facing state of a pool, for the Stock grid and the alerts on Today */
export type PoolLevel = 'untracked' | 'negative' | 'empty' | 'low' | 'ok';

/**
 * Level of a whole pool for the owner.
 * - untracked: tracking off (no alerts)
 * - negative: below zero (recount soon), shown red
 * - empty: cannot fill even the smallest active pack
 * - low: at or below the low level
 * - ok
 */
export function poolLevel(pool: Omit<PoolState, 'availability'>, smallestPackQty: number): PoolLevel {
  if (!pool.trackStock) return 'untracked';
  if (pool.onHand < 0) return 'negative';
  if (pool.onHand < Math.max(1, smallestPackQty)) return 'empty';
  if (pool.lowAt !== null && pool.onHand <= pool.lowAt) return 'low';
  return 'ok';
}

const kgFormat = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const intFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/**
 * Grams as kg with one decimal: 99500 → '99.5 kg', -750 → '−0.8 kg' (a real minus sign).
 * Amounts that would round to 0.0 kg but are not zero are shown in grams: 40 → '40 g', -50 → '−50 g'.
 */
export function formatKg(grams: number): string {
  const sign = grams < 0 ? '−' : '';
  const abs = Math.abs(grams);
  if (abs > 0 && abs < 50) return `${sign}${intFormat.format(abs)} g`;
  const kg = Math.round(abs / 100) / 10;
  return `${sign}${kgFormat.format(kg)} kg`;
}

/** Pool amount in the owner's words: '99.5 kg' for grams, '12 pieces' / '1 piece' / '−2 pieces' otherwise */
export function formatPoolAmount(amount: number, unit: PoolUnit): string {
  if (unit === 'g') return formatKg(amount);
  const n = intFormat.format(Math.abs(amount));
  return `${amount < 0 ? '−' : ''}${n} ${Math.abs(amount) === 1 ? 'piece' : 'pieces'}`;
}

/**
 * Parses what the owner types for an amount: kg for gram pools ('99.5', '99,5', '100 kg', '250 g'),
 * whole pieces otherwise. Returns the amount in the pool's unit, or null when it cannot be read.
 * Negative amounts are allowed only with `allowNegative` (stock adjustments, never harvests).
 */
export function parsePoolAmount(text: string, unit: PoolUnit, opts: { allowNegative?: boolean } = {}): number | null {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[−–]/g, '-');
  if (!t) return null;
  if (unit === 'piece') {
    const m = /^(-?)(\d{1,7})(?: ?(?:pcs?|pieces?|nos?))?$/.exec(t);
    if (!m) return null;
    const n = Number(m[2]) * (m[1] ? -1 : 1);
    return n < 0 && !opts.allowNegative ? null : n;
  }
  const m = /^(-?)(\d{1,6})(?:[.,](\d{1,3}))?(?: ?(kg|kgs|g|gm|gms|grams?))?$/.exec(t);
  if (!m) return null;
  const sign = m[1] ? -1 : 1;
  const unitText = m[4] ?? 'kg';
  let grams: number;
  if (unitText.startsWith('k')) {
    grams = Number(m[2]) * 1000 + Number((m[3] ?? '').padEnd(3, '0') || '0');
  } else {
    if (m[3]) return null; // fractions of a gram make no sense
    grams = Number(m[2]);
  }
  grams *= sign;
  if (!Number.isSafeInteger(grams)) return null;
  return grams < 0 && !opts.allowNegative ? null : grams;
}

/**
 * A rough "how many packs is that" line for the owner, e.g. '≈ 396 × 250 g or 991 × 100 g'.
 * Uses the active packs of the pool, biggest pack first; nothing for zero or negative stock.
 */
export function packEquivalents(onHand: number, packs: { label: string; poolQty: number }[], max = 2): string {
  if (onHand <= 0) return '';
  const parts = [...packs]
    .filter((p) => p.poolQty > 0)
    .sort((a, b) => b.poolQty - a.poolQty)
    .map((p) => ({ n: Math.floor(onHand / p.poolQty), label: p.label }))
    .filter((x) => x.n > 0);
  // prefer the most common sizes: show the middle and the smallest when there are more than `max`
  const picked = parts.length > max ? parts.slice(parts.length - max) : parts;
  if (!picked.length) return '';
  return `≈ ${picked.map((x) => `${intFormat.format(x.n)} × ${x.label}`).join(' or ')}`;
}
