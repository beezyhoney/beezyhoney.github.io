// The Prices screen (design §5 screen 7, owner only): one grid of every pack with price, MRP and "Price on WhatsApp",
// bulk changes (± % or ± ₹, rounded to ₹5) with a preview, a check for risky changes (more than 50 % or under ₹10:
// catches ₹35 typed for ₹350), the price history and Undo.
//
// A saved price is live on the website in about a minute (live_version + 1: /api/live.json) and the baked pages and
// Product JSON-LD follow with a rebuild (site_version + 1, effects.publish = 'now'). Drafts have no effects.
// Every save is one all-or-nothing batch (each pack's version is checked) with price_history rows and an audit row.
import { formatINR, perHundredGrams } from '../lib/money';
import {
  type Actor, type D1, type D1Statement, type Effects, type Result,
  all, auditInsert, fail, first, ok, ownerOnly, stmt, tryBatch,
} from './db';
import { multiRowGuards, type ProductStatus } from './products-admin';
import { bumpVersionStmt } from './settings';
import { nowIso } from './time';

export const MIN_PRICE = 100;          // ₹1 (database rule)
export const MAX_PRICE = 10_000_000;   // ₹1,00,000
export const ROUND_TO = 500;           // bulk changes round to ₹5
export const RISKY_RATIO = 0.5;        // a change of more than 50 % asks first
export const RISKY_BELOW = 1000;       // a price under ₹10 asks first

export interface PriceRow {
  variantId: number;
  version: number;
  code: string;
  productId: number;
  productName: string;
  productStatus: ProductStatus;
  category: string;
  label: string;
  netGrams: number | null;
  pricePaise: number | null;
  mrpPaise: number | null;
  active: boolean;
  /** ₹ per 100 g in paise (from the price), null without a price or weight */
  per100: number | null;
}

/** Every pack (retired products only when asked), in shop and pack order */
export async function listPriceGrid(db: D1, opts: { includeRetired?: boolean; includeInactive?: boolean } = {}): Promise<PriceRow[]> {
  const rows = await all<{ id: number; version: number; code: string; product_id: number; name: string; status: ProductStatus; category: string; label: string; net_grams: number | null; price_paise: number | null; mrp_paise: number | null; active: number }>(db,
    `SELECT v.id, v.version, v.code, v.product_id, p.name, p.status, p.category, v.label, v.net_grams, v.price_paise, v.mrp_paise, v.active
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE (? = 1 OR p.status <> 'retired') AND (? = 1 OR v.active = 1)
      ORDER BY p.sort, p.slug, v.sort, v.id`, opts.includeRetired ? 1 : 0, opts.includeInactive ? 1 : 0);
  return rows.map((r) => ({
    variantId: r.id, version: r.version, code: r.code, productId: r.product_id, productName: r.name, productStatus: r.status,
    category: r.category, label: r.label, netGrams: r.net_grams, pricePaise: r.price_paise, mrpPaise: r.mrp_paise, active: r.active === 1,
    per100: perHundredGrams(r.price_paise, r.net_grams),
  }));
}

// ───────────────────────────── pure rules ─────────────────────────────

/** Rounds paise to the nearest ₹5 (half up), never below ₹5 */
export function roundToFive(paise: number): number {
  return Math.max(ROUND_TO, Math.round(paise / ROUND_TO) * ROUND_TO);
}

export type BulkMode = 'pct' | 'rs';

/**
 * A bulk change of one price: `amount` is a signed percent (mode 'pct', e.g. 10 or −5) or signed paise (mode 'rs',
 * e.g. 2000 = +₹20). The result is rounded to ₹5 and kept within ₹5 … ₹1,00,000. null stays null.
 */
export function bulkPrice(paise: number | null, mode: BulkMode, amount: number): number | null {
  if (paise === null) return null;
  const raw = mode === 'pct' ? paise * (1 + amount / 100) : paise + amount;
  return Math.min(MAX_PRICE, roundToFive(raw));
}

