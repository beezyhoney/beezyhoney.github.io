// Invoices (design §5 v2 "Invoice", amendment A5): the print page's data and the invoice list.
//
// Numbers come from orders.ts assignInvoiceNo(): 'BZ/2026-27/0001', gapless per Indian financial year (IST date
// when the number is given), counter and order changed in ONE guarded batch, so a number is used only when an order
// gets it, and asking again returns the same number. Only sold (confirmed / packed / sent / delivered), non-test
// orders get one. Viewing the page never uses a number; the owner presses "Make the invoice".
// The title is "Bill of supply" unless a GSTIN is set in the business details (then "Tax invoice").
import { amountInWords } from '../lib/money';
import { type Actor, type D1, type Result, all, first } from './db';
import { assignInvoiceNo, getOrder, SOLD, type OrderStatus } from './orders';
import { getSetting, type BusinessSettings } from './settings';
import { fyLabel, fyStartYear, istDate, nowIso } from './time';

export type InvoiceTitle = 'Tax invoice' | 'Bill of supply';

/** "Tax invoice" only when the business has a GSTIN (design §13 question 2) */
export function invoiceTitle(gstin: string | null | undefined): InvoiceTitle {
  return gstin && gstin.trim() ? 'Tax invoice' : 'Bill of supply';
}

/** '2026-27' from 'BZ/2026-27/0001', or null */
export function invoiceFy(invoiceNo: string | null | undefined): string | null {
  const m = /^BZ\/(\d{4}-\d{2})\/\d{4,}$/.exec(invoiceNo ?? '');
  return m ? m[1] : null;
}

export interface InvoiceLine {
  n: number;
  kind: 'item' | 'fee' | 'custom';
  name: string;
  pack: string;
  qty: number;
  unitPaise: number | null;
  totalPaise: number;
}

export interface InvoiceView {
  orderId: number;
  ref: string;
  status: OrderStatus;
  isTest: boolean;
  invoiceNo: string | null;
  /** IST day the number was given ('YYYY-MM-DD'), or null */
  invoiceDate: string | null;
  title: InvoiceTitle;
  business: BusinessSettings;
  customer: { name: string | null; phone: string | null; address: string | null; city: string | null };
  /** customer details were cleared by the privacy clean-up */
  customerCleared: boolean;
  lines: InvoiceLine[];
  itemsTotalPaise: number;
  discountPaise: number;
  deliveryPaise: number;
  totalPaise: number;
  paidPaise: number;
  balancePaise: number;
  amountWords: string;
  /** an invoice number can be given now */
  canInvoice: boolean;
  /** why not, in words (when canInvoice is false and there is no number yet) */
  reason: string | null;
  /** the financial year a new number would be counted in, e.g. '2026-27' */
  fy: string;
}

/** Everything the invoice print page shows, or null when the order does not exist */
export async function getInvoice(db: D1, id: number, at: string = nowIso()): Promise<InvoiceView | null> {
  const [detail, business] = await Promise.all([getOrder(db, id), getSetting(db, 'business')]);
  if (!detail) return null;
  const o = detail.order;
  const sold = (SOLD as readonly string[]).includes(o.status);
  let reason: string | null = null;
  if (!o.invoiceNo) {
    if (o.isTest) reason = 'This is a test order, so it gets no invoice number.';
    else if (!sold) reason = 'Only confirmed orders get an invoice. Confirm the order first.';
  }
  return {
    orderId: o.id,
    ref: o.ref,
    status: o.status,
    isTest: o.isTest,
    invoiceNo: o.invoiceNo,
    invoiceDate: o.invoicedAt ? istDate(o.invoicedAt) : null,
    title: invoiceTitle(business.gstin),
    business,
    customer: o.customer,
    customerCleared: o.personalClearedAt !== null,
    lines: detail.lines.map((l, i) => ({
      n: i + 1, kind: l.kind, name: l.name, pack: l.pack, qty: l.qty, unitPaise: l.unitPricePaise, totalPaise: l.lineTotalPaise,
    })),
    itemsTotalPaise: o.itemsTotalPaise,
    discountPaise: o.discountPaise,
    deliveryPaise: o.deliveryPaise,
    totalPaise: o.totalPaise,
    paidPaise: o.paidPaise,
    balancePaise: o.balancePaise,
    amountWords: amountInWords(o.totalPaise),
    canInvoice: !o.invoiceNo && sold && !o.isTest,
    reason,
    fy: fyLabel(fyStartYear(istDate(at))),
  };
}

