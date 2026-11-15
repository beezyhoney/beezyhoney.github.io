// Sales numbers for the Sales and Today screens. All aggregation happens in SQL (CPU budget), grouped in IST.
//
// A sale is an order with status confirmed / packed / sent / delivered that is not a test order; it counts in the
// period of its confirmed_at (IST). New, spam and cancelled orders never count. Amounts are paise.
// Periods are half-open UTC ranges [from, to) whose edges are IST midnights, so 31 Mar 23:59 IST and
// 1 Apr 00:00 IST fall in different months and financial years.
import { type D1, all, first, stmt } from './db';
import { addDays, addMonths, fyLabel, fyStartYear, isDate, isMonth, istDate, istMidnight, monthName, nowIso, shortDate } from './time';

export type PeriodKind = 'month' | 'year' | 'fy' | 'custom';

export interface Period {
  kind: PeriodKind;
  /** '2026-11' | '2026' | '2026-27' | '2026-11-01..2026-11-15' */
  key: string;
  /** 'November 2026' | '2026' | 'FY 2026-27' | '1 Nov 2026 – 15 Nov 2026' */
  label: string;
  /** first IST day, 'YYYY-MM-DD' */
  firstDay: string;
  /** day after the last IST day, 'YYYY-MM-DD' */
  endDay: string;
  /** UTC range [from, to) */
  from: string;
  to: string;
}

const make = (kind: PeriodKind, key: string, label: string, firstDay: string, endDay: string): Period =>
  ({ kind, key, label, firstDay, endDay, from: istMidnight(firstDay), to: istMidnight(endDay) });

/** One IST calendar month: monthPeriod('2026-11') */
export function monthPeriod(month: string): Period {
  if (!isMonth(month)) throw new Error(`not a month: ${month}`);
  return make('month', month, monthName(month), `${month}-01`, `${addMonths(month, 1)}-01`);
}

/** A calendar year, January–December IST */
export function calendarYearPeriod(year: number): Period {
  return make('year', String(year), String(year), `${year}-01-01`, `${year + 1}-01-01`);
}

/** An Indian financial year, April–March IST: financialYearPeriod(2026) = FY 2026-27 */
export function financialYearPeriod(startYear: number): Period {
  const fy = fyLabel(startYear);
  return make('fy', fy, `FY ${fy}`, `${startYear}-04-01`, `${startYear + 1}-04-01`);
}

/** Custom IST dates, both included */
export function customPeriod(firstDay: string, lastDay: string): Period {
  if (!isDate(firstDay) || !isDate(lastDay) || lastDay < firstDay) throw new Error('bad custom period');
  return make('custom', `${firstDay}..${lastDay}`, `${shortDate(firstDay)} – ${shortDate(lastDay)}`, firstDay, addDays(lastDay, 1));
}

/** The period just before (same length for custom periods) */
export function previousPeriod(p: Period): Period {
  if (p.kind === 'month') return monthPeriod(addMonths(p.key, -1));
  if (p.kind === 'year') return calendarYearPeriod(Number(p.key) - 1);
  if (p.kind === 'fy') return financialYearPeriod(Number(p.key.slice(0, 4)) - 1);
  const days = Math.round((Date.parse(p.endDay) - Date.parse(p.firstDay)) / 86_400_000);
  return customPeriod(addDays(p.firstDay, -days), addDays(p.firstDay, -1));
}

/** The current IST month / calendar year / financial year */
export const currentMonth = (at: string = nowIso()) => monthPeriod(istDate(at).slice(0, 7));
export const currentYear = (at: string = nowIso()) => calendarYearPeriod(Number(istDate(at).slice(0, 4)));
export const currentFinancialYear = (at: string = nowIso()) => financialYearPeriod(fyStartYear(istDate(at)));

/**
 * Period from the Sales screen's query string: ?period=month&month=2026-11 | period=year&year=2026 |
 * period=fy&fy=2026 (start year) | period=custom&from=…&to=… . Anything missing or wrong → this month.
 */
export function periodFromParams(q: { period?: string | null; month?: string | null; year?: string | null; fy?: string | null; from?: string | null; to?: string | null }, at: string = nowIso()): Period {
  try {
    if (q.period === 'year' && q.year && /^\d{4}$/.test(q.year)) return calendarYearPeriod(Number(q.year));
    if (q.period === 'year') return currentYear(at);
    if (q.period === 'fy' && q.fy && /^\d{4}$/.test(q.fy)) return financialYearPeriod(Number(q.fy));
    if (q.period === 'fy') return currentFinancialYear(at);
    if (q.period === 'custom' && q.from && q.to) return customPeriod(q.from, q.to);
    if (q.month && isMonth(q.month)) return monthPeriod(q.month);
  } catch { /* fall through */ }
  return currentMonth(at);
}