export interface PriceChange {
  variantId: number;
  version: number;
  pricePaise: number | null;
  mrpPaise: number | null;
}

/** The bulk preview: new price and MRP for each pack with a price (packs without a price are left out) */
export function bulkPreview(rows: PriceRow[], mode: BulkMode, amount: number): (PriceChange & { row: PriceRow })[] {
  const out: (PriceChange & { row: PriceRow })[] = [];
  for (const r of rows) {
    if (r.pricePaise === null) continue;
    const price = bulkPrice(r.pricePaise, mode, amount)!;
    let mrp = bulkPrice(r.mrpPaise, mode, amount);
    if (mrp !== null && mrp <= price) mrp = null;
    if (price === r.pricePaise && mrp === r.mrpPaise) continue;
    out.push({ variantId: r.variantId, version: r.version, pricePaise: price, mrpPaise: mrp, row: r });
  }
  return out;
}

/** Why a change needs a second look: 'big' (more than 50 % up or down) or 'low' (under ₹10); null when fine */
export function riskOf(oldPaise: number | null, newPaise: number | null): 'big' | 'low' | null {
  if (newPaise === null) return null;
  if (newPaise < RISKY_BELOW) return 'low';
  if (oldPaise !== null && oldPaise > 0 && Math.abs(newPaise - oldPaise) / oldPaise > RISKY_RATIO) return 'big';
  return null;
}

/** The changes that need "Yes, save these prices" first */
export function riskyChanges<T extends { oldPaise: number | null; newPaise: number | null }>(changes: T[]): (T & { risk: 'big' | 'low' })[] {
  return changes.flatMap((c) => {
    const risk = riskOf(c.oldPaise, c.newPaise);
    return risk ? [{ ...c, risk }] : [];
  });
}

/** Checks one price/MRP pair; returns words for the owner or null. MRP equal to the price is stored as "same as price". */
export function checkPrice(price: number | null, mrp: number | null): string | null {
  if (price !== null && !(Number.isSafeInteger(price) && price >= MIN_PRICE && price <= MAX_PRICE)) return 'The price must be between ₹1 and ₹1,00,000, or empty for "Price on WhatsApp".';
  if (mrp !== null) {
    if (price === null) return 'An MRP needs a price. Enter the price too, or clear the MRP.';
    if (!(Number.isSafeInteger(mrp) && mrp <= MAX_PRICE)) return 'The MRP is too big.';
    if (mrp < price) return 'The MRP cannot be lower than the price.';
  }
  return null;
}

// ───────────────────────────── save ─────────────────────────────

export interface PricesSaved {
  changed: { variantId: number; productName: string; label: string; oldPrice: number | null; newPrice: number | null; oldMrp: number | null; newMrp: number | null }[];
  effects: Effects;
}

const money = (p: number | null) => (p === null ? 'Price on WhatsApp' : formatINR(p));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Saves price changes (Prices grid, bulk apply, undo), owner only, all or nothing. Unchanged rows are skipped.
 * Errors: forbidden, invalid (field 'price_<variantId>'), not_found, conflict (a pack changed meanwhile).
 */
