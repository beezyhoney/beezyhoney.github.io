// Orders: reading, searching, manual and pasted orders, line editing while New, charges, customer fields,
// every status transition (design §2.4, §3.3, §3.4), payments, invoices, requests and test data.
//
// Every write is ONE D1 batch whose first statement changes the order only if its status and version still match
// (UPDATE … WHERE id = ? AND version = ? AND status IN (…)) and stamps a fresh op token (last_op). Every later
// statement in the batch is guarded by that token, so a rejected first statement makes the whole batch a no-op.
// Stock moves are per POOL (amendment A3): confirm writes one 'sale' move per pool, delta = −SUM(qty × pool_qty),
// keyed 'sale:<order>:<confirm_no>:<pool>'; undo/cancel write one 'sale_reversal' per sale move, keyed
// 'rev:<sale move id>', so a sale is reversed at most once. Negative stock is allowed: confirm is never blocked.
import { formatPoolAmount, type PoolUnit } from '../lib/availability';
import { formatINR } from '../lib/money';
import { isRef, newRef, normaliseRefQuery, REF_PREFIX } from '../lib/orderRef';
import {
  type Actor, type D1, type D1Statement, type Effects, type Failure, type Guard, type Result,
  all, auditInsert, batch, fail, first, ok, orderOpGuard, ownerOnly, stmt, tryBatch, uuid,
} from './db';
import { forecastStatusChange, recomputePoolsStmt, stockStatusStatements, type PoolChange } from './stock';
import { addDays, addTime, fyLabel, fyStartYear, isDate, istDate, istMidnight, nowIso } from './time';

export type OrderStatus = 'new' | 'confirmed' | 'packed' | 'shipped' | 'delivered' | 'cancelled' | 'spam';
export type OrderSource = 'cart' | 'product' | 'gift' | 'manual' | 'pasted';
export type OrderChannel = 'website' | 'whatsapp' | 'phone' | 'in_person' | 'other';
export type PaymentMethod = 'upi' | 'cash' | 'bank' | 'card' | 'other';
export type LineKind = 'item' | 'fee' | 'custom';

export const PAYMENT_METHODS: readonly PaymentMethod[] = ['upi', 'cash', 'bank', 'card', 'other'];
export const MANUAL_CHANNELS: readonly OrderChannel[] = ['whatsapp', 'phone', 'in_person', 'other'];
/** Statuses that count as a sale (sales reports, invoices) */
export const SOLD: readonly OrderStatus[] = ['confirmed', 'packed', 'shipped', 'delivered'];

/** How each status reads in a sentence ("This order is already …") */
export const STATUS_WORDS: Record<OrderStatus, string> = {
  new: 'new', confirmed: 'confirmed', packed: 'packed', shipped: 'sent', delivered: 'delivered', cancelled: 'cancelled', spam: 'marked as not a real order',
};

/** Allowed status changes (design §3.3): action → statuses it may start from */
export const TRANSITIONS = {
  confirm: ['new'],
  undo_confirm: ['confirmed'],
  pack: ['confirmed'],
  ship: ['confirmed', 'packed'],
  deliver: ['confirmed', 'packed', 'shipped'],
  cancel: ['new', 'confirmed', 'packed', 'shipped', 'delivered'],
  mark_spam: ['new'],
  restore: ['spam'],
} as const satisfies Record<string, readonly OrderStatus[]>;

const MAX_LINES = 50;
const MAX_PAISE = 1_000_000_000; // ₹1 crore: anything bigger is a typing mistake

// ───────────────────────────── shapes ─────────────────────────────

export interface Customer { name: string | null; phone: string | null; address: string | null; city: string | null }

export interface GiftDetails {
  size: number | null;
  jar: string | null;
  picks: string[];
  extras: string[];
  boxes: number | null;
  occasion: string | null;
  neededBy: string | null;
  card: string | null;
}

export interface Order {
  id: number;
  ref: string;
  source: OrderSource;
  channel: OrderChannel;
  status: OrderStatus;
  isTest: boolean;
  confirmNo: number;
  itemsTotalPaise: number;
  deliveryPaise: number;
  discountPaise: number;
  totalPaise: number;
  paidPaise: number;
  /** total − paid (negative = paid too much) */
  balancePaise: number;
  shownTotalPaise: number | null;
  shownLiveVersion: number | null;
  priceMismatch: boolean;
  flags: { unknown?: { c: string; s: string; p: string }[]; soldOut?: string[]; unavailable?: string[] } | null;
  gift: GiftDetails | null;
  isBulk: boolean;
  neededBy: string | null;
  repliedAt: string | null;
  customer: Customer;
  personalClearedAt: string | null;
  note: string | null;
  cancelReason: string | null;
  invoiceNo: string | null;
  invoicedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  confirmedAt: string | null;
  packedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  version: number;
}

export interface OrderLine {
  id: number;
  kind: LineKind;
  variantId: number | null;
  productId: number | null;
  /** pack code for items */
  code: string | null;
  name: string;
  pack: string;
  qty: number;
  unitPricePaise: number | null;
  /** the D1 price when the line was made (to show overrides) */
  listPricePaise: number | null;
  /** today's D1 price of the pack (items only) */
  currentPricePaise: number | null;
  priceNote: string | null;
  lineTotalPaise: number;
  sort: number;
}

export interface Payment { id: number; amountPaise: number; method: PaymentMethod; reference: string | null; receivedOn: string; createdAt: string; createdBy: string }

export interface OrderStockMove { id: number; poolId: number; poolName: string; unit: PoolUnit; delta: number; deltaText: string; reason: 'sale' | 'sale_reversal'; createdAt: string }

export interface OrderDetail {
  order: Order;
  lines: OrderLine[];
  payments: Payment[];
  stockMoves: OrderStockMove[];
  /** the `_action` values that make sense now (the page shows only these buttons) */
  actions: OrderAction[];
}

export type OrderAction = 'save_lines' | 'use_customer_prices' | 'save_charges' | 'save_customer' | 'confirm' | 'confirm_paid'
  | 'undo_confirm' | 'pay' | 'pack' | 'ship' | 'deliver' | 'cancel' | 'mark_spam' | 'mark_test' | 'restore' | 'duplicate'
  | 'invoice' | 'replied';

interface OrderRow {
  id: number; ref: string; source: OrderSource; channel: OrderChannel; status: OrderStatus; is_test: number; confirm_no: number;
  items_total_paise: number; delivery_paise: number; discount_paise: number; total_paise: number; paid_paise: number;
  shown_total_paise: number | null; shown_live_version: number | null; price_mismatch: number; flags_json: string | null;
  gift_json: string | null; is_bulk: number; needed_by: string | null; replied_at: string | null; customer_name: string | null;
  customer_phone: string | null; customer_address: string | null; customer_city: string | null; personal_cleared_at: string | null;
  note: string | null; cancel_reason: string | null; invoice_no: string | null; invoiced_at: string | null; created_at: string;
  updated_at: string; updated_by: string; confirmed_at: string | null; packed_at: string | null; shipped_at: string | null;
  delivered_at: string | null; cancelled_at: string | null; version: number;
}

const parseJson = <T>(s: string | null): T | null => {
  if (s === null) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};

export function toOrder(r: OrderRow): Order {
  return {
    id: r.id, ref: r.ref, source: r.source, channel: r.channel, status: r.status, isTest: r.is_test === 1, confirmNo: r.confirm_no,
    itemsTotalPaise: r.items_total_paise, deliveryPaise: r.delivery_paise, discountPaise: r.discount_paise, totalPaise: r.total_paise,
    paidPaise: r.paid_paise, balancePaise: r.total_paise - r.paid_paise, shownTotalPaise: r.shown_total_paise,
    shownLiveVersion: r.shown_live_version, priceMismatch: r.price_mismatch === 1, flags: parseJson(r.flags_json),
    gift: parseJson(r.gift_json), isBulk: r.is_bulk === 1, neededBy: r.needed_by, repliedAt: r.replied_at,
    customer: { name: r.customer_name, phone: r.customer_phone, address: r.customer_address, city: r.customer_city },
    personalClearedAt: r.personal_cleared_at, note: r.note, cancelReason: r.cancel_reason, invoiceNo: r.invoice_no,
    invoicedAt: r.invoiced_at, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by, confirmedAt: r.confirmed_at,
    packedAt: r.packed_at, shippedAt: r.shipped_at, deliveredAt: r.delivered_at, cancelledAt: r.cancelled_at, version: r.version,
  };
}

/** Buttons that apply to an order now */
export function allowedActions(o: Order): OrderAction[] {
  const a: OrderAction[] = ['save_customer', 'duplicate'];
  const s = o.status;
  if (s === 'new') a.push('save_lines', 'confirm', 'confirm_paid', 'mark_spam');
  if (s === 'new' && o.shownTotalPaise !== null && o.shownTotalPaise < o.itemsTotalPaise && o.discountPaise !== o.itemsTotalPaise - o.shownTotalPaise) a.push('use_customer_prices');
  if (s !== 'cancelled' && s !== 'spam') a.push('save_charges', 'pay');
  if (s === 'confirmed') a.push('undo_confirm');
  if ((TRANSITIONS.pack as readonly string[]).includes(s)) a.push('pack');
  if ((TRANSITIONS.ship as readonly string[]).includes(s)) a.push('ship');
  if ((TRANSITIONS.deliver as readonly string[]).includes(s)) a.push('deliver');
  if ((TRANSITIONS.cancel as readonly string[]).includes(s)) a.push('cancel');
  if (s === 'spam') a.push('restore');
  if (s !== 'spam') a.push('mark_test');
  if ((SOLD as readonly string[]).includes(s) && o.invoiceNo === null && !o.isTest) a.push('invoice');
  if (o.source === 'gift' || o.isBulk || o.gift != null) a.push('replied');
  // an invoice number freezes the order: cancel is the only way out (the server refuses these too)
  if (o.invoiceNo !== null) return a.filter((x) => !INVOICE_FROZEN.includes(x));
  return a;
}

/** Actions refused once an order has an invoice number */
export const INVOICE_FROZEN: readonly OrderAction[] = ['save_lines', 'use_customer_prices', 'save_charges', 'confirm', 'confirm_paid', 'undo_confirm', 'mark_spam'];