/** WHERE for the sales of a period on orders alias `o`; binds two parameters: from, to */
const SOLD_WHERE = "o.status IN ('confirmed', 'packed', 'shipped', 'delivered') AND o.is_test = 0 AND o.confirmed_at >= ? AND o.confirmed_at < ?";

export interface SalesTotals {
  orders: number;
  /** items before discount */
  itemsPaise: number;
  deliveryPaise: number;
  discountPaise: number;
  /** what the customers pay: items − discount + delivery */
  netPaise: number;
  /** item lines' quantities (packs) */
  units: number;
  /** grams of honey sold (packs with a net weight; the weight copied at confirm, order_lines.net_grams) */
  grams: number;
  averageOrderPaise: number;
  /** payments recorded on these orders (any date) */
  collectedPaise: number;
  /** still to collect on these orders */
  outstandingPaise: number;
}

/** Totals of a period */
export async function salesTotals(db: D1, p: Period): Promise<SalesTotals> {
  const [o, l] = await db.batch([
    stmt(db, `SELECT COUNT(*) AS orders, COALESCE(SUM(o.items_total_paise), 0) AS items, COALESCE(SUM(o.delivery_paise), 0) AS delivery,
        COALESCE(SUM(o.discount_paise), 0) AS discount, COALESCE(SUM(o.total_paise), 0) AS net, COALESCE(SUM(o.paid_paise), 0) AS paid,
        COALESCE(SUM(CASE WHEN o.total_paise > o.paid_paise THEN o.total_paise - o.paid_paise ELSE 0 END), 0) AS outstanding
      FROM orders o WHERE ${SOLD_WHERE}`, p.from, p.to),
    stmt(db, `SELECT COALESCE(SUM(l.qty), 0) AS units, COALESCE(SUM(l.qty * COALESCE(l.net_grams, 0)), 0) AS grams
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.kind = 'item' AND ${SOLD_WHERE}`, p.from, p.to),
  ]);
  const a = o.results[0] as Record<string, number>;
  const b = l.results[0] as Record<string, number>;
  return {
    orders: a.orders, itemsPaise: a.items, deliveryPaise: a.delivery, discountPaise: a.discount, netPaise: a.net,
    units: b.units, grams: b.grams, averageOrderPaise: a.orders ? Math.round(a.net / a.orders) : 0,
    collectedPaise: a.paid, outstandingPaise: a.outstanding,
  };
}

export interface SeriesPoint { key: string; label: string; orders: number; netPaise: number; itemsPaise: number; units: number }

/** Bars for the chart: per IST month (years) or per IST day (months, custom); gaps filled with zeros */
export async function salesSeries(db: D1, p: Period, by: 'month' | 'day' = p.kind === 'month' || p.kind === 'custom' ? 'day' : 'month'): Promise<SeriesPoint[]> {
  const fmt = by === 'month' ? '%Y-%m' : '%Y-%m-%d';
  const [o, l] = await db.batch([
    stmt(db, `SELECT strftime('${fmt}', o.confirmed_at, '+330 minutes') AS k, COUNT(*) AS orders, SUM(o.total_paise) AS net, SUM(o.items_total_paise) AS items
      FROM orders o WHERE ${SOLD_WHERE} GROUP BY k`, p.from, p.to),
    stmt(db, `SELECT strftime('${fmt}', o.confirmed_at, '+330 minutes') AS k, SUM(l.qty) AS units
      FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.kind = 'item' AND ${SOLD_WHERE} GROUP BY k`, p.from, p.to),
  ]);
  const byKey = new Map((o.results as { k: string; orders: number; net: number; items: number }[]).map((r) => [r.k, r]));
  const units = new Map((l.results as { k: string; units: number }[]).map((r) => [r.k, r.units]));
  const out: SeriesPoint[] = [];
  if (by === 'month') {
    for (let m = p.firstDay.slice(0, 7); `${m}-01` < p.endDay; m = addMonths(m, 1)) {
      const r = byKey.get(m);
      out.push({ key: m, label: monthName(m).slice(0, 3), orders: r?.orders ?? 0, netPaise: r?.net ?? 0, itemsPaise: r?.items ?? 0, units: units.get(m) ?? 0 });
    }
  } else {
    for (let d = p.firstDay; d < p.endDay; d = addDays(d, 1)) {
      const r = byKey.get(d);
      out.push({ key: d, label: String(Number(d.slice(8))), orders: r?.orders ?? 0, netPaise: r?.net ?? 0, itemsPaise: r?.items ?? 0, units: units.get(d) ?? 0 });
    }
  }
  return out;
}