/** "Make the invoice": gives the order its number (same number when asked again). Errors: not_found, not_allowed. */
export async function makeInvoice(db: D1, actor: Actor, input: { id: number }, at: string = nowIso()): Promise<Result<{ invoiceNo: string; already: boolean }>> {
  return assignInvoiceNo(db, actor, input, at);
}

export interface InvoiceListRow {
  orderId: number;
  ref: string;
  invoiceNo: string;
  invoiceDate: string;
  status: OrderStatus;
  totalPaise: number;
  paidPaise: number;
  customerName: string | null;
}

/** Invoices of one financial year ('2026-27'; default: the current one), newest number first */
export async function listInvoices(db: D1, opts: { fy?: string | null; at?: string } = {}): Promise<{ fy: string; rows: InvoiceListRow[]; years: string[] }> {
  const at = opts.at ?? nowIso();
  const fy = opts.fy && /^\d{4}-\d{2}$/.test(opts.fy) ? opts.fy : fyLabel(fyStartYear(istDate(at)));
  const prefix = `BZ/${fy}/`;
  const [rows, years] = await Promise.all([
    all<{ id: number; ref: string; invoice_no: string; invoiced_at: string; status: OrderStatus; total_paise: number; paid_paise: number; customer_name: string | null }>(db,
      `SELECT id, ref, invoice_no, invoiced_at, status, total_paise, paid_paise, customer_name FROM orders
        WHERE invoice_no IS NOT NULL AND substr(invoice_no, 1, length(?1)) = ?1 ORDER BY invoice_no DESC LIMIT 500`, prefix),
    all<{ fy: string }>(db, "SELECT DISTINCT substr(invoice_no, 4, 7) AS fy FROM orders WHERE invoice_no IS NOT NULL ORDER BY fy DESC"),
  ]);
  const yearList = years.map((y) => y.fy);
  if (!yearList.includes(fy)) yearList.unshift(fy);
  return {
    fy,
    years: yearList.sort().reverse(),
    rows: rows.map((r) => ({
      orderId: r.id, ref: r.ref, invoiceNo: r.invoice_no, invoiceDate: istDate(r.invoiced_at), status: r.status,
      totalPaise: r.total_paise, paidPaise: r.paid_paise, customerName: r.customer_name,
    })),
  };
}

/** Sold, non-test orders without an invoice number yet (newest first), for the invoice list */
export async function ordersWithoutInvoice(db: D1, limit = 50): Promise<{ orderId: number; ref: string; confirmedAt: string; totalPaise: number }[]> {
  const rows = await all<{ id: number; ref: string; confirmed_at: string; total_paise: number }>(db,
    `SELECT id, ref, confirmed_at, total_paise FROM orders WHERE invoice_no IS NULL AND is_test = 0
      AND status IN ('confirmed', 'packed', 'shipped', 'delivered') ORDER BY confirmed_at DESC LIMIT ?`, Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => ({ orderId: r.id, ref: r.ref, confirmedAt: r.confirmed_at, totalPaise: r.total_paise }));
}

/** The highest number given in a financial year (for the gapless check in tests and Help) */
export async function lastInvoiceNumber(db: D1, fy: string): Promise<number> {
  const r = await first<{ value: number }>(db, 'SELECT value FROM counters WHERE name = ?', `invoice:${fy}`);
  return r?.value ?? 0;
}