// ───────────────────────────── reading ─────────────────────────────

/** Everything the order page needs, or null. One read batch. */
export async function getOrder(db: D1, id: number): Promise<OrderDetail | null> {
  const [oRes, lRes, pRes, mRes] = await db.batch([
    stmt(db, 'SELECT * FROM orders WHERE id = ?', id),
    stmt(db, `SELECT l.id, l.kind, l.variant_id, l.product_id, v.code, l.name_snapshot, l.pack_snapshot, l.qty, l.unit_price_paise,
        l.list_price_paise, v.price_paise AS current_price, l.price_note, l.line_total_paise, l.sort
      FROM order_lines l LEFT JOIN variants v ON v.id = l.variant_id WHERE l.order_id = ? ORDER BY l.sort, l.id`, id),
    stmt(db, 'SELECT id, amount_paise, method, reference, received_on, created_at, created_by FROM payments WHERE order_id = ? ORDER BY id', id),
    stmt(db, `SELECT m.id, m.pool_id, s.name, s.unit, m.delta, m.reason, m.created_at FROM stock_moves m JOIN stock_pools s ON s.id = m.pool_id
      WHERE m.order_id = ? ORDER BY m.id`, id),
  ]);
  const r = oRes.results[0] as unknown as OrderRow | undefined;
  if (!r) return null;
  const order = toOrder(r);
  type L = { id: number; kind: LineKind; variant_id: number | null; product_id: number | null; code: string | null; name_snapshot: string; pack_snapshot: string; qty: number; unit_price_paise: number | null; list_price_paise: number | null; current_price: number | null; price_note: string | null; line_total_paise: number; sort: number };
  return {
    order,
    lines: (lRes.results as unknown as L[]).map((l) => ({
      id: l.id, kind: l.kind, variantId: l.variant_id, productId: l.product_id, code: l.code, name: l.name_snapshot, pack: l.pack_snapshot,
      qty: l.qty, unitPricePaise: l.unit_price_paise, listPricePaise: l.list_price_paise, currentPricePaise: l.current_price,
      priceNote: l.price_note, lineTotalPaise: l.line_total_paise, sort: l.sort,
    })),
    payments: (pRes.results as { id: number; amount_paise: number; method: PaymentMethod; reference: string | null; received_on: string; created_at: string; created_by: string }[])
      .map((p) => ({ id: p.id, amountPaise: p.amount_paise, method: p.method, reference: p.reference, receivedOn: p.received_on, createdAt: p.created_at, createdBy: p.created_by })),
    stockMoves: (mRes.results as { id: number; pool_id: number; name: string; unit: PoolUnit; delta: number; reason: 'sale' | 'sale_reversal'; created_at: string }[])
      .map((m) => ({ id: m.id, poolId: m.pool_id, poolName: m.name, unit: m.unit, delta: m.delta, deltaText: `${m.delta > 0 ? '+' : ''}${formatPoolAmount(m.delta, m.unit)}`, reason: m.reason, createdAt: m.created_at })),
    actions: allowedActions(order),
  };
}

/** A row of the orders list / search results */
export interface OrderListRow {
  id: number;
  ref: string;
  status: OrderStatus;
  source: OrderSource;
  channel: OrderChannel;
  isTest: boolean;
  createdAt: string;
  confirmedAt: string | null;
  totalPaise: number;
  paidPaise: number;
  priceMismatch: boolean;
  /** 'Murungai Honey with comb 250 g × 2, Honey Sticks Box of 10 (100 g) × 1' */
  items: string;
  customerName: string | null;
  neededBy: string | null;
  repliedAt: string | null;
  isBulk: boolean;
}

const LIST_COLUMNS = `o.id, o.ref, o.status, o.source, o.channel, o.is_test, o.created_at, o.confirmed_at, o.total_paise, o.paid_paise,
  o.price_mismatch, o.customer_name, o.needed_by, o.replied_at, o.is_bulk,
  (SELECT group_concat(x.t, ', ') FROM (SELECT l.name_snapshot || CASE WHEN l.pack_snapshot <> '' THEN ' ' || l.pack_snapshot ELSE '' END
     || ' × ' || l.qty AS t FROM order_lines l WHERE l.order_id = o.id ORDER BY l.sort, l.id) x) AS items`;

type ListRow = { id: number; ref: string; status: OrderStatus; source: OrderSource; channel: OrderChannel; is_test: number; created_at: string; confirmed_at: string | null; total_paise: number; paid_paise: number; price_mismatch: number; customer_name: string | null; needed_by: string | null; replied_at: string | null; is_bulk: number; items: string | null };
const toListRow = (r: ListRow): OrderListRow => ({
  id: r.id, ref: r.ref, status: r.status, source: r.source, channel: r.channel, isTest: r.is_test === 1, createdAt: r.created_at,
  confirmedAt: r.confirmed_at, totalPaise: r.total_paise, paidPaise: r.paid_paise, priceMismatch: r.price_mismatch === 1,
  items: r.items ?? '', customerName: r.customer_name, neededBy: r.needed_by, repliedAt: r.replied_at, isBulk: r.is_bulk === 1,
});

/**
 * The find box: a full or partial order code ('BZ-7K3QD', '7K3QD', '3QD' = the last characters), or a customer
 * name / phone (3+ characters). Codes are not unique, so several orders may match; newest first, at most `limit`.
 */
export async function searchOrders(db: D1, query: string, opts: { limit?: number } = {}): Promise<OrderListRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const q = String(query ?? '').trim().slice(0, 80);
  if (q.length < 3) return [];
  const code = normaliseRefQuery(q);
  const digits = q.replace(/\D/g, '');
  const conds: string[] = [];
  const params: unknown[] = [];
  // instr()/substr() instead of LIKE: D1 refuses LIKE patterns over 50 bytes, and a typed name can be longer
  if (code && code.length === 5) { conds.push('o.ref = ?'); params.push(`${REF_PREFIX}${code}`); }
  else if (code) { conds.push('substr(o.ref, -length(?)) = ?'); params.push(code, code); }
  if (/[a-z]/i.test(q) && q.replace(/[^a-z]/gi, '').length >= 3) { conds.push('instr(lower(o.customer_name), lower(?)) > 0'); params.push(q.replace(/\s+/g, ' ')); }
  if (digits.length >= 4) { conds.push("instr(replace(replace(o.customer_phone, ' ', ''), '-', ''), ?) > 0"); params.push(digits); }
  if (!conds.length) return [];
  const rows = await all<ListRow>(db, `SELECT ${LIST_COLUMNS} FROM orders o WHERE ${conds.join(' OR ')} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`, ...params, limit);
  return rows.map(toListRow);
}

export type OrderTab = 'new' | 'confirmed' | 'to_send' | 'unpaid' | 'delivered' | 'cancelled' | 'unanswered' | 'requests' | 'spam' | 'all';

const TAB_WHERE: Record<OrderTab, string> = {
  new: "o.status = 'new'",
  confirmed: "o.status = 'confirmed'",
  to_send: "o.status IN ('confirmed', 'packed')",
  unpaid: "o.status IN ('confirmed', 'packed', 'shipped', 'delivered') AND o.paid_paise < o.total_paise",
  delivered: "o.status = 'delivered'",
  cancelled: "o.status = 'cancelled'",
  unanswered: "(o.source = 'gift' OR o.is_bulk = 1 OR o.gift_json IS NOT NULL) AND o.replied_at IS NULL AND o.status NOT IN ('cancelled', 'spam')",
  requests: "(o.source = 'gift' OR o.is_bulk = 1 OR o.gift_json IS NOT NULL) AND o.status <> 'spam'",
  spam: "o.status = 'spam'",
  all: "o.status <> 'spam'",
};

/**
 * The orders list: a tab, optional product / IST date range (created) filters, keyset paging.
 * Requests and Unanswered are sorted by needed-by date; the rest newest first. `next` feeds `before`.
 */
export async function listOrders(db: D1, opts: { tab?: OrderTab; productId?: number; from?: string; to?: string; limit?: number; before?: string } = {}): Promise<{ rows: OrderListRow[]; next: string | null }> {
  const tab = opts.tab && opts.tab in TAB_WHERE ? opts.tab : 'all';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = [TAB_WHERE[tab]];
  const params: unknown[] = [];
  if (opts.productId) { where.push('EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.product_id = ?)'); params.push(opts.productId); }
  if (opts.from && isDate(opts.from)) { where.push('o.created_at >= ?'); params.push(istMidnight(opts.from)); }
  if (opts.to && isDate(opts.to)) { where.push('o.created_at < ?'); params.push(istMidnight(addDays(opts.to, 1))); }
  const byNeed = tab === 'requests' || tab === 'unanswered';
  if (!byNeed && opts.before) {
    const [ts, id] = opts.before.split('|');
    if (ts && Number(id) > 0) { where.push('(o.created_at < ? OR (o.created_at = ? AND o.id < ?))'); params.push(ts, ts, Number(id)); }
  }
  const order = byNeed ? "COALESCE(o.needed_by, '9999-12-31'), o.created_at" : 'o.created_at DESC, o.id DESC';
  const rows = (await all<ListRow>(db, `SELECT ${LIST_COLUMNS} FROM orders o WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`, ...params, limit + 1)).map(toListRow);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next: more && !byNeed && last ? `${last.createdAt}|${last.id}` : null };
}

/** Counts for the Today screen */
export interface OrderCounts {
  newCount: number;
  oldestNewAt: string | null;
  /** New orders waiting longer than alerts.newWaitingHours */
  newWaitingLong: number;
  toSend: number;
  unpaidCount: number;
  /** ₹ still to collect on confirmed / packed / sent / delivered orders */
  unpaidPaise: number;
  /** gift / bulk requests without a reply for alerts.unansweredDays */
  requestsUnanswered: number;
  testOrders: number;
}

