// Public order intake: the body of POST /api/orders.json (contract 3, design §2.3).
// The endpoint answers 204 whatever happens; this module decides what is stored:
//   1. parseIntakeBody(): size, JSON, schema (ref alphabet, 32-hex key, 1–30 items, qty 1–99) — bad bodies store nothing
//   2. recordOrder(): rate counters (IP hash per hour → over the limit is stored as 'spam'; all orders per IST day →
//      over the cap nothing is stored), the Pause switch, then ONE guarded batch that upserts the order by its key,
//      replaces its lines priced from D1 (never from the client), and sets totals and flags.
// A resend of the same cart updates the same record while it is New/spam and untouched by the owner; once the owner
// edited or confirmed it, a resend changes nothing. No personal data is accepted.
// handleIntake() is the whole HTTP side of the endpoint (Origin / Sec-Fetch-Site, 8 KB read limit, always 204).
import { isKey, isRef } from '../lib/orderRef';
import { packAvailability, publicAvail, type AvailabilityOverride } from '../lib/availability';
import type { StockDisplay } from '../data/catalog.types';
import { type D1, PUBLIC_ACTOR, batch, stmt } from './db';
import { dayBucket, hitStmt, ipHash, ipHourBucket } from './ratelimit';
import { settingsFromRows } from './settings';
import { addTime, isDate, nowIso } from './time';

export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_ITEMS = 30;
const SOURCES = ['cart', 'product', 'gift'] as const;

export interface IntakeItem { c: string; s: string; p: string; q: number }
export interface IntakeGift { size: number | null; jar: string | null; picks: string[]; extras: string[]; boxes: number | null; occasion: string | null; neededBy: string | null; card: string | null }
export interface IntakeBody {
  v: 1;
  ref: string;
  key: string;
  src: (typeof SOURCES)[number];
  items: IntakeItem[];
  shown: number | null;
  lv: number | null;
  gift?: IntakeGift;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= max ? s : null;
};
const strList = (v: unknown, maxItems: number, maxLen: number): string[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems) return null;
  const out: string[] = [];
  for (const x of v) {
    const s = str(x, maxLen);
    if (s === null) return null;
    out.push(s);
  }
  return out;
};
const intOrNull = (v: unknown, min: number, max: number): number | null | undefined => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : undefined;
};

/** Validates the raw request body. Returns the clean body, or the reason it is refused (nothing is stored). */
export function parseIntakeBody(text: string): { ok: true; body: IntakeBody } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'no body' };
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, reason: 'too large' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: 'not JSON' }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  const b = raw as Record<string, unknown>;
  if (b.v !== 1) return { ok: false, reason: 'unknown version' };
  if (!isRef(b.ref)) return { ok: false, reason: 'bad ref' };
  if (!isKey(b.key)) return { ok: false, reason: 'bad key' };
  if (!SOURCES.includes(b.src as IntakeBody['src'])) return { ok: false, reason: 'bad src' };
  // a gift request may have no priced line (its honeys are in gift.picks), every other order needs one
  const minItems = b.src === 'gift' && typeof b.gift === 'object' && b.gift !== null ? 0 : 1;
  if (!Array.isArray(b.items) || b.items.length < minItems || b.items.length > MAX_ITEMS) return { ok: false, reason: 'bad items' };
  const items: IntakeItem[] = [];
  for (const it of b.items) {
    if (typeof it !== 'object' || it === null) return { ok: false, reason: 'bad item' };
    const i = it as Record<string, unknown>;
    const q = i.q;
    if (!Number.isSafeInteger(q) || (q as number) < 1 || (q as number) > 99) return { ok: false, reason: 'bad qty' };
    const c = typeof i.c === 'string' && i.c.length <= 80 && /^[a-z0-9:-]*$/.test(i.c) ? i.c : null;
    const s = typeof i.s === 'string' && i.s.length <= 60 ? i.s.trim() : null;
    const p = typeof i.p === 'string' && i.p.length <= 40 ? i.p.trim() : null;
    if (c === null || s === null || p === null || (!c && !s)) return { ok: false, reason: 'bad item' };
    items.push({ c, s, p, q: q as number });
  }
  const shown = intOrNull(b.shown, 0, 1_000_000_000);
  const lv = intOrNull(b.lv, 0, Number.MAX_SAFE_INTEGER);
  if (shown === undefined || lv === undefined) return { ok: false, reason: 'bad totals' };
  const body: IntakeBody = { v: 1, ref: b.ref, key: b.key, src: b.src as IntakeBody['src'], items, shown, lv };
  if (b.gift !== undefined && b.gift !== null) {
    if (typeof b.gift !== 'object' || Array.isArray(b.gift)) return { ok: false, reason: 'bad gift' };
    const g = b.gift as Record<string, unknown>;
    const size = intOrNull(g.size, 1, 100);
    const boxes = intOrNull(g.boxes, 1, 100_000);
    const picks = strList(g.picks, 20, 80);
    const extras = strList(g.extras, 10, 80);
    if (size === undefined || boxes === undefined || picks === null || extras === null) return { ok: false, reason: 'bad gift' };
    const neededBy = typeof g.neededBy === 'string' && isDate(g.neededBy) ? g.neededBy : null;
    body.gift = {
      size, jar: str(g.jar, 30), picks, extras, boxes, occasion: str(g.occasion, 80), neededBy,
      card: typeof g.card === 'string' ? g.card.trim().slice(0, 300) || null : null,
    };
  }
  return { ok: true, body };
}

