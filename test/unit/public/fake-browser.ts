// A very small stand-in for the browser, enough to load src/scripts/live.ts and src/scripts/cart.ts in Node:
// window and document as EventTargets, localStorage / sessionStorage in memory, JSON <script> elements by id,
// slot elements, a recorded fetch and sendBeacon. Each test calls install() and then imports the modules fresh.
import { vi } from 'vitest';
import type { PriceData } from '../../../src/scripts/live';

export class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}

/** A slot element: dataset, text and hidden, plus whether it sits inside the order drawer. */
export interface FakeEl { dataset: Record<string, string>; textContent: string; hidden: boolean; inCart?: boolean; closest(sel: string): unknown; matches(sel: string): boolean }

const SLOT_KEYS: Record<string, string> = {
  '[data-price]': 'price', '[data-from]': 'from', '[data-soldout]': 'soldout', '[data-delivery-note]': 'deliveryNote',
  '[data-show-prices]': 'showPrices', '[data-hide-prices]': 'hidePrices', '[data-live]': 'live',
};

export function el(dataset: Record<string, string>, opts: { text?: string; hidden?: boolean; inCart?: boolean } = {}): FakeEl {
  const e: FakeEl = {
    dataset, textContent: opts.text ?? '', hidden: opts.hidden ?? false, inCart: opts.inCart ?? false,
    closest: (sel: string) => (sel === '#cart' && e.inCart ? {} : null),
    matches: (sel: string) => sel.split(',').some((s) => SLOT_KEYS[s.trim()] !== undefined && SLOT_KEYS[s.trim()] in e.dataset),
  };
  return e;
}

export interface FakeBrowser {
  window: EventTarget & Record<string, unknown>;
  document: EventTarget & Record<string, unknown>;
  localStorage: MemStorage;
  sessionStorage: MemStorage;
  slots: FakeEl[];
  json: Record<string, unknown>;
  fetch: ReturnType<typeof vi.fn>;
  beacon: ReturnType<typeof vi.fn>;
  /** idle callbacks waiting to run (requestIdleCallback) */
  idle: (() => void)[];
  runIdle(): void;
  setVisibility(v: 'visible' | 'hidden'): void;
}

export interface InstallOptions {
  /** the baked #price-data */
  priceData?: PriceData | null;
  /** the #cart-thumbs data (slug → { src, href, name, status }) */
  thumbs?: Record<string, { src: string; href: string; name: string; status: 'live' | 'paused' | 'retired' }>;
  slots?: FakeEl[];
  /** false = Safari (no requestIdleCallback) */
  idleCallback?: boolean;
  /** what fetch answers: a body (200), a status number, or a function */
  fetchAnswer?: unknown;
  motionReady?: boolean;
}

/** Installs the fake browser globals. Call vi.unstubAllGlobals() afterwards (done in the tests' afterEach). */
export function install(o: InstallOptions = {}): FakeBrowser {
  const json: Record<string, unknown> = {};
  if (o.priceData !== undefined && o.priceData !== null) json['price-data'] = o.priceData;
  if (o.thumbs) json['cart-thumbs'] = o.thumbs;
  const slots = o.slots ?? [];
  const idle: (() => void)[] = [];
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  if (o.idleCallback !== false) win.requestIdleCallback = (fn: () => void) => { idle.push(fn); return idle.length; };
  const classes = new Set<string>(o.motionReady ? ['motion-ready'] : []);
  const doc = new EventTarget() as EventTarget & Record<string, unknown>;
  doc.visibilityState = 'visible';
  doc.documentElement = { classList: { contains: (c: string) => classes.has(c) } };
  doc.getElementById = (id: string) => (id in json ? { textContent: JSON.stringify(json[id]) } : null);
  doc.querySelectorAll = (sel: string) => slots.filter((s) => s.matches(sel));
  doc.querySelector = (sel: string) => slots.find((s) => s.matches(sel)) ?? null;

  const answer = o.fetchAnswer;
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (typeof answer === 'function') return (answer as (u: string, i?: RequestInit) => unknown)(_url, _init);
    if (typeof answer === 'number') return { ok: answer >= 200 && answer < 300, status: answer, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(answer ?? {}) };
  });
  const beacon = vi.fn(() => true);
  const localStorage = new MemStorage();
  const sessionStorage = new MemStorage();
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('sessionStorage', sessionStorage);
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('navigator', { sendBeacon: beacon });
  return {
    window: win, document: doc, localStorage, sessionStorage, slots, json, fetch, beacon, idle,
    runIdle() { while (idle.length) idle.shift()!(); },
    setVisibility(v) { doc.visibilityState = v; doc.dispatchEvent(new Event('visibilitychange')); },
  };
}

/** Lets pending promises (the fetch inside refresh()) settle. */
export const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** Price data in the contract-2 shape, prices on, for three products. */
export function samplePriceData(over: Partial<PriceData> = {}): PriceData {
  return {
    lv: 1, show: true, sd: 'sold_out',
    p: {
      'murungai-honey': {
        '100 g': [14000, null, 'in', 'murungai-honey:100g'],
        '250 g': [31000, null, 'in', 'murungai-honey:250g'],
        '500 g': [65000, null, 'in', 'murungai-honey:500g'],
      },
      'honey-sticks': {
        '1 stick': [700, null, 'in', 'honey-sticks:1-stick'],
        'Box of 10 (100 g)': [7000, null, 'in', 'honey-sticks:box-10'],
      },
      'litchi-honey': {
        '100 g': [null, null, 'in', 'litchi-honey:100g'],
        '250 g': [null, null, 'in', 'litchi-honey:250g'],
      },
      'beeswax-candles': {
        Small: [8000, null, 'in', 'beeswax-candles:small'],
      },
    },
    offer: null,
    note: 'Delivery charges are confirmed on WhatsApp.',
    ...over,
  };
}

export const sampleThumbs = {
  'murungai-honey': { src: '/_astro/m.webp', href: '/shop/murungai-honey/', name: 'Murungai Honey with comb', status: 'live' as const },
  'honey-sticks': { src: '/_astro/h.webp', href: '/shop/honey-sticks/', name: 'Honey Sticks', status: 'live' as const },
  'litchi-honey': { src: '/_astro/l.webp', href: '/shop/litchi-honey/', name: 'Litchi Honey', status: 'paused' as const },
  'beeswax-candles': { src: '/_astro/b.webp', href: '/shop/beeswax-candles/', name: 'Beeswax Candles', status: 'live' as const },
  'kombu-honey': { src: '/_astro/k.webp', href: '', name: 'Kombu Honey', status: 'retired' as const },
};