export async function orderCounts(db: D1, at: string = nowIso(), limits: { newWaitingHours?: number; unansweredDays?: number } = {}): Promise<OrderCounts> {
  const r = await first<Record<string, number | string | null>>(db, `SELECT
      COALESCE(SUM(status = 'new'), 0) AS new_count,
      MIN(CASE WHEN status = 'new' THEN created_at END) AS oldest_new,
      COALESCE(SUM(status = 'new' AND created_at <= ?1), 0) AS new_long,
      COALESCE(SUM(status IN ('confirmed', 'packed')), 0) AS to_send,
      COALESCE(SUM(status IN ('confirmed', 'packed', 'shipped', 'delivered') AND paid_paise < total_paise), 0) AS unpaid_count,
      COALESCE(SUM(CASE WHEN status IN ('confirmed', 'packed', 'shipped', 'delivered') AND paid_paise < total_paise THEN total_paise - paid_paise ELSE 0 END), 0) AS unpaid_paise,
      COALESCE(SUM((source = 'gift' OR is_bulk = 1 OR gift_json IS NOT NULL) AND replied_at IS NULL AND status NOT IN ('cancelled') AND created_at <= ?2), 0) AS req,
      COALESCE(SUM(is_test = 1), 0) AS tests
    FROM orders WHERE status <> 'spam'`,
  addTime(at, { hours: -(limits.newWaitingHours ?? 24) }), addTime(at, { days: -(limits.unansweredDays ?? 14) }));
  return {
    newCount: Number(r?.new_count ?? 0), oldestNewAt: (r?.oldest_new as string | null) ?? null, newWaitingLong: Number(r?.new_long ?? 0),
    toSend: Number(r?.to_send ?? 0), unpaidCount: Number(r?.unpaid_count ?? 0), unpaidPaise: Number(r?.unpaid_paise ?? 0),
    requestsUnanswered: Number(r?.req ?? 0), testOrders: Number(r?.tests ?? 0),
  };
}

// ───────────────────────────── lines ─────────────────────────────

/** One line as a form sends it */
export interface LineInput {
  /** 'item' (a pack, the default), 'custom' (free text, e.g. an unknown product) or 'fee' (e.g. gift box fee) */
  kind?: LineKind;
  /** the pack, by id or code (items) */
  variantId?: number | null;
  code?: string | null;
  /** name and pack text (custom and fee lines) */
  name?: string | null;
  pack?: string | null;
  /** 1–999 */
  qty: number;
  /** price of one, in paise. Leave out (undefined) for today's price of the pack; null = no price yet */
  unitPricePaise?: number | null;
  /** why the price differs (optional, ≤ 120 characters) */
  priceNote?: string | null;
}

interface ResolvedLine {
  kind: LineKind; variantId: number | null; productId: number | null; name: string; pack: string; qty: number;
  unit: number | null; list: number | null; priceNote: string | null; total: number; sort: number;
}

const displayName = (name: string, withComb: number) => name + (withComb === 1 ? ' with comb' : '');

/** Prices and names the lines from D1; merges repeated packs (refused when their prices differ). Errors name the line ('line-3'). */
async function resolveLines(db: D1, inputs: LineInput[]): Promise<Result<ResolvedLine[]>> {
  if (!Array.isArray(inputs) || !inputs.length) return fail('invalid', 'Add at least one item.', { field: 'lines' });
  if (inputs.length > MAX_LINES) return fail('invalid', `At most ${MAX_LINES} lines.`, { field: 'lines' });
  const ids = inputs.map((l) => l.variantId).filter((v): v is number => Number.isSafeInteger(v));
  const codes = inputs.map((l) => l.code).filter((v): v is string => typeof v === 'string' && v.length > 0);
  const variants = ids.length || codes.length ? await all<{ id: number; code: string; label: string; price_paise: number | null; product_id: number; name: string; with_comb: number }>(db,
    `SELECT v.id, v.code, v.label, v.price_paise, v.product_id, p.name, p.with_comb FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id IN (SELECT value FROM json_each(?)) OR v.code IN (SELECT value FROM json_each(?))`, JSON.stringify(ids), JSON.stringify(codes)) : [];
  const byId = new Map(variants.map((v) => [v.id, v]));
  const byCode = new Map(variants.map((v) => [v.code, v]));

  const out: ResolvedLine[] = [];
  const itemAt = new Map<number, number>();
  const firstLine = new Map<number, number>();
  for (const [i, l] of inputs.entries()) {
    const field = `line-${i + 1}`;
    const kind: LineKind = l.kind ?? 'item';
    if (!['item', 'custom', 'fee'].includes(kind)) return fail('invalid', 'Unknown line type.', { field });
    if (!Number.isSafeInteger(l.qty) || l.qty < 1 || l.qty > 999) return fail('invalid', 'Quantity must be 1–999.', { field });
    if (l.unitPricePaise !== undefined && l.unitPricePaise !== null && !(Number.isSafeInteger(l.unitPricePaise) && l.unitPricePaise >= 0 && l.unitPricePaise <= MAX_PAISE)) {
      return fail('invalid', 'The price must be ₹0 or more.', { field });
    }
    const priceNote = l.priceNote?.trim() || null;
    if (priceNote && priceNote.length > 120) return fail('invalid', 'The price note is too long (120 characters at most).', { field });
    if (kind === 'item') {
      const v = (l.variantId != null ? byId.get(l.variantId) : undefined) ?? (l.code ? byCode.get(l.code) : undefined);
      if (!v) return fail('invalid', 'Choose a product and pack.', { field });
      const unit = l.unitPricePaise === undefined ? v.price_paise : l.unitPricePaise;
      const prev = itemAt.get(v.id);
      if (prev !== undefined) {
        const merged = out[prev];
        // merging would silently drop this line's price: refuse instead
        if (merged.unit !== unit) return fail('invalid', `This pack is already on line ${firstLine.get(v.id)} at a different price. Give both the same price, or put them on one line.`, { field });
        merged.priceNote ??= priceNote;
        merged.qty += l.qty;
        if (merged.qty > 999) return fail('invalid', 'Quantity must be 1–999.', { field });
        merged.total = merged.qty * (merged.unit ?? 0);
        continue;
      }
      itemAt.set(v.id, out.length);
      firstLine.set(v.id, i + 1);
      out.push({ kind, variantId: v.id, productId: v.product_id, name: displayName(v.name, v.with_comb), pack: v.label, qty: l.qty,
        unit, list: v.price_paise, priceNote, total: l.qty * (unit ?? 0), sort: out.length + 1 });
    } else {
      const name = l.name?.trim() ?? '';
      if (name.length < 1 || name.length > 120) return fail('invalid', 'Write what this line is for.', { field });
      const pack = l.pack?.trim() ?? '';
      if (pack.length > 60) return fail('invalid', 'The pack text is too long.', { field });
      const unit = l.unitPricePaise ?? null;
      if (kind === 'fee' && unit === null) return fail('invalid', 'A charge needs an amount.', { field });
      out.push({ kind, variantId: null, productId: null, name, pack, qty: l.qty, unit, list: null, priceNote, total: l.qty * (unit ?? 0), sort: out.length + 1 });
    }
  }
  return ok(out);
}

/** INSERT of all lines in one statement (json_each), for the order found by `where` (alias o) */
function insertLinesStmt(db: D1, lines: ResolvedLine[], where: Guard): D1Statement {
  const data = JSON.stringify(lines.map((l) => [l.kind, l.variantId, l.productId, l.name, l.pack, l.qty, l.unit, l.list, l.priceNote, l.total, l.sort]));
  const col = (i: number) => `json_extract(j.value, '$[${i}]')`;
  return stmt(db, `INSERT INTO order_lines (order_id, kind, variant_id, product_id, name_snapshot, pack_snapshot, qty, unit_price_paise,
      list_price_paise, price_note, line_total_paise, sort)
    SELECT o.id, ${Array.from({ length: 11 }, (_, i) => col(i)).join(', ')} FROM orders o, json_each(?) j WHERE ${where.sql}`, data, ...where.params);
}

/** UPDATE of the totals after the lines of order `id` changed, guarded by the batch's op token */
function totalsStmt(db: D1, itemsTotal: number, id: number, op: string): D1Statement {
  return stmt(db, `UPDATE orders SET items_total_paise = ?1, total_paise = ?1 - discount_paise + delivery_paise,
      price_mismatch = CASE WHEN shown_total_paise IS NOT NULL AND shown_total_paise <> ?1 THEN 1 ELSE 0 END
    WHERE id = ?2 AND last_op = ?3`, itemsTotal, id, op);
}

const itemsTotalOf = (lines: ResolvedLine[]) => lines.reduce((s, l) => s + l.total, 0);
const lineText = (l: { name: string; pack: string; qty: number }) => `${l.name}${l.pack ? ` ${l.pack}` : ''} × ${l.qty}`;

/** Refusal for an action that would change an invoiced order (items, charges, confirm, spam) */
export const invoicedFailure = (invoiceNo: string): Failure =>
  fail('not_allowed', `Invoice ${invoiceNo} is made for this order, so its items, charges and confirm are fixed. If the order is wrong, cancel it and make a new one.`, { details: { invoiceNo } });

/** The reason a guarded order action changed nothing. `frozenByInvoice`: the action is refused once an invoice number exists. */
async function diagnose(db: D1, id: number, version: number | null, allowed: readonly OrderStatus[], frozenByInvoice = false): Promise<Failure> {
  const o = await first<{ status: OrderStatus; version: number; invoice_no: string | null }>(db, 'SELECT status, version, invoice_no FROM orders WHERE id = ?', id);
  if (!o) return fail('not_found', 'This order does not exist.');
  if (frozenByInvoice && o.invoice_no !== null && allowed.includes(o.status)) return invoicedFailure(o.invoice_no);
  if (!allowed.includes(o.status)) return fail('conflict', `This order is already ${STATUS_WORDS[o.status]}.`, { details: { status: o.status } });
  if (version !== null && o.version !== version) return fail('conflict', 'Someone else changed this order. Reload the page.', { details: { version: o.version } });
  return fail('conflict', 'This order changed. Reload the page.');
}

const okVersion = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/**
 * Replaces all lines of a New order (qty steppers, pack picker, price overrides, custom lines).
 * Lines of an order that is not New never change. Errors: invalid, conflict (status/version), not_found.
 */