export async function savePrices(db: D1, actor: Actor, input: { changes: PriceChange[]; reason?: string }, at: string = nowIso()): Promise<Result<PricesSaved>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const changes = input?.changes ?? [];
  if (!changes.length) return ok({ changed: [], effects: { publish: null, live: false } });
  if (changes.length > 200) return fail('invalid', 'Too many prices in one save.');
  const ids = new Set<number>();
  for (const c of changes) {
    if (!Number.isSafeInteger(c.variantId) || ids.has(c.variantId)) return fail('invalid', 'Each pack can be changed once per save.', { field: `price_${c.variantId}` });
    ids.add(c.variantId);
    const mrp = c.mrpPaise !== null && c.mrpPaise === c.pricePaise ? null : c.mrpPaise;
    const problem = checkPrice(c.pricePaise, mrp);
    if (problem) return fail('invalid', problem, { field: `price_${c.variantId}` });
  }
  const current = await all<{ id: number; version: number; price_paise: number | null; mrp_paise: number | null; label: string; name: string; status: ProductStatus }>(db,
    `SELECT v.id, v.version, v.price_paise, v.mrp_paise, v.label, p.name, p.status FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id IN (SELECT value FROM json_each(?))`, JSON.stringify([...ids]));
  const byId = new Map(current.map((r) => [r.id, r]));
  const real: { c: PriceChange; mrp: number | null; cur: (typeof current)[number] }[] = [];
  for (const c of changes) {
    const cur = byId.get(c.variantId);
    if (!cur) return fail('not_found', 'A pack on this page no longer exists. Reload the page.', { field: `price_${c.variantId}` });
    if (cur.version !== c.version) return fail('conflict', `${cur.name} ${cur.label} was changed by someone else meanwhile. Reload the page.`, { field: `price_${c.variantId}` });
    const mrp = c.mrpPaise !== null && c.mrpPaise === c.pricePaise ? null : c.mrpPaise;
    if (cur.price_paise === c.pricePaise && cur.mrp_paise === mrp) continue;
    real.push({ c, mrp, cur });
  }
  if (!real.length) return ok({ changed: [], effects: { publish: null, live: false } });

  const by = actor.email;
  const reason = (input.reason ?? '').trim().slice(0, 120) || null;
  const guards = multiRowGuards('variants', real.map((r) => ({ id: r.cur.id, version: r.cur.version })), at, by);
  const statements: D1Statement[] = real.map((r, k) => stmt(db, `UPDATE variants SET price_paise = ?, mrp_paise = ?, version = version + 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND version = ? AND ${guards.before(k).sql}`, r.c.pricePaise, r.mrp, at, by, r.cur.id, r.cur.version, ...guards.before(k).params));
  for (const r of real) {
    statements.push(stmt(db, `INSERT INTO price_history (variant_id, old_price_paise, new_price_paise, old_mrp_paise, new_mrp_paise, reason, at, by)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guards.after.sql}`, r.cur.id, r.cur.price_paise, r.c.pricePaise, r.cur.mrp_paise, r.mrp, reason, at, by, ...guards.after.params));
  }
  const live = real.some((r) => r.cur.status === 'live' || r.cur.status === 'paused');
  const site = real.some((r) => r.cur.status !== 'draft');
  if (live) statements.push(bumpVersionStmt(db, 'live_version', at, by, guards.after));
  if (site) statements.push(bumpVersionStmt(db, 'site_version', at, by, guards.after));
  const words = real.map((r) => {
    const bits = [`${r.cur.name} ${r.cur.label} ${money(r.cur.price_paise)} → ${money(r.c.pricePaise)}`];
    if (r.cur.mrp_paise !== r.mrp) bits.push(`MRP ${r.cur.mrp_paise === null ? 'same as price' : money(r.cur.mrp_paise)} → ${r.mrp === null ? 'same as price' : money(r.mrp)}`);
    return bits.join(', ');
  });
  statements.push(auditInsert(db, {
    at, actor, action: 'prices.save', entity: real.length === 1 ? 'variant' : 'variants', entityId: real.map((r) => r.cur.id).join(','),
    summary: clip(`${reason ? `${reason}: ` : real.length > 1 ? `${real.length} prices: ` : 'Price: '}${words.join('; ')}`, 500),
    before: Object.fromEntries(real.map((r) => [r.cur.id, [r.cur.price_paise, r.cur.mrp_paise]])),
    after: Object.fromEntries(real.map((r) => [r.cur.id, [r.c.pricePaise, r.mrp]])),
  }, guards.after));

  const res = await tryBatch(db, statements);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return fail('conflict', 'Someone else changed these prices meanwhile. Nothing was saved. Reload the page.');
  return ok({
    changed: real.map((r) => ({ variantId: r.cur.id, productName: r.cur.name, label: r.cur.label, oldPrice: r.cur.price_paise, newPrice: r.c.pricePaise, oldMrp: r.cur.mrp_paise, newMrp: r.mrp })),
    effects: { publish: site ? 'now' : null, live },
  });
}

