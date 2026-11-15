// Sales screen helpers and the CSV exports (design §5 screens 1, 9 and 12).
//
// The sales numbers themselves come from sales-queries.ts (a sale = a confirmed / packed / sent / delivered order
// that is not a test order, counted in the IST period of its confirmed_at). This module adds:
// - monthToDate(): "this month so far" against the same days of last month (Today screen);
// - periodNav(): the previous / next period for the Sales screen's arrows;
// - exportCsv(): the four CSV downloads (orders, order_lines, monthly_by_product, stock_moves). Money is written as
//   rupees with two decimals, times in IST. Customer name, phone, address, city and the order note are only included
//   when the owner ticks "include customer details" (privacy, design §7).
// All aggregation stays in SQL (CPU budget). Exports are capped at EXPORT_MAX_ROWS rows.
import { type D1, all } from './db';
import {
  calendarYearPeriod, customPeriod, financialYearPeriod, monthPeriod, type Period, type PeriodKind,
} from './sales-queries';
import { addDays, addMonths, isDate, istDate, istMidnight, nowIso } from './time';

// ───────────────────────────── periods ─────────────────────────────

/** Last IST day of a month 'YYYY-MM' */
export function lastDayOfMonth(month: string): string {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}

/**
 * "This month so far" (1st of this IST month to today) and the same days of last month (clamped to its last day,
 * so 31 March compares with 1–28/29 February). Used by Today's "This month vs last month" tiles.
 */
export function monthToDate(at: string = nowIso()): { current: Period; previous: Period; day: number } {
  const today = istDate(at);
  const month = today.slice(0, 7);
  const day = Number(today.slice(8));
  const prevMonth = addMonths(month, -1);
  const prevLast = lastDayOfMonth(prevMonth);
  const prevEnd = `${prevMonth}-${String(Math.min(day, Number(prevLast.slice(8)))).padStart(2, '0')}`;
  return { current: customPeriod(`${month}-01`, today), previous: customPeriod(`${prevMonth}-01`, prevEnd), day };
}

/** Query string for a period on the Sales screen (?period=…) */
export function periodQuery(p: Period): string {
  switch (p.kind) {
    case 'month': return `period=month&month=${p.key}`;
    case 'year': return `period=year&year=${p.key}`;
    case 'fy': return `period=fy&fy=${p.key.slice(0, 4)}`;
    default: return `period=custom&from=${p.firstDay}&to=${addDays(p.endDay, -1)}`;
  }
}

/** The period before and after `p` (same kind); `next` is null when it would start after today (IST) */
export function periodNav(p: Period, at: string = nowIso()): { prev: Period; next: Period | null } {
  const today = istDate(at);
  let prev: Period;
  let next: Period;
  if (p.kind === 'month') { prev = monthPeriod(addMonths(p.key, -1)); next = monthPeriod(addMonths(p.key, 1)); }
  else if (p.kind === 'year') { prev = calendarYearPeriod(Number(p.key) - 1); next = calendarYearPeriod(Number(p.key) + 1); }
  else if (p.kind === 'fy') { const y = Number(p.key.slice(0, 4)); prev = financialYearPeriod(y - 1); next = financialYearPeriod(y + 1); }
  else {
    const days = Math.round((Date.parse(p.endDay) - Date.parse(p.firstDay)) / 86_400_000);
    prev = customPeriod(addDays(p.firstDay, -days), addDays(p.firstDay, -1));
    next = customPeriod(p.endDay, addDays(p.endDay, days - 1));
  }
  return { prev, next: next.firstDay > today ? null : next };
}

/** Words for each period kind (Sales screen switch) */
export const PERIOD_KINDS: readonly PeriodKind[] = ['month', 'year', 'fy', 'custom'];

// ───────────────────────────── CSV ─────────────────────────────

export const EXPORTS = ['orders', 'order_lines', 'monthly_by_product', 'stock_moves'] as const;
export type ExportName = (typeof EXPORTS)[number];
export const isExportName = (v: unknown): v is ExportName => typeof v === 'string' && (EXPORTS as readonly string[]).includes(v);

/** Most rows one export writes (a hint is added as the last line when the cap is hit) */
export const EXPORT_MAX_ROWS = 20_000;

/**
 * One CSV cell. Numbers are written as they are; text is quoted when needed, and text that a spreadsheet would run
 * as a formula (starting with = + - @, a tab or a carriage return, except a plain negative number) gets a leading
 * apostrophe.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  let s = String(v);
  // a plain negative amount ('-50.50') stays a number; anything else starting like a formula is neutralised
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line (CRLF, as spreadsheets expect) */
export const csvLine = (cells: readonly unknown[]): string => `${cells.map(csvCell).join(',')}\r\n`;