export interface PackSales { variantId: number; label: string; units: number; paise: number; grams: number }
export interface ProductSales {
  productId: number | null;
  slug: string | null;
  /** product name, or 'Other items' (custom lines) / 'Charges' (fee lines) */
  name: string;
  category: string | null;
  orders: number;
  units: number;
  paise: number;
  grams: number;
  /** share of all item sales in the period, 0–100 with one decimal */
  sharePct: number;
  packs: PackSales[];
}
export interface CategorySales { category: string; name: string; orders: number; units: number; paise: number; grams: number; sharePct: number }

/** "By product" with packs and category subtotals (lines' own totals, before order discounts) */
export async function salesByProduct(db: D1, p: Period): Promise<{ products: ProductSales[]; categories: CategorySales[]; totalPaise: number }> {
  const [packRes, prodRes, catRes] = await db.batch([
    stmt(db, `SELECT l.kind, l.product_id, l.variant_id, v.label, v.sort AS vsort, SUM(l.qty) AS units, SUM(l.line_total_paise) AS paise,
        SUM(l.qty * COALESCE(l.net_grams, 0)) AS grams
      FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN variants v ON v.id = l.variant_id
      WHERE ${SOLD_WHERE} GROUP BY l.kind, l.product_id, l.variant_id`, p.from, p.to),
    stmt(db, `SELECT l.kind, l.product_id, pr.slug, pr.name, pr.category, pr.sort, COUNT(DISTINCT l.order_id) AS orders
      FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN products pr ON pr.id = l.product_id
      WHERE ${SOLD_WHERE} GROUP BY l.kind, l.product_id`, p.from, p.to),
    stmt(db, `SELECT pr.category, c.name, COUNT(DISTINCT l.order_id) AS orders FROM order_lines l JOIN orders o ON o.id = l.order_id
        JOIN products pr ON pr.id = l.product_id JOIN categories c ON c.id = pr.category
      WHERE l.kind = 'item' AND ${SOLD_WHERE} GROUP BY pr.category`, p.from, p.to),
  ]);
  type PackRow = { kind: string; product_id: number | null; variant_id: number | null; label: string | null; vsort: number | null; units: number; paise: number; grams: number };
  type ProdRow = { kind: string; product_id: number | null; slug: string | null; name: string | null; category: string | null; sort: number | null; orders: number };
  const packs = packRes.results as unknown as PackRow[];
  const prods = prodRes.results as unknown as ProdRow[];
  const total = packs.reduce((s, r) => s + r.paise, 0);
  const share = (x: number) => (total ? Math.round((x * 1000) / total) / 10 : 0);
  const keyOf = (kind: string, productId: number | null) => (kind === 'item' && productId !== null ? `p${productId}` : kind);
  type Acc = { sales: ProductSales; sort: number; packs: { sort: number; pack: PackSales }[] };
  const products = new Map<string, Acc>();
  for (const r of prods) {
    const key = keyOf(r.kind, r.product_id);
    const isProduct = key.startsWith('p');
    const prev = products.get(key);
    if (prev) { prev.sales.orders += r.orders; continue; }
    products.set(key, {
      sales: {
        productId: isProduct ? r.product_id : null, slug: isProduct ? r.slug : null,
        name: isProduct ? r.name! : r.kind === 'fee' ? 'Charges' : 'Other items', category: isProduct ? r.category : null,
        orders: r.orders, units: 0, paise: 0, grams: 0, sharePct: 0, packs: [],
      },
      sort: r.sort ?? 1e9,
      packs: [],
    });
  }
  for (const r of packs) {
    const acc = products.get(keyOf(r.kind, r.product_id));
    if (!acc) continue;
    acc.sales.units += r.units; acc.sales.paise += r.paise; acc.sales.grams += r.grams;
    if (r.kind === 'item' && r.variant_id !== null) {
      acc.packs.push({ sort: r.vsort ?? 0, pack: { variantId: r.variant_id, label: r.label ?? '', units: r.units, paise: r.paise, grams: r.grams } });
    }
  }
  const list = [...products.values()]
    .sort((a, b) => b.sales.paise - a.sales.paise || a.sort - b.sort)
    .map((acc) => ({ ...acc.sales, sharePct: share(acc.sales.paise), packs: acc.packs.sort((a, b) => a.sort - b.sort).map((x) => x.pack) }));
  const catOrders = new Map((catRes.results as { category: string; name: string; orders: number }[]).map((r) => [r.category, r]));
  const cats = new Map<string, CategorySales>();
  for (const ps of list) {
    if (!ps.category) continue;
    const c = cats.get(ps.category) ?? { category: ps.category, name: catOrders.get(ps.category)?.name ?? ps.category, orders: catOrders.get(ps.category)?.orders ?? 0, units: 0, paise: 0, grams: 0, sharePct: 0 };
    c.units += ps.units; c.paise += ps.paise; c.grams += ps.grams;
    cats.set(ps.category, c);
  }
  return { products: list, categories: [...cats.values()].map((c) => ({ ...c, sharePct: share(c.paise) })).sort((a, b) => b.paise - a.paise), totalPaise: total };
}