export type IntakeOutcome = 'new' | 'spam' | 'updated' | 'unchanged' | 'paused' | 'daily_cap';

export interface IntakeResult {
  /** new: stored; spam: stored as spam (IP over the hourly limit); updated: the same cart sent again;
   *  unchanged: the order was already edited or confirmed by the owner; paused / daily_cap: nothing stored */
  outcome: IntakeOutcome;
  orderId: number | null;
}

interface LiveVariant {
  id: number; code: string; slug: string; label: string; price_paise: number | null; product_id: number; name: string; with_comb: number;
  status: string; active: number; pool_qty: number; track_stock: number; on_hand: number; low_at: number | null; availability: AvailabilityOverride;
}

/**
 * Stores (or updates) a website order. `ip` may be null (then only the daily cap applies). Never throws for
 * anything the visitor sent; a D1 failure is thrown so the endpoint can log it (and still answer 204).
 */
export async function recordOrder(db: D1, body: IntakeBody, meta: { ip: string | null; ipHashKey: string; at?: string }): Promise<IntakeResult> {
  const at = meta.at ?? nowIso();
  const hash = meta.ip ? await ipHash(meta.ipHashKey, meta.ip, at) : null;
  const pre = await batch(db, [
    hitStmt(db, dayBucket(at), addTime(at, { days: 2 })),
    hash ? hitStmt(db, ipHourBucket(hash, at), addTime(at, { hours: 2 })) : stmt(db, 'SELECT 0 AS count'),
    stmt(db, "SELECT key, value, version FROM settings WHERE key IN ('order_intake', 'gift', 'stock_display')"),
    stmt(db, `SELECT v.id, v.code, p.slug, v.label, v.price_paise, v.product_id, p.name, p.with_comb, p.status, v.active, v.pool_qty,
        s.track_stock, s.on_hand, s.low_at, s.availability
      FROM variants v JOIN products p ON p.id = v.product_id JOIN stock_pools s ON s.id = v.pool_id WHERE p.status <> 'draft'`),
  ]);
  const dayCount = (pre[0].results[0] as { count: number }).count;
  const ipCount = (pre[1].results[0] as { count: number }).count;
  const settings = settingsFromRows(pre[2].results as { key: string; value: string; version: number }[]).values;
  if (!settings.order_intake.enabled) return { outcome: 'paused', orderId: null };
  if (dayCount > settings.order_intake.perDay) return { outcome: 'daily_cap', orderId: null };
  const status = hash && ipCount > settings.order_intake.perIpHour ? 'spam' : 'new';

  // price the lines from D1: by code among live products' active packs, else by slug + label; unknown → custom
  const variants = pre[3].results as unknown as LiveVariant[];
  const sellable = variants.filter((v) => v.status === 'live' && v.active === 1);
  const byCode = new Map(sellable.map((v) => [v.code, v]));
  const bySlugLabel = new Map(sellable.map((v) => [`${v.slug}\u0000${v.label}`, v]));
  const nameOfSlug = new Map(variants.map((v) => [v.slug, v.name + (v.with_comb === 1 ? ' with comb' : '')]));
  const display = settings.stock_display as StockDisplay;
  const flags: { unknown: { c: string; s: string; p: string }[]; soldOut: string[] } = { unknown: [], soldOut: [] };
  type L = { kind: 'item' | 'custom'; variantId: number | null; productId: number | null; name: string; pack: string; qty: number; unit: number | null };
  const lines: L[] = [];
  const seen = new Map<string, number>();
  for (const it of body.items) {
    const v = byCode.get(it.c) ?? bySlugLabel.get(`${it.s}\u0000${it.p}`);
    const key = v ? `v${v.id}` : `c${it.s}\u0000${it.p}\u0000${it.c}`;
    const prev = seen.get(key);
    if (prev !== undefined) { lines[prev].qty = Math.min(999, lines[prev].qty + it.q); continue; }
    seen.set(key, lines.length);
    if (v) {
      const avail = publicAvail(packAvailability({ trackStock: v.track_stock === 1, onHand: v.on_hand, lowAt: v.low_at, availability: v.availability }, v.pool_qty), display);
      if (avail === 'out') flags.soldOut.push(v.code);
      lines.push({ kind: 'item', variantId: v.id, productId: v.product_id, name: v.name + (v.with_comb === 1 ? ' with comb' : ''), pack: v.label, qty: it.q, unit: v.price_paise });
    } else {
      flags.unknown.push({ c: it.c, s: it.s, p: it.p });
      lines.push({ kind: 'custom', variantId: null, productId: null, name: (nameOfSlug.get(it.s) ?? (it.s || it.c)).slice(0, 120), pack: it.p.slice(0, 60), qty: it.q, unit: null });
    }
  }
  const itemsTotal = lines.reduce((s, l) => s + l.qty * (l.unit ?? 0), 0);
  const flagsJson = flags.unknown.length || flags.soldOut.length
    ? JSON.stringify({ ...(flags.unknown.length ? { unknown: flags.unknown } : {}), ...(flags.soldOut.length ? { soldOut: flags.soldOut } : {}) })
    : null;
  const gift = body.src === 'gift' && body.gift ? body.gift : null;
  const isBulk = gift?.boxes != null && gift.boxes >= settings.gift.bulkFrom;
  const op = crypto.randomUUID();
  const lineData = JSON.stringify(lines.map((l, i) => [l.kind, l.variantId, l.productId, l.name, l.pack, l.qty, l.unit, l.unit, l.qty * (l.unit ?? 0), i + 1]));
  const col = (i: number) => `json_extract(j.value, '$[${i}]')`;

  const res = await batch(db, [
    stmt(db, `INSERT INTO orders (ref, client_key, source, channel, status, shown_total_paise, shown_live_version, gift_json, is_bulk, needed_by,
        ip_hash, created_at, updated_at, updated_by, version, last_op)
      VALUES (?1, ?2, ?3, 'website', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, 1, ?13)
      ON CONFLICT(client_key) DO UPDATE SET source = excluded.source, shown_total_paise = excluded.shown_total_paise,
        shown_live_version = excluded.shown_live_version, gift_json = excluded.gift_json, is_bulk = excluded.is_bulk,
        needed_by = excluded.needed_by, updated_at = excluded.updated_at, last_op = excluded.last_op, version = orders.version + 1
      WHERE orders.status IN ('new', 'spam') AND orders.ref = excluded.ref AND orders.updated_by = ?12`,
    body.ref, body.key, body.src, status, body.shown, body.lv, gift ? JSON.stringify(gift) : null, isBulk, gift?.neededBy ?? null,
    hash, at, PUBLIC_ACTOR, op),
    stmt(db, 'DELETE FROM order_lines WHERE order_id = (SELECT id FROM orders WHERE client_key = ? AND last_op = ?)', body.key, op),
    stmt(db, `INSERT INTO order_lines (order_id, kind, variant_id, product_id, name_snapshot, pack_snapshot, qty, unit_price_paise,
        list_price_paise, line_total_paise, sort)
      SELECT o.id, ${Array.from({ length: 10 }, (_, i) => col(i)).join(', ')} FROM orders o, json_each(?) j WHERE o.client_key = ? AND o.last_op = ?`,
    lineData, body.key, op),
    stmt(db, `UPDATE orders SET items_total_paise = ?1, total_paise = ?1 - discount_paise + delivery_paise,
        price_mismatch = CASE WHEN shown_total_paise IS NOT NULL AND shown_total_paise <> ?1 THEN 1 ELSE 0 END, flags_json = ?2
      WHERE client_key = ?3 AND last_op = ?4`, itemsTotal, flagsJson, body.key, op),
    stmt(db, 'SELECT id, version, last_op = ? AS mine FROM orders WHERE client_key = ?', op, body.key),
  ]);
  const o = res[4].results[0] as { id: number; version: number; mine: number } | undefined;
  if (!o || o.mine !== 1) return { outcome: 'unchanged', orderId: o?.id ?? null };
  return { outcome: o.version === 1 ? status : 'updated', orderId: o.id };
}

