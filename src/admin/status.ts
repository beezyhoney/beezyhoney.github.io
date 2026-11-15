// Status chips: which words and colour each status gets (used by components/Badge.astro).
// Colour is never the only signal: every chip has words, and the "bad" tone also gets an icon.

import type { StringKey } from './strings';

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'bad' | 'honey' | 'muted';

export type OrderStatus = 'new' | 'confirmed' | 'packed' | 'shipped' | 'delivered' | 'cancelled' | 'spam';
export type ProductStatus = 'draft' | 'live' | 'paused' | 'retired';
/** stock level of a pool or pack, as the owner sees it ('negative' and 'untracked' are owner-only states) */
export type StockLevel = 'in' | 'low' | 'out' | 'negative' | 'untracked';
export type PaymentState = 'paid' | 'part' | 'unpaid' | 'refunded';
export type BatchStatus = 'active' | 'finished' | 'recalled';
export type AvailOverride = 'auto' | 'in' | 'out';
export type OrderSource = 'cart' | 'product' | 'gift' | 'manual' | 'pasted';

export type BadgeKind = 'order' | 'product' | 'stock' | 'payment' | 'batch' | 'avail' | 'source';

export const STATUS_TONES = {
  order: { new: 'info', confirmed: 'honey', packed: 'honey', shipped: 'info', delivered: 'ok', cancelled: 'muted', spam: 'muted' },
  product: { draft: 'muted', live: 'ok', paused: 'warn', retired: 'muted' },
  stock: { in: 'ok', low: 'warn', out: 'bad', negative: 'bad', untracked: 'neutral' },
  payment: { paid: 'ok', part: 'warn', unpaid: 'bad', refunded: 'muted' },
  batch: { active: 'ok', finished: 'muted', recalled: 'bad' },
  avail: { auto: 'neutral', in: 'ok', out: 'bad' },
  source: { cart: 'neutral', product: 'neutral', gift: 'honey', manual: 'neutral', pasted: 'neutral' },
} as const satisfies {
  order: Record<OrderStatus, Tone>;
  product: Record<ProductStatus, Tone>;
  stock: Record<StockLevel, Tone>;
  payment: Record<PaymentState, Tone>;
  batch: Record<BatchStatus, Tone>;
  avail: Record<AvailOverride, Tone>;
  source: Record<OrderSource, Tone>;
};

/** Words and tone for a status; unknown values come back neutral with the raw value as text. */
export function statusChip(kind: BadgeKind, value: string): { tone: Tone; label: StringKey | null; raw: string } {
  const tones = STATUS_TONES[kind] as Record<string, Tone>;
  if (!Object.prototype.hasOwnProperty.call(tones, value)) return { tone: 'neutral', label: null, raw: value };
  return { tone: tones[value], label: `status.${kind}.${value}` as StringKey, raw: value };
}

/** Payment state of an order from its totals (paise). */
export function paymentState(totalPaise: number, paidPaise: number): PaymentState {
  if (paidPaise < 0) return 'refunded';
  if (paidPaise >= totalPaise) return 'paid'; // includes ₹0 orders (free samples)
  if (paidPaise > 0) return 'part';
  return 'unpaid';
}