/** Paise → rupees with two decimals for spreadsheets: 31000 → '310.00', -5050 → '-50.50', null → '' */
export function rupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isSafeInteger(paise)) return '';
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Grams → kg with three decimals: 99500 → '99.500' */
export function kgText(grams: number | null | undefined): string {
  if (grams === null || grams === undefined || !Number.isSafeInteger(grams)) return '';
  const sign = grams < 0 ? '-' : '';
  const abs = Math.abs(grams);
  return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
}

export interface ExportOptions {
  /** first IST day included ('YYYY-MM-DD'); null = from the beginning */
  from?: string | null;
  /** last IST day included; null = up to now */
  to?: string | null;
  /** include customer name, phone, address, city and the order note */
  personal?: boolean;
}

export interface ExportFile {
  filename: string;
  /** with a UTF-8 byte order mark so spreadsheets read ₹ and Tamil correctly */
  csv: string;
  rows: number;
  /** true when EXPORT_MAX_ROWS cut the file short */
  truncated: boolean;
}

/** UTC [from, to) for IST days; anything not a date is ignored */
export function exportRange(o: ExportOptions): { from: string; to: string; label: string } {
  const from = o.from && isDate(o.from) ? o.from : null;
  const to = o.to && isDate(o.to) ? o.to : null;
  return {
    from: from ? istMidnight(from) : '0000-01-01T00:00:00Z',
    to: to ? istMidnight(addDays(to, 1)) : '9999-12-31T23:59:59Z',
    label: from || to ? `${from ?? 'start'}_to_${to ?? 'today'}` : 'all',
  };
}

const IST_TIME = (col: string) => `strftime('%Y-%m-%d %H:%M', ${col}, '+330 minutes')`;

const ORDER_HEAD = ['order_id', 'order_code', 'created_ist', 'status', 'source', 'channel', 'test_order', 'confirmed_ist',
  'items_total_rs', 'discount_rs', 'delivery_rs', 'total_rs', 'paid_rs', 'balance_rs', 'invoice_no', 'customer_saw_rs',
  'price_mismatch', 'needed_by', 'bulk', 'replied_ist', 'cancel_reason'];
const PERSONAL_HEAD = ['customer_name', 'customer_phone', 'customer_address', 'customer_city', 'note'];

/** Status words in exports (the same words the screens use) */
const STATUS_TEXT: Record<string, string> = {
  new: 'New', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Sent', delivered: 'Delivered', cancelled: 'Cancelled', spam: 'Not a real order',
};

/**
 * Builds one CSV export. Ranges are IST days on: orders and order_lines → when the order was made (created);
 * monthly_by_product → when it was confirmed (sales only); stock_moves → when the move was made.
 * Spam orders are never exported; test orders are, with test_order = yes.
 */
