// Numbers for the Dashboard screen (src/pages/admin/dashboard): Overview, Sales, Stock, Orders and delivery.
// Read-only. All aggregation runs in SQL (CPU budget) and groups in IST, exactly like src/server/sales-queries.ts:
// a sale is a confirmed / packed / sent / delivered order that is not a test order, counted on its confirmed_at.
// Every query of a view goes out in ONE db.batch, so a screen costs one round trip to D1.
import { type D1, stmt } from './db';
import { listBatches } from './stock';
import { stockOverview, type StockRow } from './products-admin';
import { monthToDate } from './sales';
import {
  type Period, type SalesTotals, type SeriesPoint, SOLD_WHERE,
  customPeriod, previousPeriod, salesByProduct, salesSeries, salesTotals,
} from './sales-queries';
import { addDays, fyStartYear, istDate, istMidnight, nowIso } from './time';

// ───────────────────────────── ranges ─────────────────────────────

export type RangeKey = '7' | '30' | '90' | 'month' | 'fy';
export const RANGES: readonly RangeKey[] = ['7', '30', '90', 'month', 'fy'];
export const DEFAULT_RANGE: RangeKey = '30';

export interface DashRange {
  key: RangeKey;
  period: Period;
  /** the period to compare with: same length just before, or the same days of last month / last year */
  previous: Period;
  /** number of IST days in `period` */
  days: number;
  /** one bar per day, or per month for long ranges */
  by: 'day' | 'month';
}

const daysIn = (p: Period) => Math.round((Date.parse(p.endDay) - Date.parse(p.firstDay)) / 86_400_000);

/** The same calendar day one year earlier (29 Feb → 28 Feb) */
export function minusYear(day: string): string {
  const y = Number(day.slice(0, 4)) - 1;
  const md = day.slice(5);
  return `${y}-${md === '02-29' ? '02-28' : md}`;
}

/** The range for ?range= (anything unknown → the last 30 days). Every range ends today (IST). */
export function rangeFromParam(v: string | null | undefined, at: string = nowIso()): DashRange {
  const today = istDate(at);
  const key: RangeKey = (RANGES as readonly string[]).includes(v ?? '') ? (v as RangeKey) : DEFAULT_RANGE;
  let period: Period;
  let previous: Period;
  if (key === 'month') {
    const m = monthToDate(at);
    period = m.current; previous = m.previous;
  } else if (key === 'fy') {
    const first = `${fyStartYear(today)}-04-01`;
    period = customPeriod(first, today);
    previous = customPeriod(minusYear(first), minusYear(today));
  } else {
    period = customPeriod(addDays(today, -(Number(key) - 1)), today);
    previous = previousPeriod(period);
  }
  const days = daysIn(period);
  return { key, period, previous, days, by: days > 92 ? 'month' : 'day' };
}

// ───────────────────────────── small helpers ─────────────────────────────

/** Change as a fraction (0.12 = +12%); null when there is nothing to compare with */
export function change(now: number, before: number): number | null {
  if (!before) return null;
  return (now - before) / Math.abs(before);
}

/** Running total of a series */
export function cumulative(values: readonly number[]): number[] {
  let sum = 0;
  return values.map((v) => (sum += v));
}

