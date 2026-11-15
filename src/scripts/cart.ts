// The order ("cart") kept in this browser, the order code, the WhatsApp text and the order record (design §2.2).
//
// The cart stores only { slug, name, pack, qty } plus, on newer items, the pack's variant `code`. Never prices
// and never personal details. Prices come from the live price table (live.ts) every time the order is shown.
// Items saved by an older version are matched to today's packs by code, else by product and pack label;
// a pack that no longer exists stays in the list as "No longer available" and is left out of the order.
//
// The order code and WhatsApp text helpers (src/lib/orderRef.ts, src/lib/orderMessage.ts) are a separate small file
// that is fetched only when an order is being made (loadOrderTools), so pages start with less JavaScript. Until it is
// there, an order still opens WhatsApp with the plain message the site always sent (no code, no record).
import { waLink, link } from '../data/site';
import type { MessageLine } from '../lib/orderMessage';
import { findCode, liveVersion, priceOf, showPrices, type Avail } from './live';

type MessageLib = typeof import('../lib/orderMessage');
type RefLib = typeof import('../lib/orderRef');
type OrderTools = Pick<MessageLib, 'buildOrderMessage' | 'buildGiftMessage' | 'giftEstimate'> & Pick<RefLib, 'newRef' | 'newKey' | 'isRef' | 'isKey'>;
let tools: OrderTools | null = null;
let toolsLoading: Promise<boolean> | null = null;

/**
 * Loads the order code and message helpers. Resolves true once they are ready, false when they could not be
 * fetched (the next call tries again). Callers render again when it resolves.
 * (Each import names what it uses, so the bundler leaves the admin's message parser out of the file.)
 */
export function loadOrderTools(): Promise<boolean> {
  if (tools) return Promise.resolve(true);
  return (toolsLoading ??= Promise.all([
    import('../lib/orderMessage').then(({ buildOrderMessage, buildGiftMessage, giftEstimate }) => ({ buildOrderMessage, buildGiftMessage, giftEstimate })),
    import('../lib/orderRef').then(({ newRef, newKey, isRef, isKey }) => ({ newRef, newKey, isRef, isKey })),
  ])
    .then(([m, r]) => { tools = { ...m, ...r }; return true; })
    .catch(() => { toolsLoading = null; return false; }));
}
/** True once loadOrderTools() has finished. */
export const orderToolsReady = () => tools !== null;

/** The message the site sent before order codes existed; used only until the order tools are loaded. */
export const plainOrderText = (lines: { name: string; pack: string; qty: number }[]) =>
  `Hi Beezy Honey! I'd like to order:\n${lines.map((l, i) => `${i + 1}. ${l.name} – ${l.pack} × ${l.qty}`).join('\n')}\n\nPlease share the price and delivery details.`;

export interface CartItem { slug: string; name: string; pack: string; qty: number; code?: string }
export type OrderSource = 'cart' | 'product' | 'gift';

const KEY = 'beezy-cart-v1';
const DAY_MS = 24 * 60 * 60_000;
const ORDERS_URL = link('/api/orders.json');
// The order form no longer asks for a name and pincode; forget any that an older version saved
try { localStorage.removeItem('beezy-cart-fields'); } catch { /* storage blocked */ }

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode or storage blocked */ }
}
function forget(key: string) {
  try { localStorage.removeItem(key); } catch { /* storage blocked */ }
}

const clampQty = (q: unknown) => Math.max(1, Math.min(99, Math.round(Number(q)) || 1));
const load = () => read<CartItem[]>(KEY, [])
  .filter((i) => i && typeof i.slug === 'string' && i.slug && typeof i.pack === 'string' && Number(i.qty) > 0)
  .map((i) => ({ ...i, name: typeof i.name === 'string' ? i.name : i.slug, qty: clampQty(i.qty), ...(typeof i.code === 'string' ? { code: i.code } : {}) }));
// Re-read storage before every read and change, so another tab or a page restored
// from the back/forward cache never works from an old copy of the order.
let items: CartItem[] = load();
const fresh = () => { items = load(); return items; };

function commit() {
  write(KEY, items);
  window.dispatchEvent(new CustomEvent('cart:change'));
}

window.addEventListener('storage', (e) => {
  if (e.key === KEY || e.key === orderKey('cart')) window.dispatchEvent(new CustomEvent('cart:change'));
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) window.dispatchEvent(new CustomEvent('cart:change'));
});

/** The variant code for a product + pack, from the price table */
export const codeFor = (slug: string, pack: string) => priceOf(slug, pack)?.code;