// ───────────────────────────── the HTTP side: POST /api/orders.json ─────────────────────────────

export interface IntakeEnv {
  DB: D1;
  IP_HASH_KEY?: string;
  /** comma-separated public host names (wrangler.jsonc vars) */
  PUBLIC_HOSTS?: string;
}

/**
 * Same-origin proof for an order record (design §2.3): `Sec-Fetch-Site`, when the browser sends it, must be
 * 'same-origin', and `Origin` must be present, equal to the request's own origin, on a public host.
 */
export function intakeOriginOk(request: Request, url: URL, publicHosts: string): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site.toLowerCase() !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.origin !== url.origin) return false;
  const hosts = publicHosts.split(',').map((h) => h.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
  return hosts.includes(o.hostname.toLowerCase());
}

/** The body as UTF-8 text, or null when it is longer than `max` bytes (stops reading there) or not valid UTF-8. */
export async function readBodyLimited(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * POST /api/orders.json. Always 204 with no body (contract 3), whatever was sent: a refused request stores nothing,
 * a good one is stored by recordOrder() inside waitUntil (awaited when there is no ctx, e.g. in tests). A D1 error is
 * logged, never shown.
 */
export async function handleIntake(
  e: IntakeEnv,
  request: Request,
  opts: { ctx?: { waitUntil(p: Promise<unknown>): void } | null; at?: string } = {},
): Promise<Response> {
  const done = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  const url = new URL(request.url);
  if (!intakeOriginOk(request, url, String(e.PUBLIC_HOSTS ?? ''))) return done();
  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) return done();
  const parsed = parseIntakeBody(text);
  if (!parsed.ok) return done();
  const work = recordOrder(e.DB, parsed.body, { ip: request.headers.get('cf-connecting-ip'), ipHashKey: String(e.IP_HASH_KEY ?? ''), at: opts.at })
    .then(() => undefined, (err: unknown) => console.error('[orders] intake failed:', err instanceof Error ? err.message : err));
  if (opts.ctx) opts.ctx.waitUntil(work);
  else await work;
  return done();
}