export async function saveLines(db: D1, actor: Actor, input: { id: number; version: number; lines: LineInput[] }, at: string = nowIso()): Promise<Result<{ version: number; itemsTotalPaise: number }>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  const resolved = await resolveLines(db, input.lines);
  if (!resolved.ok) return resolved;
  const lines = resolved.value;
  const itemsTotal = itemsTotalOf(lines);
  const cur = await first<{ discount_paise: number; status: OrderStatus }>(db, 'SELECT discount_paise, status FROM orders WHERE id = ?', input.id);
  if (!cur) return fail('not_found', 'This order does not exist.');
  if (cur.status === 'new' && cur.discount_paise > itemsTotal) return fail('invalid', `The discount (${formatINR(cur.discount_paise)}) is more than the items total. Change the discount first.`, { field: 'discountPaise' });
  const op = uuid();
  const by = actor.email;
  const guard = orderOpGuard(input.id, op);
  const before = await all<{ name_snapshot: string; pack_snapshot: string; qty: number; unit_price_paise: number | null }>(db,
    'SELECT name_snapshot, pack_snapshot, qty, unit_price_paise FROM order_lines WHERE order_id = ? ORDER BY sort, id', input.id);
  const res = await tryBatch(db, [
    stmt(db, `UPDATE orders SET version = version + 1, last_op = ?, updated_at = ?, updated_by = ? WHERE id = ? AND version = ? AND status = 'new' AND invoice_no IS NULL`,
      op, at, by, input.id, input.version),
    stmt(db, `DELETE FROM order_lines WHERE order_id = ? AND ${guard.sql}`, input.id, ...guard.params),
    insertLinesStmt(db, lines, { sql: 'o.id = ? AND o.last_op = ?', params: [input.id, op] }),
    totalsStmt(db, itemsTotal, input.id, op),
    auditInsert(db, {
      at, actor, action: 'order.lines', entity: 'order', entityId: input.id,
      summary: `Items changed: ${lines.map(lineText).join(', ')} (${formatINR(itemsTotal)})`,
      before: before.map((l) => ({ name: l.name_snapshot, pack: l.pack_snapshot, qty: l.qty, unit: l.unit_price_paise })),
      after: lines.map((l) => ({ name: l.name, pack: l.pack, qty: l.qty, unit: l.unit })),
    }, guard),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return diagnose(db, input.id, input.version, ['new'], true);
  return ok({ version: input.version + 1, itemsTotalPaise: itemsTotal });
}

// ───────────────────────────── charges, customer ─────────────────────────────

const validMoney = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_PAISE;

/**
 * Delivery charge and discount. Allowed in every status except cancelled and spam (the delivery charge is often
 * known only after confirming). The discount cannot be more than the items total.
 */
export async function saveCharges(db: D1, actor: Actor, input: { id: number; version: number; deliveryPaise: number; discountPaise: number }, at: string = nowIso()): Promise<Result<{ version: number; totalPaise: number }>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  if (!validMoney(input.deliveryPaise)) return fail('invalid', 'The delivery charge must be ₹0 or more.', { field: 'deliveryPaise' });
  if (!validMoney(input.discountPaise)) return fail('invalid', 'The discount must be ₹0 or more.', { field: 'discountPaise' });
  const cur = await first<{ items_total_paise: number; delivery_paise: number; discount_paise: number; ref: string }>(db, 'SELECT items_total_paise, delivery_paise, discount_paise, ref FROM orders WHERE id = ?', input.id);
  if (!cur) return fail('not_found', 'This order does not exist.');
  if (input.discountPaise > cur.items_total_paise) return fail('invalid', `The discount cannot be more than the items total (${formatINR(cur.items_total_paise)}).`, { field: 'discountPaise' });
  const op = uuid();
  const allowed: OrderStatus[] = ['new', 'confirmed', 'packed', 'shipped', 'delivered'];
  const res = await tryBatch(db, [
    stmt(db, `UPDATE orders SET delivery_paise = ?1, discount_paise = ?2, total_paise = items_total_paise - ?2 + ?1, version = version + 1,
        last_op = ?3, updated_at = ?4, updated_by = ?5
      WHERE id = ?6 AND version = ?7 AND status IN ('new', 'confirmed', 'packed', 'shipped', 'delivered') AND ?2 <= items_total_paise
        AND invoice_no IS NULL`,
    input.deliveryPaise, input.discountPaise, op, at, actor.email, input.id, input.version),
    auditInsert(db, {
      at, actor, action: 'order.charges', entity: 'order', entityId: input.id,
      summary: `Delivery ${formatINR(input.deliveryPaise)}, discount ${formatINR(input.discountPaise)}`,
      before: { deliveryPaise: cur.delivery_paise, discountPaise: cur.discount_paise }, after: { deliveryPaise: input.deliveryPaise, discountPaise: input.discountPaise },
    }, orderOpGuard(input.id, op)),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return diagnose(db, input.id, input.version, allowed, true);
  return ok({ version: input.version + 1, totalPaise: cur.items_total_paise - input.discountPaise + input.deliveryPaise });
}

/**
 * "Use customer's prices": the customer saw a lower total than today's prices give, so the difference becomes a
 * discount (New orders only). Clears the price-mismatch flag.
 */
export async function useCustomerPrices(db: D1, actor: Actor, input: { id: number; version: number }, at: string = nowIso()): Promise<Result<{ version: number; discountPaise: number }>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  const cur = await first<{ items_total_paise: number; shown_total_paise: number | null; status: OrderStatus }>(db, 'SELECT items_total_paise, shown_total_paise, status FROM orders WHERE id = ?', input.id);
  if (!cur) return fail('not_found', 'This order does not exist.');
  if (cur.shown_total_paise === null) return fail('invalid', 'This order has no price the customer saw.');
  const discount = cur.items_total_paise - cur.shown_total_paise;
  if (discount <= 0) return fail('invalid', 'The customer saw the same or a higher total; nothing to match.');
  const op = uuid();
  const res = await tryBatch(db, [
    stmt(db, `UPDATE orders SET discount_paise = ?1, total_paise = items_total_paise - ?1 + delivery_paise, price_mismatch = 0,
        version = version + 1, last_op = ?2, updated_at = ?3, updated_by = ?4
      WHERE id = ?5 AND version = ?6 AND status = 'new' AND items_total_paise = ?7 AND shown_total_paise = ?8 AND invoice_no IS NULL`,
    discount, op, at, actor.email, input.id, input.version, cur.items_total_paise, cur.shown_total_paise),
    auditInsert(db, { at, actor, action: 'order.customer_prices', entity: 'order', entityId: input.id, summary: `Matched the customer's total ${formatINR(cur.shown_total_paise)} (discount ${formatINR(discount)})` }, orderOpGuard(input.id, op)),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return diagnose(db, input.id, input.version, ['new'], true);
  return ok({ version: input.version + 1, discountPaise: discount });
}

export interface CustomerInput {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  note?: string | null;
  /** 'YYYY-MM-DD' (gift and bulk requests) */
  neededBy?: string | null;
  isBulk?: boolean;
}

function cleanCustomer(c: CustomerInput): Result<Required<CustomerInput>> {
  const t = (v: string | null | undefined, max: number, field: string): string | null | Failure => {
    const s = (v ?? '').trim().replace(/\s+/g, field === 'address' ? ' ' : ' ');
    if (!s) return null;
    if (s.length > max) return fail('invalid', `Too long (${max} characters at most).`, { field });
    return s;
  };
  const name = t(c.name, 80, 'name'); if (name && typeof name === 'object') return name;
  const phone = t(c.phone, 20, 'phone'); if (phone && typeof phone === 'object') return phone;
  if (typeof phone === 'string' && !/^\+?[0-9][0-9 -]{4,19}$/.test(phone)) return fail('invalid', 'Phone numbers use digits, spaces and + only.', { field: 'phone' });
  const address = t(c.address, 400, 'address'); if (address && typeof address === 'object') return address;
  const city = t(c.city, 60, 'city'); if (city && typeof city === 'object') return city;
  const note = (c.note ?? '').trim() || null;
  if (note && note.length > 1000) return fail('invalid', 'The note is too long (1000 characters at most).', { field: 'note' });
  if (c.neededBy != null && c.neededBy !== '' && !isDate(c.neededBy)) return fail('invalid', 'The date must look like 2026-12-24.', { field: 'neededBy' });
  return ok({ name: name as string | null, phone: phone as string | null, address: address as string | null, city: city as string | null, note, neededBy: c.neededBy || null, isBulk: c.isBulk === true });
}

/** Customer name, phone, address, city, note, needed-by and bulk flag (typed by the owner only; any status) */
export async function saveCustomer(db: D1, actor: Actor, input: { id: number; version: number } & CustomerInput, at: string = nowIso()): Promise<Result<{ version: number }>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  const c = cleanCustomer(input);
  if (!c.ok) return c;
  const v = c.value;
  const op = uuid();
  const res = await tryBatch(db, [
    stmt(db, `UPDATE orders SET customer_name = ?, customer_phone = ?, customer_address = ?, customer_city = ?, note = ?, needed_by = ?, is_bulk = ?,
        version = version + 1, last_op = ?, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`,
    v.name, v.phone, v.address, v.city, v.note, v.neededBy, v.isBulk, op, at, actor.email, input.id, input.version),
    // the audit says what changed, never the personal details themselves
    auditInsert(db, { at, actor, action: 'order.customer', entity: 'order', entityId: input.id, summary: 'Customer details or note changed' }, orderOpGuard(input.id, op)),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return diagnose(db, input.id, input.version, ['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'spam']);
  return ok({ version: input.version + 1 });
}

// ───────────────────────────── payments ─────────────────────────────

export interface PaymentInput {
  /** paise; negative = refund. For "Confirmed & paid" leave out to record the order total. */
  amountPaise?: number;
  method: PaymentMethod;
  reference?: string | null;
  /** 'YYYY-MM-DD' (IST); default today */
  receivedOn?: string;
  /** the form's hidden key: a double submit records one payment */
  idemKey?: string;
}

function checkPayment(p: PaymentInput, needAmount: boolean, at: string): Result<{ amount: number | null; method: PaymentMethod; reference: string | null; receivedOn: string; key: string }> {
  if (!p || !PAYMENT_METHODS.includes(p.method)) return fail('invalid', 'Choose how it was paid.', { field: 'method' });
  if (p.amountPaise === undefined || p.amountPaise === null) {
    if (needAmount) return fail('invalid', 'Enter the amount.', { field: 'amountPaise' });
  } else if (!Number.isSafeInteger(p.amountPaise) || p.amountPaise === 0 || Math.abs(p.amountPaise) > MAX_PAISE) {
    return fail('invalid', 'Enter the amount (a refund is a minus amount).', { field: 'amountPaise' });
  }
  const reference = p.reference?.trim() || null;
  if (reference && reference.length > 60) return fail('invalid', 'The reference is too long (60 characters at most).', { field: 'reference' });
  const receivedOn = p.receivedOn || istDate(at);
  if (!isDate(receivedOn)) return fail('invalid', 'The date must look like 2026-11-15.', { field: 'receivedOn' });
  return ok({ amount: p.amountPaise ?? null, method: p.method, reference, receivedOn, key: `pay:${p.idemKey || uuid()}` });
}

const METHOD_WORDS: Record<PaymentMethod, string> = { upi: 'UPI', cash: 'cash', bank: 'bank transfer', card: 'card', other: 'other' };

/**
 * "Mark paid": adds a payment (or a refund, negative) and refreshes the paid cache. Any status except spam.
 * A refund cannot take the paid total below zero. A repeated idemKey is accepted once (duplicate: true).
 */
export async function addPayment(db: D1, actor: Actor, input: { id: number } & PaymentInput, at: string = nowIso()): Promise<Result<{ paidPaise: number; balancePaise: number; duplicate: boolean }>> {
  const p = checkPayment(input, true, at);
  if (!p.ok) return p;
  const { amount, method, reference, receivedOn, key } = p.value;
  const ref = await first<{ ref: string }>(db, 'SELECT ref FROM orders WHERE id = ?', input.id);
  if (!ref) return fail('not_found', 'This order does not exist.');
  const res = await tryBatch(db, [
    stmt(db, `INSERT INTO payments (order_id, amount_paise, method, reference, received_on, idem_key, created_at, created_by)
      SELECT o.id, ?1, ?2, ?3, ?4, ?5, ?6, ?7 FROM orders o
       WHERE o.id = ?8 AND o.status <> 'spam' AND (?1 > 0 OR o.paid_paise + ?1 >= 0)
      ON CONFLICT(idem_key) DO NOTHING`, amount, method, reference, receivedOn, key, at, actor.email, input.id),
    stmt(db, 'UPDATE orders SET paid_paise = (SELECT COALESCE(SUM(amount_paise), 0) FROM payments WHERE order_id = orders.id), updated_at = ? WHERE id = ?', at, input.id),
    auditInsert(db, {
      at, actor, action: amount! < 0 ? 'order.refund' : 'order.pay', entity: 'order', entityId: input.id,
      summary: `${amount! < 0 ? 'Refund' : 'Payment'} ${formatINR(Math.abs(amount!))} by ${METHOD_WORDS[method]}${reference ? ` (${reference})` : ''} on ${ref.ref}`,
    }, { sql: 'EXISTS (SELECT 1 FROM payments WHERE idem_key = ? AND created_at = ? AND created_by = ?)', params: [key, at, actor.email] }),
    stmt(db, 'SELECT o.paid_paise, o.total_paise, o.status, (SELECT created_at FROM payments WHERE idem_key = ?) AS pay_at FROM orders o WHERE o.id = ?', key, input.id),
  ]);
  if (!res.ok) return res;
  const after = res.value[3].results[0] as { paid_paise: number; total_paise: number; status: OrderStatus; pay_at: string | null };
  if (res.value[0].meta.changes !== 1) {
    if (after.pay_at) return ok({ paidPaise: after.paid_paise, balancePaise: after.total_paise - after.paid_paise, duplicate: true });
    if (after.status === 'spam') return fail('conflict', 'This order is marked as not a real order.');
    return fail('invalid', `A refund cannot be more than what was paid (${formatINR(after.paid_paise)}).`, { field: 'amountPaise' });
  }
  return ok({ paidPaise: after.paid_paise, balancePaise: after.total_paise - after.paid_paise, duplicate: false });
}

// ───────────────────────────── confirm, undo, cancel ─────────────────────────────

export interface NegativeStock { poolId: number; name: string; onHand: number; amountText: string }

export interface ConfirmDone {
  version: number;
  confirmNo: number;
  /** tracked pools that went below zero ("Stock is now −0.5 kg for Murungai Honey, recount soon"); never blocks */
  negative: NegativeStock[];
  /** payment recorded with "Confirmed & paid" */
  paidPaise: number;
  effects: Effects;
}

type Pre = { status: OrderStatus; version: number; confirm_no: number; total_paise: number; ref: string };

/** Lines with their pool, for the stock forecast (one read batch) */
async function readForConfirm(db: D1, id: number) {
  const [oRes, lRes] = await db.batch([
    stmt(db, 'SELECT status, version, confirm_no, total_paise, ref FROM orders WHERE id = ?', id),
    stmt(db, `SELECT l.kind, l.name_snapshot, l.pack_snapshot, l.qty, l.unit_price_paise, v.pool_id, v.pool_qty
      FROM order_lines l LEFT JOIN variants v ON v.id = l.variant_id WHERE l.order_id = ? ORDER BY l.sort, l.id`, id),
  ]);
  return {
    order: oRes.results[0] as unknown as Pre | undefined,
    lines: lRes.results as unknown as { kind: LineKind; name_snapshot: string; pack_snapshot: string; qty: number; unit_price_paise: number | null; pool_id: number | null; pool_qty: number | null }[],
  };
}

/**
 * Confirm (or "Confirmed & paid" with `paid`): status New → Confirmed, confirm_no + 1, one 'sale' move per pool,
 * pools recomputed, the lines' pack weights copied (order_lines.net_grams), optional payment, audit — one guarded
 * batch (design §3.4, A3). Never blocked by stock.
 * Errors: not_found; conflict (already confirmed / cancelled / spam, or the version changed); invalid (no lines);
 * needs_price (details: the lines without a price, e.g. ['Forest Coffee Honey with comb 250 g']).
 */
export async function confirmOrder(db: D1, actor: Actor, input: { id: number; version: number; paid?: PaymentInput }, at: string = nowIso()): Promise<Result<ConfirmDone>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  const pay = input.paid ? checkPayment(input.paid, false, at) : null;
  if (pay && !pay.ok) return pay;
  const { order, lines } = await readForConfirm(db, input.id);
  if (!order) return fail('not_found', 'This order does not exist.');
  if (order.status !== 'new') return fail('conflict', `This order is already ${STATUS_WORDS[order.status]}.`, { details: { status: order.status } });
  if (order.version !== input.version) return fail('conflict', 'Someone else changed this order. Reload the page.');
  if (!lines.length) return fail('invalid', 'Add at least one item before confirming.');
  const unpriced = lines.filter((l) => l.unit_price_paise === null);
  if (unpriced.length) {
    const names = unpriced.map((l) => `${l.name_snapshot}${l.pack_snapshot ? ` ${l.pack_snapshot}` : ''}`);
    return fail('needs_price', `Add a price for ${names.join(', ')} first.`, { details: names });
  }

  const deltas = new Map<number, PoolChange>();
  for (const l of lines) {
    if (l.kind !== 'item' || l.pool_id === null) continue;
    deltas.set(l.pool_id, { delta: (deltas.get(l.pool_id)?.delta ?? 0) - l.qty * l.pool_qty! });
  }
  const forecast = await forecastStatusChange(db, deltas);
  const poolIds = [...deltas.keys()];
  const op = uuid();
  const by = actor.email;
  const guard = orderOpGuard(input.id, op);

  const statements: D1Statement[] = [
    stmt(db, `UPDATE orders SET status = 'confirmed', confirmed_at = ?1, confirm_no = confirm_no + 1, version = version + 1, last_op = ?2,
        updated_at = ?1, updated_by = ?3
      WHERE id = ?4 AND status = 'new' AND version = ?5
        AND EXISTS (SELECT 1 FROM order_lines WHERE order_id = ?4)
        AND NOT EXISTS (SELECT 1 FROM order_lines WHERE order_id = ?4 AND unit_price_paise IS NULL)`, at, op, by, input.id, input.version),
    stmt(db, `INSERT INTO stock_moves (pool_id, delta, reason, order_id, idem_key, note, created_at, created_by)
      SELECT v.pool_id, -SUM(l.qty * v.pool_qty), 'sale', o.id, 'sale:' || o.id || ':' || o.confirm_no || ':' || v.pool_id, NULL, ?1, ?2
        FROM order_lines l JOIN variants v ON v.id = l.variant_id JOIN orders o ON o.id = l.order_id
       WHERE l.order_id = ?3 AND l.kind = 'item' AND o.last_op = ?4
       GROUP BY v.pool_id`, at, by, input.id, op),
    recomputePoolsStmt(db, poolIds, guard),
    // the pack weights as sold (kg sold in Sales stays right when a pack's weight is edited later)
    stmt(db, `UPDATE order_lines SET net_grams = (SELECT v.net_grams FROM variants v WHERE v.id = order_lines.variant_id)
      WHERE order_id = ? AND kind = 'item' AND ${guard.sql}`, input.id, ...guard.params),
  ];
  if (pay?.ok) {
    const p = pay.value;
    statements.push(
      stmt(db, `INSERT INTO payments (order_id, amount_paise, method, reference, received_on, idem_key, created_at, created_by)
        SELECT o.id, COALESCE(?1, o.total_paise), ?2, ?3, ?4, ?5, ?6, ?7 FROM orders o
         WHERE o.id = ?8 AND o.last_op = ?9 AND COALESCE(?1, o.total_paise) <> 0`,
      p.amount, p.method, p.reference, p.receivedOn, p.key, at, by, input.id, op),
      stmt(db, `UPDATE orders SET paid_paise = (SELECT COALESCE(SUM(amount_paise), 0) FROM payments WHERE order_id = orders.id)
        WHERE id = ? AND last_op = ?`, input.id, op),
    );
  }
  if (forecast.changed) statements.push(...stockStatusStatements(db, at, by, guard));
  statements.push(auditInsert(db, {
    at, actor, action: pay ? 'order.confirm_paid' : 'order.confirm', entity: 'order', entityId: input.id,
    summary: `Confirmed ${order.ref} (${formatINR(order.total_paise)})${pay ? ' and marked paid' : ''}`,
  }, guard));
  statements.push(stmt(db, `SELECT s.id, s.name, s.unit, s.on_hand, s.track_stock FROM stock_pools s WHERE s.id IN (SELECT value FROM json_each(?))`, JSON.stringify(poolIds)));
  statements.push(stmt(db, 'SELECT confirm_no, paid_paise FROM orders WHERE id = ?', input.id));

  const res = await tryBatch(db, statements);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) {
    const d = await readForConfirm(db, input.id);
    if (d.order && d.order.status === 'new' && d.order.version === input.version && d.lines.some((l) => l.unit_price_paise === null)) {
      const names = d.lines.filter((l) => l.unit_price_paise === null).map((l) => `${l.name_snapshot}${l.pack_snapshot ? ` ${l.pack_snapshot}` : ''}`);
      return fail('needs_price', `Add a price for ${names.join(', ')} first.`, { details: names });
    }
    return diagnose(db, input.id, input.version, ['new']);
  }
  const pools = res.value[res.value.length - 2].results as { id: number; name: string; unit: PoolUnit; on_hand: number; track_stock: number }[];
  const after = res.value[res.value.length - 1].results[0] as { confirm_no: number; paid_paise: number };
  return ok({
    version: input.version + 1,
    confirmNo: after.confirm_no,
    negative: pools.filter((p) => p.track_stock === 1 && p.on_hand < 0).map((p) => ({ poolId: p.id, name: p.name, onHand: p.on_hand, amountText: formatPoolAmount(p.on_hand, p.unit) })),
    paidPaise: after.paid_paise,
    effects: { publish: forecast.changed ? 'scheduled' : null, live: forecast.changed },
  });
}

/** Sale moves of the order's current confirm that are not reversed yet */
async function openSales(db: D1, id: number): Promise<{ id: number; pool_id: number; delta: number }[]> {
  return all(db, `SELECT m.id, m.pool_id, m.delta FROM stock_moves m JOIN orders o ON o.id = m.order_id
    WHERE m.order_id = ? AND m.reason = 'sale' AND m.idem_key LIKE 'sale:' || o.id || ':' || o.confirm_no || ':%'
      AND NOT EXISTS (SELECT 1 FROM stock_moves r WHERE r.idem_key = 'rev:' || m.id)`, id);
}

/** INSERT of the reversals of the current confirm's sales (guarded; each sale reversed at most once) */
function reversalStmt(db: D1, id: number, op: string, at: string, by: string, note: string): D1Statement {
  return stmt(db, `INSERT INTO stock_moves (pool_id, delta, reason, order_id, idem_key, note, created_at, created_by)
    SELECT m.pool_id, -m.delta, 'sale_reversal', m.order_id, 'rev:' || m.id, ?1, ?2, ?3
      FROM stock_moves m JOIN orders o ON o.id = m.order_id
     WHERE m.order_id = ?4 AND m.reason = 'sale' AND o.last_op = ?5
       AND m.idem_key LIKE 'sale:' || o.id || ':' || o.confirm_no || ':%'
       AND NOT EXISTS (SELECT 1 FROM stock_moves r WHERE r.idem_key = 'rev:' || m.id)`, note, at, by, id, op);
}

/**
 * "Undo confirm" while still Confirmed: reversal moves, back to New (confirmed_at cleared). A later confirm uses
 * the next confirm_no, so its sale keys are new. Payments stay.
 */
export async function undoConfirm(db: D1, actor: Actor, input: { id: number; version: number }, at: string = nowIso()): Promise<Result<{ version: number; effects: Effects }>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  const sales = await openSales(db, input.id);
  const changes = new Map<number, PoolChange>(sales.map((s) => [s.pool_id, { delta: -s.delta }]));
  const forecast = await forecastStatusChange(db, changes);
  const op = uuid();
  const by = actor.email;
  const guard = orderOpGuard(input.id, op);
  const ref = await first<{ ref: string }>(db, 'SELECT ref FROM orders WHERE id = ?', input.id);
  const res = await tryBatch(db, [
    stmt(db, `UPDATE orders SET status = 'new', confirmed_at = NULL, packed_at = NULL, version = version + 1, last_op = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND status = 'confirmed' AND version = ? AND invoice_no IS NULL`, op, at, by, input.id, input.version),
    reversalStmt(db, input.id, op, at, by, 'Undo confirm'),
    recomputePoolsStmt(db, [...changes.keys()], guard),
    ...(forecast.changed ? stockStatusStatements(db, at, by, guard) : []),
    auditInsert(db, { at, actor, action: 'order.undo_confirm', entity: 'order', entityId: input.id, summary: `Undid confirm of ${ref?.ref ?? `order ${input.id}`}; stock put back` }, guard),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return diagnose(db, input.id, input.version, TRANSITIONS.undo_confirm, true);
  return ok({ version: input.version + 1, effects: { publish: forecast.changed ? 'scheduled' : null, live: forecast.changed } });
}

/**
 * Cancel. From New: no stock effect. From Confirmed or Packed: stock goes back automatically.
 * From Sent or Delivered: `restock` must say whether the jars came back (else 'needs_restock_answer').
 * Cancelling twice changes nothing the second time (status/version guard; each sale is reversed at most once).
 */
export async function cancelOrder(db: D1, actor: Actor, input: { id: number; version: number; reason?: string | null; restock?: boolean }, at: string = nowIso()): Promise<Result<{ version: number; restocked: boolean; effects: Effects }>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > 200) return fail('invalid', 'The reason is too long (200 characters at most).', { field: 'reason' });
  const cur = await first<{ status: OrderStatus; ref: string }>(db, 'SELECT status, ref FROM orders WHERE id = ?', input.id);
  if (!cur) return fail('not_found', 'This order does not exist.');
  if (!(TRANSITIONS.cancel as readonly string[]).includes(cur.status)) return fail('conflict', `This order is already ${STATUS_WORDS[cur.status]}.`);
  let restock = false;
  if (cur.status === 'confirmed' || cur.status === 'packed') restock = true;
  else if (cur.status === 'shipped' || cur.status === 'delivered') {
    if (typeof input.restock !== 'boolean') return fail('needs_restock_answer', 'Did the jars come back to stock?', { field: 'restock' });
    restock = input.restock;
  }
  // the guard repeats the status seen here, so the restock decision always matches the order's state
  const sales = restock ? await openSales(db, input.id) : [];
  const changes = new Map<number, PoolChange>(sales.map((s) => [s.pool_id, { delta: -s.delta }]));
  const forecast = await forecastStatusChange(db, changes);
  const op = uuid();
  const by = actor.email;
  const guard = orderOpGuard(input.id, op);
  const statements: D1Statement[] = [
    stmt(db, `UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, version = version + 1, last_op = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND version = ? AND status = ?`, at, reason, op, at, by, input.id, input.version, cur.status),
  ];
  if (restock) statements.push(reversalStmt(db, input.id, op, at, by, 'Order cancelled'), recomputePoolsStmt(db, [...changes.keys()], guard));
  if (forecast.changed) statements.push(...stockStatusStatements(db, at, by, guard));
  statements.push(auditInsert(db, {
    at, actor, action: 'order.cancel', entity: 'order', entityId: input.id,
    summary: `Cancelled ${cur.ref}${reason ? `: ${reason}` : ''}${restock && sales.length ? '; stock put back' : ''}`,
  }, guard));
  const res = await tryBatch(db, statements);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return diagnose(db, input.id, input.version, [cur.status]);
  return ok({ version: input.version + 1, restocked: restock && sales.length > 0, effects: { publish: forecast.changed ? 'scheduled' : null, live: forecast.changed } });
}

/** Fulfilment steps: Packed, Sent (optional courier/tracking note), Delivered. Steps can be skipped. */
export async function advanceOrder(db: D1, actor: Actor, input: { id: number; version: number; to: 'packed' | 'shipped' | 'delivered'; note?: string | null }, at: string = nowIso()): Promise<Result<{ version: number }>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  const steps = { packed: { from: TRANSITIONS.pack, col: 'packed_at', word: 'Packed' }, shipped: { from: TRANSITIONS.ship, col: 'shipped_at', word: 'Sent' }, delivered: { from: TRANSITIONS.deliver, col: 'delivered_at', word: 'Delivered' } } as const;
  const step = steps[input.to];
  if (!step) return fail('invalid', 'Unknown step.');
  const note = input.note?.trim() || null;
  if (note && note.length > 200) return fail('invalid', 'The note is too long (200 characters at most).', { field: 'note' });
  const op = uuid();
  const ref = await first<{ ref: string }>(db, 'SELECT ref FROM orders WHERE id = ?', input.id);
  const res = await tryBatch(db, [
    stmt(db, `UPDATE orders SET status = ?, ${step.col} = ?, note = CASE WHEN ? IS NULL THEN note ELSE trim(COALESCE(note || char(10), '') || ?) END,
        version = version + 1, last_op = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND version = ? AND status IN (${step.from.map(() => '?').join(', ')})`,
    input.to, at, note, note ? `${step.word}: ${note}` : null, op, at, actor.email, input.id, input.version, ...step.from),
    auditInsert(db, { at, actor, action: `order.${input.to}`, entity: 'order', entityId: input.id, summary: `${step.word}: ${ref?.ref ?? input.id}${note ? ` (${note})` : ''}` }, orderOpGuard(input.id, op)),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return diagnose(db, input.id, input.version, step.from);
  return ok({ version: input.version + 1 });
}

/** "Not a real order" (New only): status spam; `test: true` also marks it as a test order (A4 rehearsal) */
export async function markSpam(db: D1, actor: Actor, input: { id: number; version: number; test?: boolean }, at: string = nowIso()): Promise<Result<{ version: number }>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  const op = uuid();
  const res = await tryBatch(db, [
    stmt(db, `UPDATE orders SET status = 'spam', is_test = CASE WHEN ? THEN 1 ELSE is_test END, version = version + 1, last_op = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND version = ? AND status = 'new' AND invoice_no IS NULL`, input.test === true, op, at, actor.email, input.id, input.version),
    auditInsert(db, { at, actor, action: 'order.spam', entity: 'order', entityId: input.id, summary: input.test ? 'Marked as a test order' : 'Marked as not a real order' }, orderOpGuard(input.id, op)),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return diagnose(db, input.id, input.version, TRANSITIONS.mark_spam, true);
  return ok({ version: input.version + 1 });
}

/** Spam → New (also clears the test mark) */
export async function restoreOrder(db: D1, actor: Actor, input: { id: number; version: number }, at: string = nowIso()): Promise<Result<{ version: number }>> {
  if (!okVersion(input?.version)) return fail('invalid', 'Reload the page and try again.');
  const op = uuid();
  const res = await tryBatch(db, [
    stmt(db, `UPDATE orders SET status = 'new', is_test = 0, version = version + 1, last_op = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND version = ? AND status = 'spam'`, op, at, actor.email, input.id, input.version),
    auditInsert(db, { at, actor, action: 'order.restore', entity: 'order', entityId: input.id, summary: 'Restored as a real order' }, orderOpGuard(input.id, op)),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return diagnose(db, input.id, input.version, TRANSITIONS.restore);
  return ok({ version: input.version + 1 });
}

/** Marks or unmarks any order as a test order (rehearsal, A4). Test orders never count as sales. */
export async function setTestFlag(db: D1, actor: Actor, input: { id: number; version: number; isTest: boolean }, at: string = nowIso()): Promise<Result<{ version: number }>> {
  if (!okVersion(input?.version) || typeof input.isTest !== 'boolean') return fail('invalid', 'Reload the page and try again.');
  const op = uuid();
  const res = await tryBatch(db, [
    stmt(db, `UPDATE orders SET is_test = ?, version = version + 1, last_op = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND version = ? AND (invoice_no IS NULL OR ? = 0)`, input.isTest, op, at, actor.email, input.id, input.version, input.isTest),
    auditInsert(db, { at, actor, action: 'order.test', entity: 'order', entityId: input.id, summary: input.isTest ? 'Marked as a test order' : 'No longer a test order' }, orderOpGuard(input.id, op)),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) {
    const inv = await first<{ invoice_no: string | null }>(db, 'SELECT invoice_no FROM orders WHERE id = ?', input.id);
    if (inv?.invoice_no && input.isTest) return fail('not_allowed', 'An order with an invoice number cannot become a test order.');
    return diagnose(db, input.id, input.version, ['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'spam']);
  }
  return ok({ version: input.version + 1 });
}

/** Gift / bulk request: ticks "Replied" (or clears it) */
export async function markReplied(db: D1, actor: Actor, input: { id: number; replied: boolean }, at: string = nowIso()): Promise<Result<{ repliedAt: string | null }>> {
  const repliedAt = input?.replied ? at : null;
  const res = await batch(db, [
    stmt(db, 'UPDATE orders SET replied_at = ?, updated_at = ?, updated_by = ? WHERE id = ?', repliedAt, at, actor.email, input.id),
    auditInsert(db, { at, actor, action: 'order.replied', entity: 'order', entityId: input.id, summary: input.replied ? 'Marked as replied' : 'Reply mark removed' },
      { sql: 'EXISTS (SELECT 1 FROM orders WHERE id = ?)', params: [input.id] }),
  ]);
  if (res[0].meta.changes !== 1) return fail('not_found', 'This order does not exist.');
  return ok({ repliedAt });
}

// ───────────────────────────── creating orders ─────────────────────────────

export interface ManualOrderInput {
  channel: OrderChannel;
  lines: LineInput[];
  deliveryPaise?: number;
  discountPaise?: number;
  customer?: CustomerInput;
  /** a code the customer quoted; a new one is made otherwise */
  ref?: string | null;
  /** 'confirmed' saves and confirms (stock goes down); default 'new' */
  status?: 'new' | 'confirmed';
  /** with status 'confirmed': also record a payment ("Confirmed & paid") */
  paid?: PaymentInput;
  isTest?: boolean;
  /** the form's hidden key: a double submit makes one order */
  idemKey?: string;
}

export interface CreatedOrder {
  id: number;
  ref: string;
  /** the same idemKey was used before: this is the order made then */
  duplicate: boolean;
  /** set when status 'confirmed' was asked for and the confirm did not go through (the order stays New) */
  confirmError?: Failure;
  confirm?: ConfirmDone;
}

async function createOrder(db: D1, actor: Actor, o: {
  source: 'manual' | 'pasted'; channel: OrderChannel; lines: LineInput[]; deliveryPaise: number; discountPaise: number;
  customer: CustomerInput; ref: string; shownTotalPaise: number | null; gift: GiftDetails | null; isBulk: boolean; isTest: boolean;
  idemKey?: string; auditSummary: string; action: string;
}, at: string): Promise<Result<{ id: number; ref: string; duplicate: boolean }>> {
  if (!isRef(o.ref)) return fail('invalid', 'The order code must look like BZ-7K3QD.', { field: 'ref' });
  if (!validMoney(o.deliveryPaise)) return fail('invalid', 'The delivery charge must be ₹0 or more.', { field: 'deliveryPaise' });
  if (!validMoney(o.discountPaise)) return fail('invalid', 'The discount must be ₹0 or more.', { field: 'discountPaise' });
  const resolved = await resolveLines(db, o.lines);
  if (!resolved.ok) return resolved;
  const lines = resolved.value;
  const itemsTotal = itemsTotalOf(lines);
  if (o.discountPaise > itemsTotal) return fail('invalid', `The discount cannot be more than the items total (${formatINR(itemsTotal)}).`, { field: 'discountPaise' });
  const c = cleanCustomer(o.customer);
  if (!c.ok) return c;
  const cu = c.value;
  // The form key is stored in orders.create_key (UNIQUE), so a repeated submit finds the order it made even after
  // that order was edited or confirmed; the op token marks the rows this batch made.
  const createKey = o.idemKey ? `new:${o.idemKey}`.slice(0, 100) : null;
  if (createKey !== null && createKey.length < 8) return fail('invalid', 'Reload the page and try again.');
  const op = uuid();
  const by = actor.email;
  const res = await tryBatch(db, [
    stmt(db, `INSERT INTO orders (ref, client_key, create_key, source, channel, status, is_test, items_total_paise, delivery_paise, discount_paise,
        total_paise, shown_total_paise, price_mismatch, gift_json, is_bulk, needed_by, customer_name, customer_phone, customer_address,
        customer_city, note, created_at, updated_at, updated_by, version, last_op)
      VALUES (?, NULL, ?, ?, ?, 'new', ?, 0, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(create_key) DO NOTHING`,
    o.ref, createKey, o.source, o.channel, o.isTest, o.deliveryPaise, o.deliveryPaise, o.shownTotalPaise, o.gift ? JSON.stringify(o.gift) : null,
    o.isBulk || cu.isBulk, cu.neededBy ?? o.gift?.neededBy ?? null, cu.name, cu.phone, cu.address, cu.city, cu.note, at, at, by, op),
    insertLinesStmt(db, lines, { sql: 'o.last_op = ?', params: [op] }),
    stmt(db, `UPDATE orders SET items_total_paise = ?1, discount_paise = ?2, total_paise = ?1 - ?2 + delivery_paise,
        price_mismatch = CASE WHEN shown_total_paise IS NOT NULL AND shown_total_paise <> ?1 THEN 1 ELSE 0 END
      WHERE last_op = ?3`, itemsTotal, o.discountPaise, op),
    // audit row keyed by the new order's id (only when this batch made the order)
    stmt(db, `INSERT INTO audit_log (at, actor, action, entity, entity_id, summary)
      SELECT ?, ?, ?, 'order', CAST(id AS TEXT), ? FROM orders WHERE last_op = ?`,
    at, by, o.action, o.auditSummary.slice(0, 500), op),
    createKey !== null
      ? stmt(db, 'SELECT id, ref FROM orders WHERE create_key = ?', createKey)
      : stmt(db, 'SELECT id, ref FROM orders WHERE last_op = ?', op),
  ]);
  if (!res.ok) return res;
  const made = res.value[4].results[0] as { id: number; ref: string } | undefined;
  if (!made) return fail('conflict', 'This order could not be saved. Reload the page.');
  return ok({ id: made.id, ref: made.ref, duplicate: res.value[0].meta.changes !== 1 });
}

/**
 * New order typed by the owner (phone, farm gate, WhatsApp chat): channel, lines with today's prices or overrides,
 * charges, customer. With status 'confirmed' it is confirmed right after (and `paid` records a payment).
 */
export async function createManualOrder(db: D1, actor: Actor, input: ManualOrderInput, at: string = nowIso()): Promise<Result<CreatedOrder>> {
  if (!input || !MANUAL_CHANNELS.includes(input.channel)) return fail('invalid', 'Choose how the order came in.', { field: 'channel' });
  let ref = newRef();
  if (input.ref?.trim()) {
    const code = normaliseRefQuery(input.ref);
    if (!code || code.length !== 5) return fail('invalid', 'The order code must look like BZ-7K3QD.', { field: 'ref' });
    ref = `${REF_PREFIX}${code}`;
  }
  const made = await createOrder(db, actor, {
    source: 'manual', channel: input.channel, lines: input.lines, deliveryPaise: input.deliveryPaise ?? 0, discountPaise: input.discountPaise ?? 0,
    customer: input.customer ?? {}, ref, shownTotalPaise: null, gift: null, isBulk: false, isTest: input.isTest === true, idemKey: input.idemKey,
    action: 'order.create', auditSummary: `New ${input.channel.replace('_', ' ')} order ${ref}`,
  }, at);
  if (!made.ok) return made;
  const out: CreatedOrder = { ...made.value };
  if (input.status === 'confirmed' && !made.value.duplicate) {
    const c = await confirmOrder(db, actor, { id: made.value.id, version: 1, paid: input.paid }, at);
    if (c.ok) out.confirm = c.value; else out.confirmError = c;
  }
  return ok(out);
}

/** The parsed WhatsApp message (parseOrderMessage() in src/lib/orderMessage.ts returns a compatible object) */
export interface PastedOrderInput {
  kind?: 'order' | 'gift';
  ref?: string | null;
  lines: { name: string; pack: string; qty: number; unitPaise?: number | null; linePaise?: number | null }[];
  totalPaise?: number | null;
  /** the message says "Total so far": some lines had no price, so the total is not what the customer will pay */
  totalSoFar?: boolean;
  gift?: { size?: number | null; jar?: string | null; boxes?: number | null; picks?: string[]; extras?: string[]; occasion?: string | null; neededBy?: string | null; card?: string | null } | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const normPack = (s: string) => norm(s).replace(/\s+/g, '');

/**
 * "Paste WhatsApp order": rebuilds an order whose record went missing (source 'pasted', channel whatsapp).
 * Product names and packs are matched to the catalog (unknown ones become custom lines). Prices come from D1;
 * with `useMessagePrices` the amounts written in the message are used instead. The message total is stored as
 * what the customer saw (price mismatch flag), except a "Total so far" (some lines had no price), which is not stored. If an order with the same code exists, returns 'conflict' with
 * details [{ id, status, createdAt }] unless `force`.
 */
export async function createFromPasted(db: D1, actor: Actor, input: PastedOrderInput, opts: { useMessagePrices?: boolean; force?: boolean; idemKey?: string } = {}, at: string = nowIso()): Promise<Result<CreatedOrder & { unmatched: string[] }>> {
  if (!input || !Array.isArray(input.lines) || !input.lines.length) return fail('invalid', 'No order lines were found in the message.');
  const ref = input.ref && isRef(input.ref) ? input.ref : newRef();
  if (input.ref && isRef(input.ref) && !opts.force) {
    const same = await all<{ id: number; status: OrderStatus; created_at: string }>(db, 'SELECT id, status, created_at FROM orders WHERE ref = ? ORDER BY id DESC LIMIT 5', input.ref);
    if (same.length) return fail('conflict', `An order with code ${input.ref} is already saved. Open it, or save this one anyway.`, { details: same.map((s) => ({ id: s.id, status: s.status, createdAt: s.created_at })) });
  }
  const catalog = await all<{ id: number; label: string; name: string; with_comb: number }>(db,
    "SELECT v.id, v.label, p.name, p.with_comb FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status <> 'draft'");
  const unmatched: string[] = [];
  const lines: LineInput[] = input.lines.map((l) => {
    const name = norm(String(l.name ?? ''));
    const v = catalog.find((c) => (norm(c.name) === name || norm(displayName(c.name, c.with_comb)) === name || norm(`${c.name} with comb`) === name) && normPack(c.label) === normPack(String(l.pack ?? '')));
    const msgUnit = l.unitPaise ?? (l.linePaise != null && l.qty > 0 && l.linePaise % l.qty === 0 ? l.linePaise / l.qty : null);
    if (v) return { kind: 'item', variantId: v.id, qty: l.qty, ...(opts.useMessagePrices && msgUnit !== null ? { unitPricePaise: msgUnit } : {}) };
    unmatched.push(`${l.name} ${l.pack}`.trim());
    return { kind: 'custom', name: String(l.name ?? '').slice(0, 120) || 'Item', pack: String(l.pack ?? '').slice(0, 60), qty: l.qty, unitPricePaise: msgUnit };
  });
  let gift: GiftDetails | null = null;
  let isBulk = false;
  if (input.kind === 'gift' && input.gift) {
    const g = input.gift;
    gift = { size: g.size ?? null, jar: g.jar ?? null, picks: g.picks ?? [], extras: g.extras ?? [], boxes: g.boxes ?? null, occasion: g.occasion ?? null, neededBy: g.neededBy && isDate(g.neededBy) ? g.neededBy : null, card: g.card ?? null };
    const bulkFrom = await first<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'gift'");
    const from = bulkFrom ? (JSON.parse(bulkFrom.value) as { bulkFrom: number }).bulkFrom : 20;
    isBulk = (gift.boxes ?? 0) >= from;
  }
  const made = await createOrder(db, actor, {
    source: 'pasted', channel: 'whatsapp', lines, deliveryPaise: 0, discountPaise: 0, customer: { neededBy: gift?.neededBy ?? null },
    ref, shownTotalPaise: input.totalSoFar ? null : input.totalPaise ?? null, gift, isBulk, isTest: false, idemKey: opts.idemKey,
    action: 'order.paste', auditSummary: `Order ${ref} rebuilt from a WhatsApp message${unmatched.length ? ` (${unmatched.length} line(s) not matched)` : ''}`,
  }, at);
  if (!made.ok) return made;
  return ok({ ...made.value, unmatched });
}

/** "Duplicate": a new manual order with the same items (today's prices), customer and delivery charge */
export async function duplicateOrder(db: D1, actor: Actor, input: { id: number; idemKey?: string }, at: string = nowIso()): Promise<Result<CreatedOrder>> {
  const d = await getOrder(db, input?.id);
  if (!d) return fail('not_found', 'This order does not exist.');
  const o = d.order;
  return createManualOrder(db, actor, {
    channel: o.channel === 'website' ? 'whatsapp' : o.channel,
    lines: d.lines.map((l) => (l.kind === 'item' ? { kind: 'item', variantId: l.variantId, qty: l.qty } : { kind: l.kind, name: l.name, pack: l.pack, qty: l.qty, unitPricePaise: l.unitPricePaise })),
    deliveryPaise: o.deliveryPaise,
    customer: { ...o.customer, note: null },
    isTest: o.isTest,
    idemKey: input.idemKey,
  }, at);
}

// ───────────────────────────── invoices, test data ─────────────────────────────

/**
 * Gives a sold order its invoice number 'BZ/2026-27/0001': gapless per financial year (IST date of `at`).
 * Counter and order change in one batch, so a number is used only if the order gets it. Test orders get none.
 */
export async function assignInvoiceNo(db: D1, actor: Actor, input: { id: number }, at: string = nowIso()): Promise<Result<{ invoiceNo: string; already: boolean }>> {
  const fy = fyLabel(fyStartYear(istDate(at)));
  const counter = `invoice:${fy}`;
  const qualifies = `id = ?2 AND invoice_no IS NULL AND is_test = 0 AND status IN ('confirmed', 'packed', 'shipped', 'delivered')`;
  const res = await batch(db, [
    stmt(db, 'INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', counter),
    stmt(db, `UPDATE counters SET value = value + 1 WHERE name = ?1 AND EXISTS (SELECT 1 FROM orders WHERE ${qualifies})`, counter, input.id),
    stmt(db, `UPDATE orders SET invoice_no = ?3 || printf('%04d', (SELECT value FROM counters WHERE name = ?1)), invoiced_at = ?4, version = version + 1,
        updated_at = ?4, updated_by = ?5 WHERE ${qualifies}`, counter, input.id, `BZ/${fy}/`, at, actor.email),
    auditInsert(db, { at, actor, action: 'order.invoice', entity: 'order', entityId: input.id, summary: 'Invoice number given' },
      { sql: 'EXISTS (SELECT 1 FROM orders WHERE id = ? AND invoiced_at = ? AND updated_by = ?)', params: [input.id, at, actor.email] }),
    stmt(db, 'SELECT invoice_no, status, is_test FROM orders WHERE id = ?', input.id),
  ]);
  const o = res[4].results[0] as { invoice_no: string | null; status: OrderStatus; is_test: number } | undefined;
  if (!o) return fail('not_found', 'This order does not exist.');
  if (res[2].meta.changes === 1) return ok({ invoiceNo: o.invoice_no!, already: false });
  if (o.invoice_no) return ok({ invoiceNo: o.invoice_no, already: true });
  if (o.is_test === 1) return fail('not_allowed', 'Test orders do not get invoice numbers.');
  return fail('not_allowed', 'Only confirmed orders get an invoice number.');
}

/**
 * "Clear test data" (A4): deletes every test order with its lines, payments and stock moves, and recomputes the
 * pools. Owner only, and only before go_live_at is set. The audit log keeps a record.
 * A stock count made after a test sale already says what is really there, so for each pool the test moves made
 * BEFORE its last count are balanced by one extra 'count' move: only test moves after the last count give stock back.
 */
export async function clearTestData(db: D1, actor: Actor, at: string = nowIso()): Promise<Result<{ orders: number; effects: Effects }>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const live = await first<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'go_live_at'");
  if (live && live.value !== 'null') return fail('not_allowed', 'Test data can only be cleared before go-live.');
  const pools = await all<{ pool_id: number }>(db, 'SELECT DISTINCT pool_id FROM stock_moves WHERE order_id IN (SELECT id FROM orders WHERE is_test = 1)');
  const notLive = "(SELECT value FROM settings WHERE key = 'go_live_at') = 'null'";
  const test = `order_id IN (SELECT id FROM orders WHERE is_test = 1) AND ${notLive}`;
  const op = uuid();
  const res = await batch(db, [
    stmt(db, `INSERT INTO audit_log (at, actor, action, entity, entity_id, summary)
      SELECT ?, ?, 'orders.clear_test', 'orders', 'test', 'Cleared ' || COUNT(*) || ' test order(s)' FROM orders WHERE is_test = 1 AND ${notLive}`,
    at, actor.email),
    stmt(db, `INSERT INTO stock_moves (pool_id, delta, reason, idem_key, note, created_at, created_by)
      SELECT m.pool_id, SUM(m.delta), 'count', 'count:cleartest:' || ? || ':' || m.pool_id, 'Clear test data: the later count stays as it was', ?, ?
        FROM stock_moves m
       WHERE m.${test} AND m.id < (SELECT MAX(c.id) FROM stock_moves c WHERE c.pool_id = m.pool_id AND c.reason = 'count')
       GROUP BY m.pool_id HAVING SUM(m.delta) <> 0`, op, at, actor.email),
    stmt(db, `DELETE FROM stock_moves WHERE ${test}`),
    stmt(db, `DELETE FROM payments WHERE ${test}`),
    stmt(db, `DELETE FROM order_lines WHERE ${test}`),
    stmt(db, `DELETE FROM orders WHERE is_test = 1 AND ${notLive}`),
    recomputePoolsStmt(db, pools.map((p) => p.pool_id)),
    // stock went back: the website may show a pack as available again (live at once, rebuild debounced)
    ...(pools.length ? stockStatusStatements(db, at, actor.email) : []),
  ]);
  const n = res[5].meta.changes;
  return ok({ orders: n, effects: { publish: pools.length ? 'scheduled' : null, live: pools.length > 0 } });
}
