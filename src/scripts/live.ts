// Live prices and stock on the public pages (design §2.1, contract 2).
//
// Every page carries the price table baked at build time in <script type="application/json" id="price-data">.
// This module reads it, and, only when the page shows prices or the order is not empty, fetches the same shape
// from /api/live.json once the page has settled (after `beezy:ready`, in an idle moment). A newer answer patches
// the price slots in place, but only the ones whose text really changes, and fires `live:change` on window.
// Any failure (no endpoint yet, offline, bad JSON) is silent: the baked values simply stay.
//
// Refetch: when the order drawer opens and the data is over 60 s old (site.ts calls refreshIfStale), on a
// back/forward-cache restore, and when the tab comes back after more than 10 minutes hidden.
// Answers (and failures) are kept in sessionStorage for 2 minutes, so moving between pages does not refetch.
//
// Generic slots, filled from the data (pages with their own UI re-render on `live:change` instead):
//   [data-price="slug|pack"]  data-prefix=" · "   price of one pack; hidden without a price
//   [data-from="slug"]        data-prefix="From " lowest price of the product's packs; hidden without one
//   [data-soldout="slug"]                         shown when every pack of the product is sold out
//   [data-soldout="slug|pack"]                    shown when that pack is sold out
//   [data-show-prices] / [data-hide-prices]       shown only when prices are on / off (copy that changes with prices)
//   [data-delivery-note]                          the delivery note, shown when prices are on
//   [data-live]                                   marks a page part that uses live data (so it is fetched)
import { formatINR } from '../lib/money';

export type Avail = 'in' | 'low' | 'out';
export type StockDisplay = 'sold_out' | 'low_and_sold_out';
/** [price paise | null, MRP paise | null, availability, variant code] */
export type PriceEntry = [number | null, number | null, Avail, string];
export interface PriceData {
  /** live version (settings.live_version) */
  lv: number;
  /** settings.showPrices */
  show: boolean;
  /** settings.stockDisplay */
  sd: StockDisplay;
  /** slug → pack label → entry */
  p: Record<string, Record<string, PriceEntry>>;
  /** offer pill (v2): text, optional same-site link, optional last day 'YYYY-MM-DD' (IST) */
  offer: { text: string; link?: string; until?: string } | null;
  /** delivery note under the order total */
  note: string;
}
export interface PackPrice {
  /** price in paise, or null when there is none or prices are hidden */
  price: number | null;
  /** MRP in paise when higher than the price (null otherwise, or when prices are hidden) */
  mrp: number | null;
  /** availability as shown to visitors ('low' only when the stock display shows it) */
  avail: Avail;
  /** variant code, e.g. 'murungai-honey:250g' */
  code: string;
}

