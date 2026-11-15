// src/scripts/cart.ts: the saved order, mapping old carts, the order code reuse rule (24 hours, same cart),
// the WhatsApp text with prices (contract 5), the order record (contract 3) and its sendBeacon fallback, and the
// gift box estimate. Runs against a tiny fake browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, install, samplePriceData, sampleThumbs, type InstallOptions } from './fake-browser';
import { parseOrderMessage } from '../../../src/lib/orderMessage';

type Cart = typeof import('../../../src/scripts/cart');
const T0 = new Date('2026-11-15T04:30:00Z'); // 10:00 in India
const HOUR = 60 * 60_000;

/** Fresh fake browser and a fresh cart module; `tools` loads the order code and message helpers first. */
async function setup(o: InstallOptions = {}, tools = true) {
  const b = install({ priceData: samplePriceData(), thumbs: sampleThumbs, ...o });
  vi.resetModules();
  const cart: Cart = await import('../../../src/scripts/cart');
  if (tools) expect(await cart.loadOrderTools()).toBe(true);
  return { b, cart };
}
const decode = (href: string) => decodeURIComponent(href.split('?text=')[1] ?? '');
const saved = (b: { localStorage: Storage | { getItem(k: string): string | null } }) => JSON.parse(b.localStorage.getItem('beezy-cart-v1') ?? '[]');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the saved order', () => {
  it('stores slug, name, pack, qty and the pack code (never prices)', async () => {
    const { b, cart } = await setup();
    const changes = vi.fn();
    b.window.addEventListener('cart:change', changes);
    cart.cart.set({ slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 2 });
    expect(saved(b)).toEqual([{ slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 2, code: 'murungai-honey:250g' }]);
    expect(changes).toHaveBeenCalledTimes(1);
    cart.cart.set({ slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 500 });
    expect(cart.cart.items()).toHaveLength(1);
    expect(cart.cart.find('murungai-honey', '250 g')?.qty).toBe(99);
    cart.cart.set({ slug: 'honey-sticks', name: 'Honey Sticks', pack: 'Box of 10 (100 g)', qty: 1 });
    expect(cart.cart.count()).toBe(100);
    cart.cart.setQty(1, 0);
    expect(cart.cart.items().map((i) => i.pack)).toEqual(['250 g']);
    cart.cart.clear();
    expect(cart.cart.items()).toEqual([]);
  });

  it('reads older carts and drops broken entries', async () => {
    const b = install({ priceData: samplePriceData(), thumbs: sampleThumbs });
    b.localStorage.setItem('beezy-cart-fields', '{"name":"x","pin":"600001"}');
    b.localStorage.setItem('beezy-cart-v1', JSON.stringify([
      { slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 1 },
      { slug: 'murungai-honey', pack: '100 g', qty: '3' },
      null, { slug: '', pack: '250 g', qty: 1 }, { slug: 'x', qty: 1 }, { slug: 'x', pack: '1 kg', qty: 0 },
    ]));
    vi.resetModules();
    const { cart } = await import('../../../src/scripts/cart');
    expect(cart.items()).toEqual([
      { slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 1 },
      { slug: 'murungai-honey', name: 'murungai-honey', pack: '100 g', qty: 3 },
    ]);
    // the old version's name/pincode fields are forgotten
    expect(b.localStorage.getItem('beezy-cart-fields')).toBeNull();
  });

  it('another tab changing the order (storage event) re-renders this one', async () => {
    const { b } = await setup();
    const changes = vi.fn();
    b.window.addEventListener('cart:change', changes);
    const e = new Event('storage') as Event & { key: string };
    e.key = 'beezy-cart-v1';
    b.window.dispatchEvent(e);
    const other = new Event('storage') as Event & { key: string };
    other.key = 'something-else';
    b.window.dispatchEvent(other);
    expect(changes).toHaveBeenCalledTimes(1);
  });
});