export async function exportCsv(db: D1, name: ExportName, opts: ExportOptions = {}, at: string = nowIso()): Promise<ExportFile> {
  const r = exportRange(opts);
  const personal = opts.personal === true;
  const limit = EXPORT_MAX_ROWS + 1;
  let head: string[];
  let lines: unknown[][];

  if (name === 'orders') {
    const rows = await all<Record<string, unknown>>(db, `SELECT o.id, o.ref, ${IST_TIME('o.created_at')} AS created, o.status, o.source, o.channel, o.is_test,
        ${IST_TIME('o.confirmed_at')} AS confirmed, o.items_total_paise, o.discount_paise, o.delivery_paise, o.total_paise, o.paid_paise,
        o.invoice_no, o.shown_total_paise, o.price_mismatch, o.needed_by, o.is_bulk, ${IST_TIME('o.replied_at')} AS replied, o.cancel_reason,
        o.customer_name, o.customer_phone, o.customer_address, o.customer_city, o.note
      FROM orders o WHERE o.status <> 'spam' AND o.created_at >= ? AND o.created_at < ? ORDER BY o.created_at, o.id LIMIT ?`, r.from, r.to, limit);
    head = personal ? [...ORDER_HEAD, ...PERSONAL_HEAD] : ORDER_HEAD;
    lines = rows.map((o) => {
      const base = [o.id, o.ref, o.created, STATUS_TEXT[o.status as string] ?? o.status, o.source, o.channel, o.is_test === 1,
        o.confirmed, rupees(o.items_total_paise as number), rupees(o.discount_paise as number), rupees(o.delivery_paise as number),
        rupees(o.total_paise as number), rupees(o.paid_paise as number), rupees((o.total_paise as number) - (o.paid_paise as number)),
        o.invoice_no, rupees(o.shown_total_paise as number | null), o.price_mismatch === 1, o.needed_by, o.is_bulk === 1, o.replied, o.cancel_reason];
      return personal ? [...base, o.customer_name, o.customer_phone, o.customer_address, o.customer_city, o.note] : base;
    });
  } else if (name === 'order_lines') {
    const rows = await all<Record<string, unknown>>(db, `SELECT o.id AS order_id, o.ref, o.status, ${IST_TIME('o.created_at')} AS created,
        ${IST_TIME('o.confirmed_at')} AS confirmed, o.is_test, l.kind, l.name_snapshot, l.pack_snapshot, v.code, l.qty, l.unit_price_paise,
        l.line_total_paise, l.list_price_paise, l.price_note, l.qty * COALESCE(l.net_grams, v.net_grams, 0) AS grams
      FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN variants v ON v.id = l.variant_id
      WHERE o.status <> 'spam' AND o.created_at >= ? AND o.created_at < ? ORDER BY o.created_at, o.id, l.sort, l.id LIMIT ?`, r.from, r.to, limit);
    head = ['order_id', 'order_code', 'order_status', 'created_ist', 'confirmed_ist', 'test_order', 'line_kind', 'item', 'pack', 'pack_code',
      'qty', 'unit_price_rs', 'line_total_rs', 'list_price_rs', 'price_note', 'honey_kg'];
    lines = rows.map((l) => [l.order_id, l.ref, STATUS_TEXT[l.status as string] ?? l.status, l.created, l.confirmed, l.is_test === 1,
      l.kind === 'item' ? 'item' : l.kind === 'fee' ? 'charge' : 'other item', l.name_snapshot, l.pack_snapshot, l.code, l.qty,
      rupees(l.unit_price_paise as number | null), rupees(l.line_total_paise as number), rupees(l.list_price_paise as number | null),
      l.price_note, (l.grams as number) > 0 ? kgText(l.grams as number) : '']);
  } else if (name === 'monthly_by_product') {
    const rows = await all<Record<string, unknown>>(db, `SELECT strftime('%Y-%m', o.confirmed_at, '+330 minutes') AS month,
        COALESCE(c.name, '') AS category, COALESCE(p.name, CASE l.kind WHEN 'fee' THEN 'Charges' ELSE 'Other items' END) AS product,
        COALESCE(v.label, l.pack_snapshot) AS pack, v.code, COUNT(DISTINCT o.id) AS orders, SUM(l.qty) AS units,
        SUM(l.line_total_paise) AS paise, SUM(l.qty * COALESCE(l.net_grams, 0)) AS grams
      FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN variants v ON v.id = l.variant_id
        LEFT JOIN products p ON p.id = l.product_id LEFT JOIN categories c ON c.id = p.category
      WHERE o.status IN ('confirmed', 'packed', 'shipped', 'delivered') AND o.is_test = 0 AND o.confirmed_at >= ? AND o.confirmed_at < ?
      GROUP BY month, l.kind, l.product_id, l.variant_id, CASE WHEN l.variant_id IS NULL THEN l.pack_snapshot END
      ORDER BY month, COALESCE(p.sort, 1000000), p.name, COALESCE(v.sort, 0), pack LIMIT ?`, r.from, r.to, limit);
    head = ['month', 'category', 'product', 'pack', 'pack_code', 'orders', 'units', 'sales_rs', 'honey_kg'];
    lines = rows.map((x) => [x.month, x.category, x.product, x.pack, x.code, x.orders, x.units, rupees(x.paise as number),
      (x.grams as number) > 0 ? kgText(x.grams as number) : '']);
  } else {
    const rows = await all<Record<string, unknown>>(db, `SELECT m.id, ${IST_TIME('m.created_at')} AS created, p.name AS product, s.name AS pool, s.unit,
        m.delta, m.reason, o.ref AS order_ref, m.harvest_id, m.note, m.created_by
      FROM stock_moves m JOIN stock_pools s ON s.id = m.pool_id JOIN products p ON p.id = s.product_id LEFT JOIN orders o ON o.id = m.order_id
      WHERE m.created_at >= ? AND m.created_at < ? ORDER BY m.id LIMIT ?`, r.from, r.to, limit);
    head = ['move_id', 'when_ist', 'product', 'stock_pool', 'unit', 'change', 'change_kg_or_pieces', 'reason', 'order_code', 'harvest_id', 'note', 'by'];
    lines = rows.map((m) => [m.id, m.created, m.product, m.pool, m.unit === 'g' ? 'grams' : 'pieces', m.delta,
      m.unit === 'g' ? kgText(m.delta as number) : m.delta, String(m.reason).replace('_', ' '), m.order_ref, m.harvest_id, m.note, m.created_by]);
  }

  const truncated = lines.length > EXPORT_MAX_ROWS;
  if (truncated) lines = lines.slice(0, EXPORT_MAX_ROWS);
  let csv = `﻿${csvLine(head)}`;
  for (const l of lines) csv += csvLine(l);
  if (truncated) csv += csvLine([`Only the first ${EXPORT_MAX_ROWS} rows. Choose a shorter date range for the rest.`]);
  const stamp = istDate(at);
  return { filename: `beezy-${name.replace(/_/g, '-')}-${r.label}-${stamp}.csv`, csv, rows: lines.length, truncated };
}