// ───────────────────────────── history and undo ─────────────────────────────

export interface PriceHistoryRow {
  id: number;
  variantId: number;
  productName: string;
  label: string;
  oldPrice: number | null;
  newPrice: number | null;
  oldMrp: number | null;
  newMrp: number | null;
  reason: string | null;
  at: string;
  by: string;
  /** true when the pack still has this change's new price and MRP, and it is the pack's latest change */
  canUndo: boolean;
}

/** Latest price changes, newest first (optionally for one pack) */
export async function priceHistory(db: D1, opts: { variantId?: number; limit?: number; beforeId?: number } = {}): Promise<PriceHistoryRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const rows = await all<{ id: number; variant_id: number; name: string; label: string; old_price_paise: number | null; new_price_paise: number | null; old_mrp_paise: number | null; new_mrp_paise: number | null; reason: string | null; at: string; by: string; price_paise: number | null; mrp_paise: number | null; latest: number }>(db,
    `SELECT h.id, h.variant_id, p.name, v.label, h.old_price_paise, h.new_price_paise, h.old_mrp_paise, h.new_mrp_paise, h.reason, h.at, h.by,
        v.price_paise, v.mrp_paise, (SELECT MAX(h2.id) FROM price_history h2 WHERE h2.variant_id = h.variant_id) AS latest
       FROM price_history h JOIN variants v ON v.id = h.variant_id JOIN products p ON p.id = v.product_id
      WHERE (?1 IS NULL OR h.variant_id = ?1) AND h.id < ?2 ORDER BY h.id DESC LIMIT ?3`,
  opts.variantId ?? null, opts.beforeId ?? Number.MAX_SAFE_INTEGER, limit);
  return rows.map((r) => ({
    id: r.id, variantId: r.variant_id, productName: r.name, label: r.label, oldPrice: r.old_price_paise, newPrice: r.new_price_paise,
    oldMrp: r.old_mrp_paise, newMrp: r.new_mrp_paise, reason: r.reason, at: r.at, by: r.by,
    canUndo: r.latest === r.id && r.price_paise === r.new_price_paise && r.mrp_paise === r.new_mrp_paise && (r.reason ?? '') !== 'New pack',
  }));
}

/**
 * Undo one price change: puts the pack back to the old price and MRP, if nothing changed it since
 * (otherwise 'conflict'). Recorded as a new change ("Undo of …"), so it can itself be undone.
 */
export async function undoPriceChange(db: D1, actor: Actor, input: { historyId: number }, at: string = nowIso()): Promise<Result<PricesSaved>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const h = await first<{ id: number; variant_id: number; old_price_paise: number | null; new_price_paise: number | null; old_mrp_paise: number | null; new_mrp_paise: number | null; at: string }>(db,
    'SELECT id, variant_id, old_price_paise, new_price_paise, old_mrp_paise, new_mrp_paise, at FROM price_history WHERE id = ?', input?.historyId);
  if (!h) return fail('not_found', 'This price change was not found.');
  const v = await first<{ version: number; price_paise: number | null; mrp_paise: number | null; latest: number }>(db,
    'SELECT version, price_paise, mrp_paise, (SELECT MAX(id) FROM price_history WHERE variant_id = ?1) AS latest FROM variants WHERE id = ?1', h.variant_id);
  if (!v) return fail('not_found', 'This pack no longer exists.');
  if (v.latest !== h.id || v.price_paise !== h.new_price_paise || v.mrp_paise !== h.new_mrp_paise) {
    return fail('conflict', 'The price was changed again after this, so this change cannot be undone. Change the price on the grid instead.');
  }
  return savePrices(db, actor, {
    changes: [{ variantId: h.variant_id, version: v.version, pricePaise: h.old_price_paise, mrpPaise: h.old_mrp_paise }],
    reason: `Undo of the change on ${h.at.slice(0, 10)}`,
  }, at);
}
