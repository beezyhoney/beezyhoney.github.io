// Read helpers for the ops screens (orders, requests, website, people, backup, help) that src/server does not have
// yet. Plain SQL over the D1 binding, following the src/server conventions (src/server/README.md): reads are
// fn(db, …) → Promise<T>, nothing here writes. The integrator may move them into src/server/ later.
import { formatINR } from '../../lib/money';
import { type D1, all, first } from '../../server/db';
import type { GiftDetails, OrderStatus } from '../../server/orders';
import { istDate, nowIso } from '../../server/time';

// ───────────────────────────── packs for the order forms ─────────────────────────────

export interface PackChoice {
  variantId: number;
  code: string;
  productId: number;
  /** 'Murungai Honey with comb' (the name customers and orders use) */
  productName: string;
  label: string;
  pricePaise: number | null;
  /** sold now: pack active and product live or paused */
  current: boolean;
}

/** Every pack of every non-draft product, in shop order (inactive packs and retired products marked not current) */
export async function packChoices(db: D1): Promise<PackChoice[]> {
  const rows = await all<{ id: number; code: string; product_id: number; name: string; with_comb: number; label: string; price_paise: number | null; active: number; status: string }>(db,
    `SELECT v.id, v.code, v.product_id, p.name, p.with_comb, v.label, v.price_paise, v.active, p.status
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.status <> 'draft' ORDER BY p.status = 'retired', p.sort, p.id, v.sort, v.id`);
  return rows.map((r) => ({
    variantId: r.id, code: r.code, productId: r.product_id, productName: r.name + (r.with_comb === 1 ? ' with comb' : ''),
    label: r.label, pricePaise: r.price_paise, current: r.active === 1 && (r.status === 'live' || r.status === 'paused'),
  }));
}

/**
 * Option groups for a pack <Select>: current packs, grouped by product, labelled '250 g · ₹310' (or 'price on
 * WhatsApp'). `keep` adds packs that are no longer sold but sit on an existing line, so the select can show them.
 */
export function packGroups(packs: PackChoice[], keep: (number | null | undefined)[] = [], noPrice = 'no price yet'):
  { label: string; options: { value: number; label: string }[] }[] {
  const keepSet = new Set(keep.filter((v): v is number => typeof v === 'number'));
  const groups = new Map<string, { label: string; options: { value: number; label: string }[] }>();
  for (const p of packs) {
    if (!p.current && !keepSet.has(p.variantId)) continue;
    const g = groups.get(p.productName) ?? { label: p.productName, options: [] };
    const price = p.pricePaise === null ? noPrice : formatINR(p.pricePaise);
    g.options.push({ value: p.variantId, label: `${p.label} · ${price}${p.current ? '' : ' (no longer sold)'}` });
    groups.set(p.productName, g);
  }
  return [...groups.values()];
}

/** Products for the orders filter (non-draft, shop order) */
export async function productChoices(db: D1): Promise<{ id: number; name: string }[]> {
  const rows = await all<{ id: number; name: string; with_comb: number }>(db,
    "SELECT id, name, with_comb FROM products WHERE status <> 'draft' ORDER BY status = 'retired', sort, id");
  return rows.map((r) => ({ id: r.id, name: r.name + (r.with_comb === 1 ? ' with comb' : '') }));
}

// ───────────────────────────── orders list ─────────────────────────────

export interface TabCounts { new: number; confirmed: number; to_send: number; unpaid: number; requests: number; spam: number }

/** Counts shown on the order tabs (one query) */
export async function tabCounts(db: D1): Promise<TabCounts> {
  const r = await first<Record<string, number>>(db, `SELECT
      COALESCE(SUM(status = 'new'), 0) AS n, COALESCE(SUM(status = 'confirmed'), 0) AS c,
      COALESCE(SUM(status IN ('confirmed', 'packed')), 0) AS s,
      COALESCE(SUM(status IN ('confirmed', 'packed', 'shipped', 'delivered') AND paid_paise < total_paise), 0) AS u,
      COALESCE(SUM((source = 'gift' OR is_bulk = 1 OR gift_json IS NOT NULL) AND replied_at IS NULL AND status NOT IN ('cancelled', 'spam')), 0) AS r,
      COALESCE(SUM(status = 'spam'), 0) AS x
    FROM orders`);
  return { new: r?.n ?? 0, confirmed: r?.c ?? 0, to_send: r?.s ?? 0, unpaid: r?.u ?? 0, requests: r?.r ?? 0, spam: r?.x ?? 0 };
}