export const cart = {
  items: () => fresh(),
  count: () => fresh().reduce((n, i) => n + i.qty, 0),
  find: (slug: string, pack: string) => fresh().find((i) => i.slug === slug && i.pack === pack),
  /** Put a product + pack in the order with exactly this quantity (replaces any earlier quantity) */
  set(item: CartItem) {
    fresh();
    const qty = clampQty(item.qty);
    const code = item.code ?? codeFor(item.slug, item.pack);
    const found = items.find((i) => i.slug === item.slug && i.pack === item.pack);
    if (found) { found.qty = qty; if (code) found.code = code; }
    else items.push({ slug: item.slug, name: item.name, pack: item.pack, qty, ...(code ? { code } : {}) });
    commit();
  },
  setQty(index: number, qty: number) {
    fresh();
    if (!items[index]) return;
    if (qty <= 0) items.splice(index, 1);
    else items[index].qty = Math.min(99, qty);
    commit();
  },
  remove(index: number) { fresh(); items.splice(index, 1); commit(); },
  clear() { items = []; commit(); },
};

/* ---------- product names and status (from the page, every product ever sold) ---------- */

export interface ProductRef { src: string; href: string; name: string; status: 'live' | 'paused' | 'retired' }
let products: Record<string, ProductRef> | null = null;
/** Small photo, page link, current name and status of every product (the #cart-thumbs JSON in Base.astro) */
export function productRef(slug: string): ProductRef | undefined {
  if (!products) {
    try { products = JSON.parse(document.getElementById('cart-thumbs')?.textContent || '{}'); } catch { products = {}; }
  }
  return products![slug];
}

/* ---------- lines with today's prices ---------- */

export type LineState = 'ok' | 'paused' | 'gone';
export interface ResolvedLine {
  item: CartItem;
  /** 'ok' can be ordered; 'paused' = "Not available right now"; 'gone' = "No longer available" */
  state: LineState;
  /** product slug (a pack found by its code may have moved) */
  slug: string;
  /** current product name (falls back to the saved one) */
  name: string;
  /** current pack label (a renamed pack keeps its code) */
  pack: string;
  code: string | null;
  /** price of one pack in paise; null without a price or when prices are hidden */
  unitPaise: number | null;
  /** unitPaise × qty, or null */
  linePaise: number | null;
  avail: Avail | null;
}

/** Matches a saved item to today's packs: by code, else by product and pack label. */
export function resolveItem(item: CartItem): ResolvedLine {
  let slug = item.slug;
  let pack = item.pack;
  const byCode = item.code ? findCode(item.code) : null;
  if (byCode) { slug = byCode.slug; pack = byCode.label; }
  const info = productRef(slug);
  const pp = priceOf(slug, pack);
  const name = info?.name ?? item.name;
  if (!pp || !info || info.status === 'retired') {
    return { item, state: 'gone', slug, name, pack, code: null, unitPaise: null, linePaise: null, avail: null };
  }
  return {
    item, state: info.status === 'paused' ? 'paused' : 'ok', slug, name, pack, code: pp.code,
    unitPaise: pp.price, linePaise: pp.price === null ? null : pp.price * item.qty, avail: pp.avail,
  };
}

/** Saves the codes found for older items, so a renamed pack keeps matching later. */
function rememberCodes(lines: ResolvedLine[]) {
  const current = fresh();
  let changed = false;
  for (const l of lines) {
    if (l.state === 'gone' || !l.code) continue;
    const i = current.find((x) => x.slug === l.item.slug && x.pack === l.item.pack);
    if (i && (i.code !== l.code || i.slug !== l.slug || i.pack !== l.pack)) { i.code = l.code; i.slug = l.slug; i.pack = l.pack; changed = true; }
  }
  if (changed) write(KEY, current);
}

/* ---------- order code: made in the browser, reused only for an unchanged order sent within 24 hours ---------- */

interface OrderState { ref: string; key: string; hash: string; at: number; sentAt: number }
const orderKey = (src: OrderSource) => (src === 'cart' ? 'beezy-order' : `beezy-order-${src}`);
/** within 24 hours; a clock that went back a little (up to an hour) still counts, a time far in the future does not */
const within24h = (since: number) => { const age = Date.now() - since; return age < DAY_MS && age > -60 * 60_000; };

/** FNV-1a, enough to notice that an order changed */
export function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function readState(src: OrderSource): OrderState | null {
  const s = read<OrderState | null>(orderKey(src), null);
  if (!tools || !s) return null;
  return tools.isRef(s.ref) && tools.isKey(s.key) && typeof s.hash === 'string' && typeof s.at === 'number' ? s : null;
}

/**
 * The order code and key for an order with this content hash (needs the order tools). A code not sent yet follows
 * the order as it changes (no record exists for it). Once sent, it is reused only while the order is unchanged and
 * for 24 hours, so a resend updates the same record; any other order gets a new code and key.
 */
export function currentRef(src: OrderSource, hash: string): { ref: string; key: string } {
  if (!tools) return { ref: '', key: '' };
  const s = readState(src);
  if (s && !s.sentAt && within24h(s.at)) {
    if (s.hash !== hash) write(orderKey(src), { ...s, hash });
    return s;
  }
  if (s && s.sentAt && s.hash === hash && within24h(s.sentAt)) return s;
  const next: OrderState = { ref: tools.newRef(), key: tools.newKey(), hash, at: Date.now(), sentAt: 0 };
  write(orderKey(src), next);
  return next;
}