describe('matching saved items to today\'s packs', () => {
  it('by code, else by product and pack label; unknown or retired → "No longer available"; paused → not available now', async () => {
    const d = samplePriceData();
    // the 250 g pack was renamed to "250 g jar" (it keeps its code)
    d.p['murungai-honey'] = { '100 g': d.p['murungai-honey']['100 g'], '250 g jar': [31000, null, 'in', 'murungai-honey:250g'] };
    const { cart } = await setup({ priceData: d });
    const r = (i: Parameters<Cart['resolveItem']>[0]) => cart.resolveItem(i);
    const byCode = r({ slug: 'murungai-honey', name: 'Old name', pack: '250 g', qty: 2, code: 'murungai-honey:250g' });
    expect(byCode).toMatchObject({ state: 'ok', slug: 'murungai-honey', pack: '250 g jar', name: 'Murungai Honey with comb', code: 'murungai-honey:250g', unitPaise: 31000, linePaise: 62000, avail: 'in' });
    expect(r({ slug: 'murungai-honey', name: 'x', pack: '100 g', qty: 1 })).toMatchObject({ state: 'ok', code: 'murungai-honey:100g', unitPaise: 14000 });
    expect(r({ slug: 'murungai-honey', name: 'x', pack: '1 kg', qty: 1 }).state).toBe('gone');
    expect(r({ slug: 'old-honey', name: 'Old Honey', pack: '250 g', qty: 1 })).toMatchObject({ state: 'gone', name: 'Old Honey', code: null, linePaise: null });
    expect(r({ slug: 'kombu-honey', name: 'Kombu Honey', pack: '250 g', qty: 1 }).state).toBe('gone'); // retired
    expect(r({ slug: 'litchi-honey', name: 'Litchi Honey', pack: '250 g', qty: 1 }).state).toBe('paused');
  });

  it('prepareOrder saves the codes it found for older items', async () => {
    const { b, cart } = await setup();
    b.localStorage.setItem('beezy-cart-v1', JSON.stringify([{ slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 1 }]));
    cart.prepareOrder('cart', cart.cart.items());
    expect(saved(b)[0].code).toBe('murungai-honey:250g');
  });
});