export interface AskedVsConfirmed { productId: number; name: string; askedOrders: number; askedUnits: number; soldOrders: number; soldUnits: number }

/**
 * Demand vs sales per product: "asked" = website orders (cart, product page, gift) of any status except spam,
 * created in the period; "sold" = sales confirmed in the period. Test orders are left out of both.
 */
export async function askedVsConfirmed(db: D1, p: Period): Promise<AskedVsConfirmed[]> {
  const [asked, sold] = await db.batch([
    stmt(db, `SELECT l.product_id, pr.name, pr.sort, COUNT(DISTINCT l.order_id) AS orders, SUM(l.qty) AS units
      FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN products pr ON pr.id = l.product_id
      WHERE l.kind = 'item' AND o.source IN ('cart', 'product', 'gift') AND o.status <> 'spam' AND o.is_test = 0
        AND o.created_at >= ? AND o.created_at < ? GROUP BY l.product_id`, p.from, p.to),
    stmt(db, `SELECT l.product_id, pr.name, pr.sort, COUNT(DISTINCT l.order_id) AS orders, SUM(l.qty) AS units
      FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN products pr ON pr.id = l.product_id
      WHERE l.kind = 'item' AND ${SOLD_WHERE} GROUP BY l.product_id`, p.from, p.to),
  ]);
  type R = { product_id: number; name: string; sort: number; orders: number; units: number };
  const out = new Map<number, AskedVsConfirmed & { sort: number }>();
  const get = (r: R) => out.get(r.product_id) ?? { productId: r.product_id, name: r.name, askedOrders: 0, askedUnits: 0, soldOrders: 0, soldUnits: 0, sort: r.sort };
  for (const r of asked.results as unknown as R[]) out.set(r.product_id, { ...get(r), askedOrders: r.orders, askedUnits: r.units });
  for (const r of sold.results as unknown as R[]) out.set(r.product_id, { ...get(r), soldOrders: r.orders, soldUnits: r.units });
  return [...out.values()].sort((a, b) => a.sort - b.sort).map(({ sort: _s, ...rest }) => rest);
}

/** A product's last `months` IST months (oldest first, zeros filled): units and line ₹ — the product editor's Sales tab */
export async function productHistory(db: D1, productId: number, months = 24, at: string = nowIso()): Promise<{ month: string; units: number; paise: number }[]> {
  const last = istDate(at).slice(0, 7);
  const firstMonth = addMonths(last, -(months - 1));
  const rows = await all<{ k: string; units: number; paise: number }>(db,
    `SELECT strftime('%Y-%m', o.confirmed_at, '+330 minutes') AS k, SUM(l.qty) AS units, SUM(l.line_total_paise) AS paise
       FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.kind = 'item' AND l.product_id = ? AND ${SOLD_WHERE} GROUP BY k`,
    productId, istMidnight(`${firstMonth}-01`), istMidnight(`${addMonths(last, 1)}-01`));
  const map = new Map(rows.map((r) => [r.k, r]));
  const out: { month: string; units: number; paise: number }[] = [];
  for (let m = firstMonth; m <= last; m = addMonths(m, 1)) out.push({ month: m, units: map.get(m)?.units ?? 0, paise: map.get(m)?.paise ?? 0 });
  return out;
}

/** Units of a pool's packs confirmed in the last `days` days (for "days of cover" on the low-stock list) */
export async function poolUsage(db: D1, poolId: number, days = 30, at: string = nowIso()): Promise<number> {
  const r = await first<{ used: number }>(db, `SELECT COALESCE(-SUM(delta), 0) AS used FROM stock_moves
    WHERE pool_id = ? AND reason IN ('sale', 'sale_reversal') AND created_at >= ?`, poolId, `${new Date(Date.parse(at) - days * 86_400_000).toISOString().slice(0, 19)}Z`);
  return r?.used ?? 0;
}

/** Everything the Sales screen shows for a period, with the previous period's totals for ▲▼ */
export async function salesReport(db: D1, p: Period) {
  const prev = previousPeriod(p);
  const [totals, previous, series, byProduct, asked] = await Promise.all([
    salesTotals(db, p), salesTotals(db, prev), salesSeries(db, p), salesByProduct(db, p), askedVsConfirmed(db, p),
  ]);
  return { period: p, previousPeriod: prev, totals, previous, series, byProduct, asked };
}