/** A series made as long as `length`: cut, or padded with zeros (so "this period" and "before" line up by position) */
export function alignTo(values: readonly number[], length: number): number[] {
  return Array.from({ length }, (_, i) => values[i] ?? 0);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round1 = (v: number) => Math.round(v * 10) / 10;

// ───────────────────────────── insights ─────────────────────────────

export type InsightTone = 'good' | 'warn' | 'bad' | 'info';
/** A plain-words observation; the screen turns `id` + `vars` into a sentence (src/admin/dashboard/strings.ts) */
export interface Insight { id: string; tone: InsightTone; vars: Record<string, string | number> }

// ───────────────────────────── sales ─────────────────────────────

export interface ChannelSales { channel: string; orders: number; netPaise: number }
/** orders by weekday (0 = Sunday … 6 = Saturday) and part of the day (0 night 0–6, 1 morning 6–12, 2 afternoon 12–18, 3 evening 18–24), IST */
export interface HeatCell { weekday: number; part: number; orders: number }

export interface SalesDash {
  range: DashRange;
  totals: SalesTotals;
  previous: SalesTotals;
  series: SeriesPoint[];
  previousSeries: SeriesPoint[];
  byProduct: Awaited<ReturnType<typeof salesByProduct>>;
  channels: ChannelSales[];
  heat: HeatCell[];
  /** the day (or month) with the most sales in the range */
  best: SeriesPoint | null;
  insights: Insight[];
}

export async function salesDash(db: D1, range: DashRange): Promise<SalesDash> {
  const { period, previous: prev, by } = range;
  const [totals, previous, series, previousSeries, byProduct, extra] = await Promise.all([
    salesTotals(db, period), salesTotals(db, prev),
    salesSeries(db, period, by), salesSeries(db, prev, by),
    salesByProduct(db, period),
    db.batch([
      stmt(db, `SELECT o.channel, COUNT(*) AS orders, COALESCE(SUM(o.total_paise), 0) AS net
        FROM orders o WHERE ${SOLD_WHERE} GROUP BY o.channel ORDER BY net DESC`, period.from, period.to),
      stmt(db, `SELECT CAST(strftime('%w', o.created_at, '+330 minutes') AS INTEGER) AS wd,
          CAST(strftime('%H', o.created_at, '+330 minutes') AS INTEGER) / 6 AS part, COUNT(*) AS n
        FROM orders o WHERE ${SOLD_WHERE} GROUP BY wd, part`, period.from, period.to),
    ]),
  ]);
  const channels = (extra[0].results as { channel: string; orders: number; net: number }[])
    .map((r) => ({ channel: r.channel, orders: r.orders, netPaise: r.net }));
  const heat = (extra[1].results as { wd: number; part: number; n: number }[]).map((r) => ({ weekday: r.wd, part: r.part, orders: r.n }));
  const best = series.reduce<SeriesPoint | null>((b, p) => (p.netPaise > (b?.netPaise ?? 0) ? p : b), null);
  const dash: SalesDash = { range, totals, previous, series, previousSeries, byProduct, channels, heat, best, insights: [] };
  dash.insights = salesInsights(dash);
  return dash;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const DAYPARTS = ['night', 'morning', 'afternoon', 'evening'] as const;

/** The busiest weekday and part of the day, or null with fewer than 5 orders (too little to say anything) */
export function busiest(heat: readonly HeatCell[]): { weekday: number; part: number; orders: number } | null {
  const total = heat.reduce((s, c) => s + c.orders, 0);
  if (total < 5) return null;
  const top = heat.reduce((b, c) => (c.orders > b.orders ? c : b), heat[0]);
  return top.orders >= 2 ? top : null;
}

export function salesInsights(d: SalesDash): Insight[] {
  const out: Insight[] = [];
  const c = change(d.totals.netPaise, d.previous.netPaise);
  if (c !== null && Math.abs(c) >= 0.03) {
    out.push({ id: c > 0 ? 'sales.up' : 'sales.down', tone: c > 0 ? 'good' : 'warn', vars: { pct: Math.round(Math.abs(c) * 100) } });
  } else if (d.totals.orders === 0) {
    out.push({ id: 'sales.none', tone: 'info', vars: {} });
  }
  const top = d.byProduct.products.find((p) => p.productId !== null);
  if (top && d.totals.orders >= 3 && top.sharePct >= 20) out.push({ id: 'sales.top', tone: 'info', vars: { name: top.name, pct: Math.round(top.sharePct) } });
  const b = busiest(d.heat);
  if (b) out.push({ id: 'sales.busiest', tone: 'info', vars: { day: WEEKDAYS[b.weekday], part: b.part } });
  if (d.totals.outstandingPaise > 0) out.push({ id: 'sales.outstanding', tone: 'warn', vars: { paise: d.totals.outstandingPaise } });
  return out;
}

// ───────────────────────────── orders and delivery ─────────────────────────────

/** Orders (not test) that came in during the range, by how far they got */
export interface Funnel {
  /** every real order that came in (not spam, not a test order) */
  received: number;
  confirmed: number;
  packed: number;
  sent: number;
  delivered: number;
  cancelled: number;
  /** marked "Not a real order" */
  spam: number;
}

export interface DeliveryStages {
  /** orders delivered in the range */
  delivered: number;
  deliveredPaise: number;
  /** average days between two steps (null when no order has both) */
  confirmToPack: number | null;
  packToSend: number | null;
  sendToDeliver: number | null;
  confirmToDeliver: number | null;
}

export interface Bucket { id: 'd1' | 'd2' | 'd3' | 'd45' | 'd67' | 'd8'; count: number }

export interface OpenOrder {
  id: number;
  ref: string;
  status: 'confirmed' | 'packed' | 'shipped';
  totalPaise: number;
  /** when it reached its current step */
  since: string;
  /** past the waiting limit for its step */
  late: boolean;
}

export const LATE_HOURS = { confirmed: 48, packed: 48, shipped: 7 * 24 } as const;

export interface OrdersDash {
  range: DashRange;
  funnel: Funnel;
  previousReceived: number;
  /** website orders confirmed in the range: how fast, and what share within 24 hours */
  response: { orders: number; avgHours: number | null; within24Pct: number | null };
  stages: DeliveryStages;
  previousDelivered: number;
  deliveredSeries: { key: string; label: string; value: number }[];
  buckets: Bucket[];
  /** right now, whatever the range */
  open: { confirmed: number; packed: number; shipped: number; late: number; list: OpenOrder[] };
  unpaidDelivered: { orders: number; paise: number };
  insights: Insight[];
}

export async function ordersDash(db: D1, range: DashRange, at: string = nowIso()): Promise<OrdersDash> {
  const { period: p, previous: prev, by } = range;
  const fmt = by === 'month' ? '%Y-%m' : '%Y-%m-%d';
  const lateBefore = (hours: number) => `${new Date(Date.parse(at) - hours * 3_600_000).toISOString().slice(0, 19)}Z`;
  const res = await db.batch([
    // 0: how far the orders that came in during the range got (by their status now)
    stmt(db, `SELECT o.status, COUNT(*) AS n FROM orders o
      WHERE o.is_test = 0 AND o.created_at >= ? AND o.created_at < ? GROUP BY o.status`, p.from, p.to),
    // 1: the same for the range before (received only)
    stmt(db, `SELECT COUNT(*) AS n FROM orders o
      WHERE o.is_test = 0 AND o.status <> 'spam' AND o.created_at >= ? AND o.created_at < ?`, prev.from, prev.to),
    // 2: how fast website orders were confirmed
    stmt(db, `SELECT COUNT(*) AS n, AVG((julianday(o.confirmed_at) - julianday(o.created_at)) * 24) AS avg_h,
        COALESCE(SUM(CASE WHEN (julianday(o.confirmed_at) - julianday(o.created_at)) * 24 <= 24 THEN 1 ELSE 0 END), 0) AS fast
      FROM orders o WHERE ${SOLD_WHERE} AND o.source IN ('cart', 'product', 'gift')`, p.from, p.to),
    // 3: time between steps, orders delivered in the range
    stmt(db, `SELECT COUNT(*) AS n, COALESCE(SUM(o.total_paise), 0) AS net,
        AVG(julianday(o.packed_at) - julianday(o.confirmed_at)) AS a, AVG(julianday(o.shipped_at) - julianday(o.packed_at)) AS b,
        AVG(julianday(o.delivered_at) - julianday(o.shipped_at)) AS c, AVG(julianday(o.delivered_at) - julianday(o.confirmed_at)) AS total
      FROM orders o WHERE o.status = 'delivered' AND o.is_test = 0 AND o.delivered_at >= ? AND o.delivered_at < ?`, p.from, p.to),
    // 4: delivered in the range before
    stmt(db, `SELECT COUNT(*) AS n FROM orders o
      WHERE o.status = 'delivered' AND o.is_test = 0 AND o.delivered_at >= ? AND o.delivered_at < ?`, prev.from, prev.to),
    // 5: delivered per day (or month)
    stmt(db, `SELECT strftime('${fmt}', o.delivered_at, '+330 minutes') AS k, COUNT(*) AS n FROM orders o
      WHERE o.status = 'delivered' AND o.is_test = 0 AND o.delivered_at >= ? AND o.delivered_at < ? GROUP BY k`, p.from, p.to),
    // 6: how long confirm → delivered took
    stmt(db, `SELECT CASE WHEN d < 1.5 THEN 0 WHEN d < 2.5 THEN 1 WHEN d < 3.5 THEN 2 WHEN d < 5.5 THEN 3 WHEN d < 7.5 THEN 4 ELSE 5 END AS b, COUNT(*) AS n
      FROM (SELECT julianday(o.delivered_at) - julianday(o.confirmed_at) AS d FROM orders o
        WHERE o.status = 'delivered' AND o.is_test = 0 AND o.confirmed_at IS NOT NULL AND o.delivered_at >= ? AND o.delivered_at < ?)
      GROUP BY b`, p.from, p.to),
    // 7: what is on the way right now: counts per step and the oldest ones
    stmt(db, `SELECT o.status, COUNT(*) AS n FROM orders o
      WHERE o.status IN ('confirmed', 'packed', 'shipped') AND o.is_test = 0 GROUP BY o.status`),
    stmt(db, `SELECT o.id, o.ref, o.status, o.total_paise,
        CASE o.status WHEN 'shipped' THEN COALESCE(o.shipped_at, o.confirmed_at) WHEN 'packed' THEN COALESCE(o.packed_at, o.confirmed_at) ELSE o.confirmed_at END AS since
      FROM orders o WHERE o.status IN ('confirmed', 'packed', 'shipped') AND o.is_test = 0 AND o.confirmed_at IS NOT NULL
      ORDER BY since ASC, o.id ASC LIMIT 8`),
    // 9: how many are past their limit (all, not just the 8 shown)
    stmt(db, `SELECT COUNT(*) AS n FROM orders o WHERE o.is_test = 0 AND (
        (o.status = 'confirmed' AND o.confirmed_at < ?) OR
        (o.status = 'packed' AND COALESCE(o.packed_at, o.confirmed_at) < ?) OR
        (o.status = 'shipped' AND COALESCE(o.shipped_at, o.confirmed_at) < ?))`,
      lateBefore(LATE_HOURS.confirmed), lateBefore(LATE_HOURS.packed), lateBefore(LATE_HOURS.shipped)),
    // 10: delivered but not fully paid
    stmt(db, `SELECT COUNT(*) AS n, COALESCE(SUM(o.total_paise - o.paid_paise), 0) AS due FROM orders o
      WHERE o.status = 'delivered' AND o.is_test = 0 AND o.total_paise > o.paid_paise`),
  ]);

  const st = new Map((res[0].results as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  const n = (s: string) => st.get(s) ?? 0;
  const funnel: Funnel = {
    received: [...st.entries()].filter(([s]) => s !== 'spam').reduce((sum, [, v]) => sum + v, 0),
    confirmed: n('confirmed') + n('packed') + n('shipped') + n('delivered'),
    packed: n('packed') + n('shipped') + n('delivered'),
    sent: n('shipped') + n('delivered'),
    delivered: n('delivered'),
    cancelled: n('cancelled'),
    spam: n('spam'),
  };

  const r2 = res[2].results[0] as { n: number; avg_h: number | null; fast: number };
  const r3 = res[3].results[0] as { n: number; net: number; a: number | null; b: number | null; c: number | null; total: number | null };
  const days = (v: number | null) => (v === null || v === undefined ? null : round1(Math.max(0, v)));
  const stages: DeliveryStages = {
    delivered: r3.n, deliveredPaise: r3.net,
    confirmToPack: days(r3.a), packToSend: days(r3.b), sendToDeliver: days(r3.c), confirmToDeliver: days(r3.total),
  };

  const perDay = new Map((res[5].results as { k: string; n: number }[]).map((r) => [r.k, r.n]));
  const deliveredSeries: OrdersDash['deliveredSeries'] = [];
  if (by === 'month') {
    for (let m = p.firstDay.slice(0, 7); `${m}-01` < p.endDay; m = nextMonth(m)) deliveredSeries.push({ key: m, label: m.slice(5), value: perDay.get(m) ?? 0 });
  } else {
    for (let d = p.firstDay; d < p.endDay; d = addDays(d, 1)) deliveredSeries.push({ key: d, label: String(Number(d.slice(8))), value: perDay.get(d) ?? 0 });
  }

  const ids: Bucket['id'][] = ['d1', 'd2', 'd3', 'd45', 'd67', 'd8'];
  const bucketN = new Map((res[6].results as { b: number; n: number }[]).map((r) => [r.b, r.n]));
  const buckets: Bucket[] = ids.map((id, i) => ({ id, count: bucketN.get(i) ?? 0 }));

  const openN = new Map((res[7].results as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  const limit = (s: OpenOrder['status']) => Date.parse(at) - LATE_HOURS[s] * 3_600_000;
  const list: OpenOrder[] = (res[8].results as { id: number; ref: string; status: OpenOrder['status']; total_paise: number; since: string }[])
    .map((r) => ({ id: r.id, ref: r.ref, status: r.status, totalPaise: r.total_paise, since: r.since, late: Date.parse(r.since) < limit(r.status) }));
  const unpaid = res[10].results[0] as { n: number; due: number };

  const dash: OrdersDash = {
    range, funnel, previousReceived: num((res[1].results[0] as { n: number }).n),
    response: { orders: r2.n, avgHours: r2.avg_h === null ? null : round1(r2.avg_h), within24Pct: r2.n ? Math.round((r2.fast * 100) / r2.n) : null },
    stages, previousDelivered: num((res[4].results[0] as { n: number }).n), deliveredSeries, buckets,
    open: { confirmed: openN.get('confirmed') ?? 0, packed: openN.get('packed') ?? 0, shipped: openN.get('shipped') ?? 0, late: num((res[9].results[0] as { n: number }).n), list },
    unpaidDelivered: { orders: unpaid.n, paise: unpaid.due }, insights: [],
  };
  dash.insights = ordersInsights(dash);
  return dash;
}

function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

export function ordersInsights(d: OrdersDash): Insight[] {
  const out: Insight[] = [];
  if (d.open.late > 0) out.push({ id: 'orders.late', tone: 'warn', vars: { count: d.open.late } });
  if (d.stages.delivered >= 2 && d.stages.confirmToDeliver !== null) out.push({ id: 'orders.speed', tone: 'info', vars: { days: d.stages.confirmToDeliver } });
  if (d.response.orders >= 3 && d.response.within24Pct !== null) {
    out.push({ id: d.response.within24Pct >= 80 ? 'orders.fast' : 'orders.slow', tone: d.response.within24Pct >= 80 ? 'good' : 'warn', vars: { pct: d.response.within24Pct } });
  }
  const asked = d.funnel.received;
  if (asked >= 5 && d.funnel.cancelled / asked >= 0.15) out.push({ id: 'orders.cancels', tone: 'warn', vars: { pct: Math.round((d.funnel.cancelled * 100) / asked) } });
  if (d.unpaidDelivered.orders > 0) out.push({ id: 'orders.unpaid', tone: 'warn', vars: { count: d.unpaidDelivered.orders, paise: d.unpaidDelivered.paise } });
  return out;
}

// ───────────────────────────── stock ─────────────────────────────

export interface WeekFlow {
  /** Monday of the week, 'YYYY-MM-DD' (IST) */
  week: string;
  /** grams of honey harvested */
  harvested: number;
  /** grams of honey sold (sales minus reversals) */
  sold: number;
  /** grams written off: damage, samples, other */
  lost: number;
}

export interface MoveRow { id: number; at: string; delta: number; reason: string; poolName: string; unit: 'g' | 'piece' }

export interface StockDash {
  pools: StockRow[];
  /** tracked honey in grams, and candles / sticks in pieces */
  honeyGrams: number;
  pieces: number;
  /** pools that are negative, empty or low */
  attention: number;
  untracked: number;
  /** stock at today's selling prices, in paise (an estimate: the average price per gram or piece of each pool's packs) */
  worthPaise: number;
  /** pools with a forecast, shortest cover first */
  cover: StockRow[];
  flow: WeekFlow[];
  moves: MoveRow[];
  batches: { id: number; code: string; productName: string; bestBefore: string; state: 'ok' | 'soon' | 'passed' }[];
  insights: Insight[];
}

/** Mondays of the last `weeks` IST weeks, oldest first, ending with the week of `at` */
export function weekStarts(at: string, weeks: number): string[] {
  const today = istDate(at);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(today, -((dow + 6) % 7));
  return Array.from({ length: weeks }, (_, i) => addDays(monday, -7 * (weeks - 1 - i)));
}

export async function stockDash(db: D1, at: string = nowIso(), weeks = 8): Promise<StockDash> {
  const mondays = weekStarts(at, weeks);
  const since = istMidnight(mondays[0]);
  const [overview, batches, extra] = await Promise.all([
    stockOverview(db, { at }),
    listBatches(db, { status: 'active', at }),
    db.batch([
      stmt(db, `SELECT date(datetime(m.created_at, '+330 minutes'), 'weekday 0', '-6 days') AS wk,
          COALESCE(SUM(CASE WHEN m.reason = 'harvest' THEN m.delta ELSE 0 END), 0) AS harvested,
          COALESCE(SUM(CASE WHEN m.reason IN ('sale', 'sale_reversal') THEN -m.delta ELSE 0 END), 0) AS sold,
          COALESCE(SUM(CASE WHEN m.reason IN ('damage', 'sample', 'other') AND m.delta < 0 THEN -m.delta ELSE 0 END), 0) AS lost
        FROM stock_moves m JOIN stock_pools s ON s.id = m.pool_id
        WHERE s.unit = 'g' AND m.created_at >= ? GROUP BY wk`, since),
      stmt(db, `SELECT m.id, m.created_at, m.delta, m.reason, s.name, s.unit FROM stock_moves m
        JOIN stock_pools s ON s.id = m.pool_id ORDER BY m.id DESC LIMIT 8`),
      stmt(db, `SELECT v.pool_id, v.price_paise, v.pool_qty FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.active = 1 AND v.price_paise IS NOT NULL AND p.status IN ('live', 'paused')`),
    ]),
  ]);
  const pools = overview.pools;
  const tracked = pools.filter((p) => p.trackStock);

  // price of one pool unit (a gram, a candle): the average over the pool's priced packs
  const perUnit = new Map<number, number[]>();
  for (const r of extra[2].results as { pool_id: number; price_paise: number; pool_qty: number }[]) {
    const list = perUnit.get(r.pool_id) ?? [];
    list.push(r.price_paise / r.pool_qty);
    perUnit.set(r.pool_id, list);
  }
  let worth = 0;
  for (const p of tracked) {
    const prices = perUnit.get(p.id);
    if (!prices?.length || p.onHand <= 0) continue;
    worth += p.onHand * (prices.reduce((s, v) => s + v, 0) / prices.length);
  }

  const byWeek = new Map((extra[0].results as { wk: string; harvested: number; sold: number; lost: number }[]).map((r) => [r.wk, r]));
  const flow: WeekFlow[] = mondays.map((week) => {
    const r = byWeek.get(week);
    return { week, harvested: r?.harvested ?? 0, sold: r?.sold ?? 0, lost: r?.lost ?? 0 };
  });

  const cover = tracked.filter((p) => p.daysOfCover !== null)
    .sort((a, b) => (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9) || a.onHand - b.onHand);

  const dash: StockDash = {
    pools,
    honeyGrams: tracked.filter((p) => p.unit === 'g').reduce((s, p) => s + p.onHand, 0),
    pieces: tracked.filter((p) => p.unit === 'piece').reduce((s, p) => s + p.onHand, 0),
    attention: tracked.filter((p) => p.level === 'negative' || p.level === 'empty' || p.level === 'low').length,
    untracked: pools.filter((p) => !p.trackStock && p.productStatus !== 'retired').length,
    worthPaise: Math.round(worth / 100) * 100, // a rough figure: whole rupees
    cover, flow,
    moves: (extra[1].results as { id: number; created_at: string; delta: number; reason: string; name: string; unit: 'g' | 'piece' }[])
      .map((r) => ({ id: r.id, at: r.created_at, delta: r.delta, reason: r.reason, poolName: r.name, unit: r.unit })),
    batches: batches.slice().sort((a, b) => a.bestBefore.localeCompare(b.bestBefore) || a.id - b.id).slice(0, 6)
      .map((b) => ({ id: b.id, code: b.code, productName: b.productName, bestBefore: b.bestBefore, state: b.bestBeforeState })),
    insights: [],
  };
  dash.insights = stockInsights(dash);
  return dash;
}

export function stockInsights(d: StockDash): Insight[] {
  const out: Insight[] = [];
  const short = d.cover.find((p) => p.daysOfCover !== null && p.daysOfCover < 21);
  if (short) out.push({ id: short.daysOfCover === 0 ? 'stock.out' : 'stock.short', tone: 'bad', vars: { name: short.name, days: short.daysOfCover ?? 0 } });
  if (d.attention > 1) out.push({ id: 'stock.attention', tone: 'warn', vars: { count: d.attention } });
  const passed = d.batches.filter((b) => b.state === 'passed').length;
  const soon = d.batches.filter((b) => b.state === 'soon').length;
  if (passed > 0) out.push({ id: 'stock.passed', tone: 'bad', vars: { count: passed } });
  else if (soon > 0) out.push({ id: 'stock.soon', tone: 'warn', vars: { count: soon } });
  if (d.untracked > 0 && d.pools.some((p) => p.trackStock)) out.push({ id: 'stock.untracked', tone: 'info', vars: { count: d.untracked } });
  const week = d.flow.slice(-4);
  const harvested = week.reduce((s, w) => s + w.harvested, 0);
  const sold = week.reduce((s, w) => s + w.sold, 0);
  if (sold > 0 && harvested === 0) out.push({ id: 'stock.noHarvest', tone: 'info', vars: {} });
  return out;
}

// ───────────────────────────── overview ─────────────────────────────

export interface OverviewDash {
  range: DashRange;
  sales: SalesDash;
  orders: OrdersDash;
  stock: StockDash;
  /** the most telling observations of the three views, at most 4, worst news first */
  insights: Insight[];
}

const TONE_ORDER: Record<InsightTone, number> = { bad: 0, warn: 1, good: 2, info: 3 };

export async function overviewDash(db: D1, range: DashRange, at: string = nowIso()): Promise<OverviewDash> {
  const [sales, orders, stock] = await Promise.all([salesDash(db, range), ordersDash(db, range, at), stockDash(db, at)]);
  const insights = [...sales.insights, ...orders.insights, ...stock.insights]
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]).slice(0, 4);
  return { range, sales, orders, stock, insights };
}