describe('the order message and record (contracts 3 and 5)', () => {
  const two = [
    { slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 2 },
    { slug: 'honey-sticks', name: 'Honey Sticks', pack: 'Box of 10 (100 g)', qty: 1 },
  ];

  it('prices on: the agreed message, total and record', async () => {
    const { cart } = await setup();
    const o = cart.prepareOrder('cart', two);
    expect(o.ref).toMatch(/^BZ-[346789ACDEFGHJKMNPQRTUVWXY]{5}$/);
    expect(o.key).toMatch(/^[0-9a-f]{32}$/);
    expect(o.text).toBe(`Hi Beezy Honey! I'd like to order (Order ${o.ref}):
1. Murungai Honey with comb – 250 g × 2 – ₹620
2. Honey Sticks – Box of 10 (100 g) × 1 – ₹70
Total: ₹690 (prices as on 15 Nov 2026)
Please confirm delivery charges and payment details.`);
    expect(o.href).toBe(`https://wa.me/916383271931?text=${encodeURIComponent(o.text)}`);
    expect(o.totalPaise).toBe(69000);
    expect(o.complete).toBe(true);
    expect(o.payload).toEqual({
      v: 1, ref: o.ref, key: o.key, src: 'cart', shown: 69000, lv: 1,
      items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 2 }, { c: 'honey-sticks:box-10', s: 'honey-sticks', p: 'Box of 10 (100 g)', q: 1 }],
    });
    // the admin's paste tool reads it back
    const parsed = parseOrderMessage(o.text)!;
    expect(parsed.ref).toBe(o.ref);
    expect(parsed.totalPaise).toBe(69000);
  });

  it('a pack without a price says "price please" and the total is "so far"; unavailable items are left out', async () => {
    const d = samplePriceData();
    d.p['honey-sticks']['Box of 10 (100 g)'] = [null, null, 'in', 'honey-sticks:box-10'];
    const { cart } = await setup({ priceData: d });
    const o = cart.prepareOrder('cart', [...two, { slug: 'old-honey', name: 'Old Honey', pack: '250 g', qty: 1 }, { slug: 'litchi-honey', name: 'Litchi Honey', pack: '250 g', qty: 1 }]);
    expect(o.text).toBe(`Hi Beezy Honey! I'd like to order (Order ${o.ref}):
1. Murungai Honey with comb – 250 g × 2 – ₹620
2. Honey Sticks – Box of 10 (100 g) × 1 – price please
Total so far: ₹620 (prices as on 15 Nov 2026)
Please confirm delivery charges and payment details.`);
    expect(o.complete).toBe(false);
    expect(o.payload.items.map((i) => i.s)).toEqual(['murungai-honey', 'honey-sticks']);
    expect(o.payload.shown).toBe(62000);
  });

  it('prices off: today\'s wording plus the order code, no amounts, shown null', async () => {
    const { cart } = await setup({ priceData: samplePriceData({ show: false }) });
    const o = cart.prepareOrder('cart', two);
    expect(o.text).toBe(`Hi Beezy Honey! I'd like to order (Order ${o.ref}):
1. Murungai Honey with comb – 250 g × 2
2. Honey Sticks – Box of 10 (100 g) × 1

Please share the price and delivery details.`);
    expect(o.totalPaise).toBeNull();
    expect(o.payload.shown).toBeNull();
    expect(o.payload.items).toHaveLength(2);
  });

  it('an empty order has no code', async () => {
    const { b, cart } = await setup();
    const o = cart.prepareOrder('cart', []);
    expect(o.ref).toBe('');
    expect(b.localStorage.getItem('beezy-order')).toBeNull();
    cart.sendOrder(o);
    await flush();
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('recordOrder: POST with keepalive, text/plain, the JSON string, never waited for', async () => {
    const { b, cart } = await setup();
    const o = cart.prepareOrder('product', [two[0]]);
    expect(o.payload.src).toBe('product');
    cart.recordOrder(o.payload);
    expect(b.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = b.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orders.json');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'text/plain;charset=UTF-8' } });
    expect(JSON.parse(init.body as string)).toEqual(o.payload);
    expect(b.beacon).not.toHaveBeenCalled();
  });

  it('falls back to sendBeacon with the same string when fetch throws or fails', async () => {
    const throwsAtOnce = () => { throw new TypeError('keepalive not supported'); };
    const rejects = () => Promise.reject(new TypeError('blocked'));
    for (const failure of [throwsAtOnce, rejects]) {
      vi.unstubAllGlobals();
      const { b, cart } = await setup();
      b.fetch.mockImplementation(failure);
      const o = cart.prepareOrder('cart', two);
      cart.recordOrder(o.payload);
      await flush();
      expect(b.beacon).toHaveBeenCalledTimes(1);
      const [url, body] = b.beacon.mock.calls[0] as unknown as [string, unknown];
      expect(url).toBe('/api/orders.json');
      expect(typeof body).toBe('string'); // a plain string goes as text/plain (no Blob type issue)
      expect(JSON.parse(body as string)).toEqual(o.payload);
    }
    // no fetch at all
    vi.unstubAllGlobals();
    const { b, cart } = await setup();
    vi.stubGlobal('fetch', undefined);
    cart.recordOrder(cart.prepareOrder('cart', two).payload);
    expect(b.beacon).toHaveBeenCalledTimes(1);
  });
});

describe('before the order tools are loaded', () => {
  const one = [{ slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 2 }];

  it('the order still opens WhatsApp with the plain message the site always sent, but has no code and no record', async () => {
    const { b, cart } = await setup({}, false);
    expect(cart.orderToolsReady()).toBe(false);
    const o = cart.prepareOrder('cart', one);
    expect(o.ref).toBe('');
    expect(o.text).toBe("Hi Beezy Honey! I'd like to order:\n1. Murungai Honey with comb – 250 g × 2\n\nPlease share the price and delivery details.");
    expect(o.href).toBe(`https://wa.me/916383271931?text=${encodeURIComponent(o.text)}`);
    cart.sendOrder(o);
    cart.sendGift({ ref: '', payload: o.payload });
    await flush();
    expect(b.fetch).not.toHaveBeenCalled();
    expect(b.localStorage.getItem('beezy-order')).toBeNull();
    expect(cart.sentRef('cart', o.hash)).toBeNull();
    expect(cart.orderTools()).toBeNull();
    // once loaded, the same order gets its code
    expect(await cart.loadOrderTools()).toBe(true);
    expect(cart.orderToolsReady()).toBe(true);
    expect(cart.prepareOrder('cart', one).ref).toMatch(/^BZ-/);
  });

  it('the plain text is exactly what buildOrderMessage writes with no code and prices hidden', async () => {
    const { cart } = await setup({}, false);
    const { buildOrderMessage } = await import('../../../src/lib/orderMessage');
    const lines = [{ name: 'Murungai Honey with comb', pack: '250 g', qty: 2, unitPaise: null }, { name: 'Honey Sticks', pack: 'Box of 10 (100 g)', qty: 1, unitPaise: null }];
    expect(cart.plainOrderText(lines)).toBe(buildOrderMessage({ ref: '', lines, showPrices: false }));
  });

  it('loads the tools once', async () => {
    const { cart } = await setup({}, false);
    const a = cart.loadOrderTools();
    expect(cart.loadOrderTools()).toBe(a);
    expect(await a).toBe(true);
    expect(await cart.loadOrderTools()).toBe(true);
  });

  it('a failed load resolves false (no throw) and the next call tries again', async () => {
    vi.doMock('../../../src/lib/orderRef', () => { throw new Error('chunk failed to load'); });
    const { cart } = await setup({}, false);
    expect(await cart.loadOrderTools()).toBe(false);
    expect(cart.orderToolsReady()).toBe(false);
    expect(cart.prepareOrder('cart', one).ref).toBe('');
    vi.doUnmock('../../../src/lib/orderRef');
    expect(await cart.loadOrderTools()).toBe(true);
    expect(cart.prepareOrder('cart', one).ref).toMatch(/^BZ-/);
  });
});

describe('order code reuse (same cart, sent within 24 hours)', () => {
  const a = [{ slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 1 }];
  const a2 = [{ slug: 'murungai-honey', name: 'Murungai Honey with comb', pack: '250 g', qty: 2 }];

  it('a code not sent yet follows the order as it changes', async () => {
    const { cart } = await setup();
    const first = cart.prepareOrder('cart', a);
    const changed = cart.prepareOrder('cart', a2);
    expect(changed.ref).toBe(first.ref);
    expect(changed.key).toBe(first.key);
  });

  it('after sending: the same order keeps its code and key; a changed order gets new ones', async () => {
    const { b, cart } = await setup();
    const sent = cart.prepareOrder('cart', a);
    cart.sendOrder(sent);
    expect(cart.sentRef('cart', sent.hash)).toBe(sent.ref);
    vi.setSystemTime(new Date(T0.getTime() + 23 * HOUR));
    const again = cart.prepareOrder('cart', a);
    expect([again.ref, again.key]).toEqual([sent.ref, sent.key]);
    const changed = cart.prepareOrder('cart', a2);
    expect(changed.ref).not.toBe(sent.ref);
    expect(changed.key).not.toBe(sent.key);
    expect(cart.sentRef('cart', changed.hash)).toBeNull();
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('after 24 hours the same order gets a new code', async () => {
    const { cart } = await setup();
    const sent = cart.prepareOrder('cart', a);
    cart.sendOrder(sent);
    vi.setSystemTime(new Date(T0.getTime() + 25 * HOUR));
    const later = cart.prepareOrder('cart', a);
    expect(later.ref).not.toBe(sent.ref);
    expect(cart.sentRef('cart', later.hash)).toBeNull();
  });

  it('cart, product and gift orders keep separate codes; forgetRef starts over', async () => {
    const { b, cart } = await setup();
    const c = cart.prepareOrder('cart', a);
    const p = cart.prepareOrder('product', a);
    expect(p.ref).not.toBe(c.ref);
    expect(b.localStorage.getItem('beezy-order')).toContain(c.ref);
    expect(b.localStorage.getItem('beezy-order-product')).toContain(p.ref);
    cart.forgetRef('cart');
    expect(b.localStorage.getItem('beezy-order')).toBeNull();
    expect(cart.prepareOrder('cart', a).ref).not.toBe(c.ref);
  });

  it('a damaged saved code is replaced', async () => {
    const { b, cart } = await setup();
    b.localStorage.setItem('beezy-order', JSON.stringify({ ref: 'BZ-OOOOO', key: 'nope', hash: 'x', at: Date.now(), sentAt: 0 }));
    const o = cart.prepareOrder('cart', a);
    expect(o.ref).toMatch(/^BZ-[346789ACDEFGHJKMNPQRTUVWXY]{5}$/);
  });
});

describe('gift box record', () => {
  // The gift page builds its own text and record (src/pages/gift-box.astro, checked in the browser tests);
  // its message and estimate come from buildGiftMessage / giftEstimate (test/unit/public/orderMessage.test.ts).
  it('sendGift records the gift request even when no honey has a pack code, and remembers it as sent', async () => {
    const { b, cart } = await setup();
    const { ref, key } = cart.currentRef('gift', 'h1');
    const payload = { v: 1 as const, ref, key, src: 'gift' as const, items: [], shown: null, lv: 1,
      gift: { size: 2, jar: '100 g', picks: ['x', 'y'], extras: [], boxes: 3, occasion: '', neededBy: '', card: '' } };
    cart.sendGift({ ref, payload });
    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((b.fetch.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual(payload);
    expect(cart.sentRef('gift', 'h1')).toBe(ref);
    expect(cart.currentRef('gift', 'h1').ref).toBe(ref);
    expect(cart.currentRef('gift', 'h2').ref).not.toBe(ref);
  });
  it('orderTools() hands the gift page the message helpers once loaded', async () => {
    const { cart } = await setup({}, false);
    expect(cart.orderTools()).toBeNull();
    await cart.loadOrderTools();
    const t = cart.orderTools()!;
    expect(typeof t.buildGiftMessage).toBe('function');
    expect(t.giftEstimate({ picks: [{ name: 'a', unitPaise: 100 }], extras: [], feePaise: 0, boxes: 2, bulk: false }).totalPaise).toBe(200);
  });
});