// ───────────────────────────── requests inbox ─────────────────────────────

export interface RequestRow {
  id: number;
  ref: string;
  status: OrderStatus;
  source: string;
  createdAt: string;
  neededBy: string | null;
  repliedAt: string | null;
  isBulk: boolean;
  isTest: boolean;
  totalPaise: number;
  shownTotalPaise: number | null;
  gift: GiftDetails | null;
  items: string;
  customerName: string | null;
  /** days from today (IST) to the needed-by date; negative = past; null = no date */
  daysLeft: number | null;
}

/**
 * Gift and bulk requests (orders with source 'gift' or is_bulk), sorted by needed-by date (no date last), then
 * oldest first. `open` (default) hides cancelled, delivered and spam ones; `unanswered` also hides replied ones.
 */
export async function listRequests(db: D1, opts: { show?: 'open' | 'unanswered' | 'all'; at?: string; limit?: number } = {}): Promise<RequestRow[]> {
  const show = opts.show ?? 'open';
  const at = opts.at ?? nowIso();
  const where = ["(o.source = 'gift' OR o.is_bulk = 1 OR o.gift_json IS NOT NULL)", "o.status <> 'spam'"];
  if (show !== 'all') where.push("o.status NOT IN ('cancelled', 'delivered')");
  if (show === 'unanswered') where.push('o.replied_at IS NULL');
  const rows = await all<{ id: number; ref: string; status: OrderStatus; source: string; created_at: string; needed_by: string | null; replied_at: string | null; is_bulk: number; is_test: number; total_paise: number; shown_total_paise: number | null; gift_json: string | null; customer_name: string | null; items: string | null }>(db,
    `SELECT o.id, o.ref, o.status, o.source, o.created_at, o.needed_by, o.replied_at, o.is_bulk, o.is_test, o.total_paise, o.shown_total_paise,
        o.gift_json, o.customer_name,
        (SELECT group_concat(x.t, ', ') FROM (SELECT l.name_snapshot || CASE WHEN l.pack_snapshot <> '' THEN ' ' || l.pack_snapshot ELSE '' END
           || ' × ' || l.qty AS t FROM order_lines l WHERE l.order_id = o.id ORDER BY l.sort, l.id) x) AS items
       FROM orders o WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(o.needed_by, '9999-12-31'), o.created_at LIMIT ?`, Math.min(Math.max(opts.limit ?? 100, 1), 300));
  const today = istDate(at);
  return rows.map((r) => {
    let gift: GiftDetails | null = null;
    try { gift = r.gift_json ? (JSON.parse(r.gift_json) as GiftDetails) : null; } catch { gift = null; }
    return {
      id: r.id, ref: r.ref, status: r.status, source: r.source, createdAt: r.created_at, neededBy: r.needed_by, repliedAt: r.replied_at,
      isBulk: r.is_bulk === 1, isTest: r.is_test === 1, totalPaise: r.total_paise, shownTotalPaise: r.shown_total_paise, gift,
      items: r.items ?? '', customerName: r.customer_name,
      daysLeft: r.needed_by ? Math.round((Date.parse(`${r.needed_by}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null,
    };
  });
}

// ───────────────────────────── website settings ─────────────────────────────

export interface ShowPricesChecklist {
  /** active packs of live / paused products without a price (they show "Price on WhatsApp") */
  unpriced: { product: string; label: string }[];
  packerAddress: boolean;
  customerCare: boolean;
  fssai: boolean;
}

/** What to check before switching "Show prices" on */
export async function showPricesChecklist(db: D1, business: { packerAddress: string | null; customerCare: string | null; fssai: string | null }): Promise<ShowPricesChecklist> {
  const rows = await all<{ name: string; with_comb: number; label: string }>(db,
    `SELECT p.name, p.with_comb, v.label FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.active = 1 AND v.price_paise IS NULL AND p.status IN ('live', 'paused') ORDER BY p.sort, v.sort`);
  return {
    unpriced: rows.map((r) => ({ product: r.name + (r.with_comb === 1 ? ' with comb' : ''), label: r.label })),
    packerAddress: !!business.packerAddress?.trim(),
    customerCare: !!business.customerCare?.trim(),
    fssai: !!business.fssai?.trim(),
  };
}

export interface CategoryRow { id: string; name: string; title: string; intro: string; image: string; isHoney: boolean; sort: number; version: number }

export async function listCategories(db: D1): Promise<CategoryRow[]> {
  const rows = await all<{ id: string; name: string; title: string; intro: string; image: string; is_honey: number; sort: number; version: number }>(db,
    'SELECT id, name, title, intro, image, is_honey, sort, version FROM categories ORDER BY sort, id');
  return rows.map((r) => ({ id: r.id, name: r.name, title: r.title, intro: r.intro, image: r.image, isHoney: r.is_honey === 1, sort: r.sort, version: r.version }));
}

export interface ImageRow { path: string; source: 'repo' | 'upload'; thumbPath: string | null; width: number; height: number }

/** Photos a category may use: the website's own photos and uploads */
export async function listImages(db: D1): Promise<ImageRow[]> {
  const rows = await all<{ path: string; source: 'repo' | 'upload'; thumb_path: string | null; width: number; height: number }>(db,
    'SELECT path, source, thumb_path, width, height FROM images ORDER BY source, path');
  return rows.map((r) => ({ path: r.path, source: r.source, thumbPath: r.thumb_path, width: r.width, height: r.height }));
}

export interface PublishRow {
  id: number; siteVersion: number; reason: string; requestedAt: string; requestedBy: string; status: 'requested' | 'live' | 'failed';
  liveAt: string | null; error: string | null; httpStatus: number | null; alreadyQueued: boolean;
}

/** Publish history, newest first */
export async function publishHistory(db: D1, limit = 15): Promise<PublishRow[]> {
  const rows = await all<{ id: number; site_version: number; reason: string; requested_at: string; requested_by: string; status: PublishRow['status']; live_at: string | null; error: string | null; http_status: number | null; already_queued: number | null }>(db,
    'SELECT id, site_version, reason, requested_at, requested_by, status, live_at, error, http_status, already_queued FROM publishes ORDER BY id DESC LIMIT ?',
    Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => ({
    id: r.id, siteVersion: r.site_version, reason: r.reason, requestedAt: r.requested_at, requestedBy: r.requested_by, status: r.status,
    liveAt: r.live_at, error: r.error, httpStatus: r.http_status, alreadyQueued: r.already_queued === 1,
  }));
}

// ───────────────────────────── people ─────────────────────────────

export interface HelperRow { email: string; name: string | null; active: boolean; addedAt: string; addedBy: string; lastSeenAt: string | null; version: number }

export async function listHelpers(db: D1): Promise<HelperRow[]> {
  const rows = await all<{ email: string; name: string | null; active: number; added_at: string; added_by: string; last_seen_at: string | null; version: number }>(db,
    'SELECT email, name, active, added_at, added_by, last_seen_at, version FROM admin_users ORDER BY active DESC, email');
  return rows.map((r) => ({ email: r.email, name: r.name, active: r.active === 1, addedAt: r.added_at, addedBy: r.added_by, lastSeenAt: r.last_seen_at, version: r.version }));
}

/** Owner emails from the ADMIN_EMAILS secret (comma-separated), lower-case, without blanks */
export function ownerEmails(secret: unknown): string[] {
  return String(secret ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));
}

// ───────────────────────────── backup and test data ─────────────────────────────

/** Test orders still in the database (rehearsal orders, amendment A4) */
export async function testOrderCount(db: D1): Promise<number> {
  const r = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM orders WHERE is_test = 1');
  return r?.n ?? 0;
}

/** Row counts of the backed-up tables (Backup screen, "Download everything") */
export async function tableCounts(db: D1, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!tables.every((t) => /^[a-z_][a-z0-9_]*$/.test(t))) throw new Error('bad table name');
  if (!tables.length) return out;
  // one statement per table (a compound SELECT may have at most 5 terms on D1), all in one read batch
  const res = await db.batch(tables.map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`)));
  tables.forEach((t, i) => { out[t] = Number((res[i].results[0] as { n: number } | undefined)?.n ?? 0); });
  return out;
}