/** The code this exact order was sent as in the last 24 hours, or null. */
export function sentRef(src: OrderSource, hash: string): string | null {
  const s = readState(src);
  return s && s.sentAt && s.hash === hash && within24h(s.sentAt) ? s.ref : null;
}

function markSent(src: OrderSource, ref: string) {
  const s = readState(src);
  if (s && s.ref === ref) write(orderKey(src), { ...s, sentAt: Date.now() });
}

/** Forget the order code, e.g. for "Start a new order" */
export function forgetRef(src: OrderSource) { forget(orderKey(src)); }

/* ---------- the order record (contract 3) ---------- */

export interface OrderPayload {
  v: 1;
  ref: string;
  key: string;
  src: OrderSource;
  items: { c: string; s: string; p: string; q: number }[];
  /** total the visitor saw, in paise, or null when no total was shown */
  shown: number | null;
  /** live version of the prices used */
  lv: number | null;
  gift?: { size: number; jar: string; picks: string[]; extras: string[]; boxes: number; occasion: string; neededBy: string; card: string };
}

/**
 * Sends the order record without waiting for it: fetch with keepalive (survives WhatsApp taking over the screen),
 * falling back to sendBeacon with a plain string (text/plain, so no CORS preflight and no Blob-type issue).
 * Always 204 from the server; failures are silent (WhatsApp still has the order, and the admin can paste it).
 */
export function recordOrder(payload: OrderPayload): void {
  const body = JSON.stringify(payload);
  const beacon = () => {
    try { if (typeof navigator.sendBeacon === 'function') navigator.sendBeacon(ORDERS_URL, body); } catch { /* nothing more to try */ }
  };
  try {
    if (typeof fetch !== 'function') { beacon(); return; }
    fetch(ORDERS_URL, {
      method: 'POST', keepalive: true, credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'text/plain;charset=UTF-8' }, body,
    }).catch(beacon);
  } catch {
    beacon();
  }
}

/* ---------- a prepared order: text, link and record, ready before the tap ---------- */

export interface PreparedOrder {
  src: OrderSource;
  ref: string;
  key: string;
  hash: string;
  text: string;
  href: string;
  payload: OrderPayload;
  /** lines that go in the order (state 'ok') */
  lines: ResolvedLine[];
  /** sum of the priced lines (paise), null when prices are hidden or nothing has a price */
  totalPaise: number | null;
  /** every line has a price */
  complete: boolean;
}

/** The cart (or a single product, src 'product') as an order: code, WhatsApp text, wa.me link and record. */
export function prepareOrder(src: 'cart' | 'product', list: CartItem[]): PreparedOrder {
  const all = list.map(resolveItem);
  if (src === 'cart') rememberCodes(all);
  const lines = all.filter((l) => l.state === 'ok');
  const show = showPrices();
  const msgLines: MessageLine[] = lines.map((l) => ({ name: l.name, pack: l.pack, qty: l.item.qty, unitPaise: show ? l.unitPaise : null }));
  const priced = lines.filter((l) => l.linePaise !== null);
  const totalPaise = show && priced.length ? priced.reduce((s, l) => s + (l.linePaise as number), 0) : null;
  const payloadItems = lines.map((l) => ({ c: l.code as string, s: l.slug, p: l.pack, q: l.item.qty }));
  const hash = hashOf(JSON.stringify([src, payloadItems.map((i) => [i.c, i.q])]));
  // an empty order needs no code (and must not leave one behind, e.g. right after "Start a new order")
  const { ref, key } = payloadItems.length ? currentRef(src, hash) : { ref: '', key: '' };
  const text = tools ? tools.buildOrderMessage({ ref, lines: msgLines, showPrices: show }) : plainOrderText(msgLines);
  return {
    src, ref, key, hash, text, href: waLink(text), lines, totalPaise, complete: priced.length === lines.length,
    payload: { v: 1, ref, key, src, items: payloadItems, shown: totalPaise, lv: liveVersion() },
  };
}

/** Records the order and remembers it as sent. Call from the send link's click handler; never blocks the tap. */
export function sendOrder(order: PreparedOrder) {
  if (!order.payload.items.length || !order.ref) return; // no code yet (tools still loading): WhatsApp only
  markSent(order.src, order.ref);
  recordOrder(order.payload);
}

/* ---------- gift box (the gift page builds its own order text and record: src/pages/gift-box.astro) ---------- */

/** The loaded order tools (code and message helpers), or null while they are not loaded yet. */
export const orderTools = (): OrderTools | null => tools;

/** Records a gift order (it is sent even when no honey has a variant, so the request is never lost). */
export function sendGift(order: { ref: string; payload: OrderPayload }) {
  if (!order.ref) return;
  markSent('gift', order.ref);
  recordOrder(order.payload);
}