const LIVE_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/live.json`;
const CACHE_KEY = 'beezy-live-v1';
const CACHE_MS = 2 * 60_000;
const DRAWER_STALE_MS = 60_000;
const HIDDEN_LONG_MS = 10 * 60_000;
const FAIL_BACKOFF_MS = 60_000;
const AVAILS: Avail[] = ['in', 'low', 'out'];
const EMPTY: PriceData = { lv: 0, show: false, sd: 'sold_out', p: {}, offer: null, note: '' };

const isPaise = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

/** Checks and tidies price data from the page or the network; null when it is not usable. Prices are dropped when hidden. */
export function cleanPriceData(raw: unknown): PriceData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.lv !== 'number' || !Number.isFinite(r.lv) || typeof r.show !== 'boolean') return null;
  if (r.sd !== 'sold_out' && r.sd !== 'low_and_sold_out') return null;
  if (!r.p || typeof r.p !== 'object') return null;
  const p: PriceData['p'] = {};
  for (const [slug, packs] of Object.entries(r.p as Record<string, unknown>)) {
    if (!packs || typeof packs !== 'object') return null;
    p[slug] = {};
    for (const [label, e] of Object.entries(packs as Record<string, unknown>)) {
      if (!Array.isArray(e) || e.length < 4 || !isPaise(e[0]) || !isPaise(e[1]) || !AVAILS.includes(e[2]) || typeof e[3] !== 'string') return null;
      const price = r.show ? e[0] : null;
      const mrp = r.show && price !== null && e[1] !== null && e[1] > price ? e[1] : null;
      p[slug][label] = [price, mrp, e[2], e[3]];
    }
  }
  let offer: PriceData['offer'] = null;
  const o = r.offer as Record<string, unknown> | null | undefined;
  if (o && typeof o === 'object' && typeof o.text === 'string' && o.text.trim()) {
    offer = {
      text: o.text,
      // same-site paths only: the pill never links away from the website
      ...(typeof o.link === 'string' && /^\/(?!\/)/.test(o.link) ? { link: o.link } : {}),
      ...(typeof o.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.until) ? { until: o.until } : {}),
    };
  }
  return { lv: r.lv, show: r.show, sd: r.sd, p, offer, note: typeof r.note === 'string' ? r.note : '' };
}

function sameData(a: PriceData, b: PriceData): boolean {
  if (a.show !== b.show || a.sd !== b.sd || a.note !== b.note || JSON.stringify(a.offer) !== JSON.stringify(b.offer)) return false;
  const slugs = new Set([...Object.keys(a.p), ...Object.keys(b.p)]);
  for (const s of slugs) {
    const pa = a.p[s], pb = b.p[s];
    if (!pa || !pb) return false;
    const labels = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    for (const l of labels) {
      const ea = pa[l], eb = pb[l];
      if (!ea || !eb || ea.some((v, i) => v !== eb[i])) return false;
    }
  }
  return true;
}

const hasDom = typeof document !== 'undefined';
const session = {
  get(): { t: number; data?: unknown; fail?: boolean } | null {
    try { const raw = sessionStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  },
  set(v: { t: number; data?: PriceData; fail?: boolean }) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch { /* storage blocked */ }
  },
};

function readBaked(): PriceData {
  if (!hasDom) return EMPTY;
  try { return cleanPriceData(JSON.parse(document.getElementById('price-data')?.textContent || 'null')) ?? EMPTY; } catch { return EMPTY; }
}

const baked = readBaked();
let data: PriceData = baked;
/** when `data` was fetched (0 = baked at build, age unknown) */
let dataAt = 0;
let failedAt = 0;
let inflight: Promise<void> | null = null;
let wanted: () => boolean = () => false;

/* ---------- reading ---------- */

/** The price data in use now (baked, or newer from the network). */
export const liveData = (): PriceData => data;
export const showPrices = (): boolean => data.show;
export const liveVersion = (): number => data.lv;
export const deliveryNote = (): string => data.note;
export const stockDisplay = (): StockDisplay => data.sd;

/** The offer to show today, or null (none, or its last day has passed in India). */
export function activeOffer(now = Date.now()): PriceData['offer'] {
  const o = data.offer;
  if (!o) return null;
  return o.until && o.until < new Date(now + 330 * 60_000).toISOString().slice(0, 10) ? null : o;
}

/** Price, MRP, availability and code of one pack, or null when the pack is not on sale (unknown, retired, inactive). */
export function priceOf(slug: string, label: string): PackPrice | null {
  const e = data.p[slug]?.[label];
  if (!e) return null;
  return { price: e[0], mrp: e[1], avail: e[2] === 'low' && data.sd === 'sold_out' ? 'in' : e[2], code: e[3] };
}

/** Availability of one pack as visitors see it ('low' only with the "Only a few left" display), or null. */
export const availOf = (slug: string, label: string): Avail | null => priceOf(slug, label)?.avail ?? null;

/** Pack labels of a product in the price table, in pack order. */
export const packsOf = (slug: string): string[] => Object.keys(data.p[slug] ?? {});

/** Lowest price among the product's packs ("From ₹125"), or null. */
export function fromOf(slug: string): number | null {
  let min: number | null = null;
  for (const e of Object.values(data.p[slug] ?? {})) if (e[0] !== null && (min === null || e[0] < min)) min = e[0];
  return min;
}

/** True when the product has packs and every one is sold out. */
export function allOut(slug: string): boolean {
  const entries = Object.values(data.p[slug] ?? {});
  return entries.length > 0 && entries.every((e) => e[2] === 'out');
}

/** Finds a pack by its variant code (packs keep their code when renamed). */
export function findCode(code: string): { slug: string; label: string } | null {
  for (const [slug, packs] of Object.entries(data.p)) {
    for (const [label, e] of Object.entries(packs)) if (e[3] === code) return { slug, label };
  }
  return null;
}

/* ---------- slots ---------- */

const split = (v: string | undefined) => {
  const i = (v ?? '').indexOf('|');
  return i < 0 ? [v ?? '', ''] : [v!.slice(0, i), v!.slice(i + 1)];
};
/** Writes only when the value changes, so unchanged slots never touch the layout. */
export function setText(el: Element, text: string) { if (el.textContent !== text) el.textContent = text; }
export function setHidden(el: HTMLElement, hidden: boolean) { if (el.hidden !== hidden) el.hidden = hidden; }

/** Fills one generic slot from the current data. */
export function fillSlot(el: HTMLElement) {
  const d = el.dataset;
  if (d.price !== undefined) {
    const [slug, label] = split(d.price);
    const price = priceOf(slug, label)?.price ?? null;
    if (price !== null) setText(el, (d.prefix ?? '') + formatINR(price));
    setHidden(el, price === null);
  } else if (d.from !== undefined) {
    const min = fromOf(d.from);
    if (min !== null) setText(el, (d.prefix ?? '') + formatINR(min));
    setHidden(el, min === null);
  } else if (d.soldout !== undefined) {
    const [slug, label] = split(d.soldout);
    setHidden(el, !(label ? availOf(slug, label) === 'out' : allOut(slug)));
  } else if (d.deliveryNote !== undefined) {
    if (data.note) setText(el, data.note);
    setHidden(el, !data.show || !data.note);
  } else if (d.showPrices !== undefined) setHidden(el, !data.show);
  else if (d.hidePrices !== undefined) setHidden(el, data.show);
}

const SLOTS = '[data-price],[data-from],[data-soldout],[data-delivery-note],[data-show-prices],[data-hide-prices]';
export function applySlots(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>(SLOTS).forEach(fillSlot);
}

/* ---------- updating ---------- */

function adopt(next: PriceData, at: number) {
  if (next.lv < data.lv) return; // older than what the page already has (e.g. an edge copy from before this build)
  dataAt = at;
  if (sameData(next, data)) { data = next; return; }
  data = next;
  if (hasDom) {
    applySlots();
    window.dispatchEvent(new CustomEvent('live:change', { detail: data }));
  }
}

/** Fetches /api/live.json now (one request at a time). Never throws. */
export function refresh(): Promise<void> {
  if (!hasDom || typeof fetch !== 'function') return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      timer = setTimeout(() => ctrl?.abort(), 8000);
      const res = await fetch(LIVE_URL, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: ctrl?.signal });
      if (!res.ok) throw new Error(String(res.status));
      const next = cleanPriceData(await res.json());
      if (!next) throw new Error('bad data');
      const now = Date.now();
      session.set({ t: now, data: next });
      failedAt = 0;
      adopt(next, now);
    } catch {
      failedAt = Date.now();
      session.set({ t: failedAt, fail: true });
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}

/** Uses a fresh copy from this tab's session (another page fetched it); true when one was found. */
function fromSession(): boolean {
  const c = session.get();
  if (!c || typeof c.t !== 'number' || Date.now() - c.t > CACHE_MS || c.t > Date.now() + 5000) return false;
  if (c.fail) { failedAt = c.t; return true; }
  const d = cleanPriceData(c.data);
  if (!d) return false;
  adopt(d, c.t);
  return true;
}

/** Refetches when the data is older than `maxAge` ms (and the last failure is not too recent). */
export function refreshIfStale(maxAge = DRAWER_STALE_MS): Promise<void> {
  if (!wanted()) return Promise.resolve();
  const now = Date.now();
  if (failedAt && now - failedAt < FAIL_BACKOFF_MS) return Promise.resolve();
  if (dataAt && now - dataAt <= maxAge) return Promise.resolve();
  return refresh();
}

/** Runs `fn` whenever newer live data arrives. */
export function onLiveChange(fn: (d: PriceData) => void) {
  if (hasDom) window.addEventListener('live:change', (e) => fn((e as CustomEvent<PriceData>).detail ?? data));
}

// The order drawer (#cart, on every page) has slots too, but those only matter when the order is not empty, so a
// page such as About or Contact with an empty order never asks for live data.
const PAGE_SLOTS = `${SLOTS},[data-live]`;
const pageHasSlots = () => hasDom && [...document.querySelectorAll(PAGE_SLOTS)].some((el) => !el.closest('#cart'));

/**
 * Starts live updates for this page. `orderNotEmpty` tells whether the visitor has something in the order:
 * pages without price slots fetch only then.
 */
export function startLive(orderNotEmpty: () => boolean) {
  if (!hasDom) return;
  wanted = () => pageHasSlots() || orderNotEmpty();
  const idle = (fn: () => void) => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(fn, { timeout: 4000 });
    else setTimeout(fn, 1500); // Safari
  };
  const first = () => idle(() => {
    if (!wanted() || fromSession()) return;
    void refresh();
  });
  if (document.documentElement.classList.contains('motion-ready')) first();
  else window.addEventListener('beezy:ready', first, { once: true });

  window.addEventListener('pageshow', (e) => {
    if (!e.persisted || !wanted()) return;
    if (!fromSession()) void refreshIfStale(CACHE_MS);
  });
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > HIDDEN_LONG_MS && wanted()) { failedAt = 0; void refresh(); }
    hiddenAt = 0;
  });
}

// A fresh copy from an earlier page in this tab is used straight away (no request, no waiting).
if (hasDom) fromSession();
