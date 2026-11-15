// src/scripts/live.ts: the baked price table, the idle fetch of /api/live.json, its refetch rules, patching only what
// changed, `live:change`, and staying silent on errors (design §2.1, contract 2). Runs against a tiny fake browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { el, flush, install, samplePriceData } from './fake-browser';
import type { PriceData } from '../../../src/scripts/live';

type Live = typeof import('../../../src/scripts/live');
const load = async (): Promise<Live> => { vi.resetModules(); return import('../../../src/scripts/live'); };
const T0 = new Date('2026-11-15T04:30:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A slot whose text writes are counted (to prove unchanged slots are never touched). */
function countingSlot(dataset: Record<string, string>, text: string, hidden = false) {
  const s = el(dataset, { hidden });
  let value = text;
  const writes = { n: 0 };
  Object.defineProperty(s, 'textContent', { get: () => value, set: (v: string) => { writes.n++; value = v; } });
  return { slot: s, writes };
}

describe('cleanPriceData', () => {
  it('keeps good data as it is', async () => {
    install();
    const { cleanPriceData } = await load();
    const d = samplePriceData();
    expect(cleanPriceData(structuredClone(d))).toEqual(d);
  });
  it('rejects data that is not the contract shape', async () => {
    install();
    const { cleanPriceData } = await load();
    const good = samplePriceData();
    const bad: unknown[] = [
      null, 'x', [], { ...good, lv: '1' }, { ...good, show: 1 }, { ...good, sd: 'low' }, { ...good, p: null },
      { ...good, p: { a: { '250 g': [100, null, 'in'] } } },
      { ...good, p: { a: { '250 g': [100.5, null, 'in', 'a:250g'] } } },
      { ...good, p: { a: { '250 g': [-1, null, 'in', 'a:250g'] } } },
      { ...good, p: { a: { '250 g': [100, null, 'maybe', 'a:250g'] } } },
      { ...good, p: { a: { '250 g': [100, null, 'in', 42] } } },
      { ...good, p: { a: 'nope' } },
    ];
    for (const b of bad) expect(cleanPriceData(b), JSON.stringify(b)).toBeNull();
  });
  it('drops every price and MRP while prices are hidden', async () => {
    install();
    const { cleanPriceData } = await load();
    const d = cleanPriceData(samplePriceData({ show: false }))!;
    for (const packs of Object.values(d.p)) for (const e of Object.values(packs)) { expect(e[0]).toBeNull(); expect(e[1]).toBeNull(); }
    expect(d.p['murungai-honey']['250 g'][2]).toBe('in');
    expect(d.p['murungai-honey']['250 g'][3]).toBe('murungai-honey:250g');
  });
  it('keeps an MRP only when it is higher than the price', async () => {
    install();
    const { cleanPriceData } = await load();
    const d = samplePriceData();
    d.p['murungai-honey']['250 g'] = [31000, 31000, 'in', 'murungai-honey:250g'];
    d.p['murungai-honey']['500 g'] = [65000, 70000, 'in', 'murungai-honey:500g'];
    d.p['litchi-honey']['100 g'] = [null, 9000, 'in', 'litchi-honey:100g'];
    const c = cleanPriceData(d)!;
    expect(c.p['murungai-honey']['250 g'][1]).toBeNull();
    expect(c.p['murungai-honey']['500 g'][1]).toBe(70000);
    expect(c.p['litchi-honey']['100 g'][1]).toBeNull();
  });
  it('reads the offer and the note safely', async () => {
    install();
    const { cleanPriceData } = await load();
    expect(cleanPriceData(samplePriceData({ offer: { text: 'Diwali boxes', link: '/gift-box/' } }))!.offer).toEqual({ text: 'Diwali boxes', link: '/gift-box/' });
    expect(cleanPriceData({ ...samplePriceData(), offer: { text: '  ' } })!.offer).toBeNull();
    expect(cleanPriceData({ ...samplePriceData(), note: 5 })!.note).toBe('');
    // offer links stay on this website; a bad end date is dropped
    expect(cleanPriceData(samplePriceData({ offer: { text: 'X', link: 'https://evil.example/' } as never }))!.offer).toEqual({ text: 'X' });
    expect(cleanPriceData(samplePriceData({ offer: { text: 'X', link: '//evil.example/' } as never }))!.offer).toEqual({ text: 'X' });
    expect(cleanPriceData(samplePriceData({ offer: { text: 'X', until: '2026-12-31' } }))!.offer).toEqual({ text: 'X', until: '2026-12-31' });
    expect(cleanPriceData(samplePriceData({ offer: { text: 'X', until: 'soon' } as never }))!.offer).toEqual({ text: 'X' });
  });
});

describe('activeOffer (offer pill)', () => {
  it('is null without an offer', async () => {
    install({ priceData: samplePriceData() });
    const { activeOffer } = await load();
    expect(activeOffer()).toBeNull();
  });
  it('shows the offer up to and including its last day in India, then hides it without a rebuild', async () => {
    install({ priceData: samplePriceData({ offer: { text: 'Diwali boxes', link: '/gift-box/', until: '2026-11-15' } }) });
    const { activeOffer } = await load();
    expect(activeOffer(Date.parse('2026-11-15T18:29:00Z'))).toEqual({ text: 'Diwali boxes', link: '/gift-box/', until: '2026-11-15' }); // 23:59 IST
    expect(activeOffer(Date.parse('2026-11-15T18:31:00Z'))).toBeNull(); // 00:01 IST on the 16th
  });
  it('an offer with no end date stays', async () => {
    install({ priceData: samplePriceData({ offer: { text: 'Gift boxes' } }) });
    const { activeOffer } = await load();
    expect(activeOffer(Date.parse('2030-01-01T00:00:00Z'))).toEqual({ text: 'Gift boxes' });
  });
});

describe('reading the baked table', () => {
  it('priceOf / availOf / fromOf / allOut / findCode / packsOf', async () => {
    const d = samplePriceData();
    d.p['murungai-honey']['100 g'][2] = 'low';
    d.p['beeswax-candles'].Small[2] = 'out';
    install({ priceData: d });
    const live = await load();
    expect(live.showPrices()).toBe(true);
    expect(live.liveVersion()).toBe(1);
    expect(live.deliveryNote()).toBe('Delivery charges are confirmed on WhatsApp.');
    expect(live.priceOf('murungai-honey', '250 g')).toEqual({ price: 31000, mrp: null, avail: 'in', code: 'murungai-honey:250g' });
    // stock display 'sold_out' (the default) shows a low pack as in stock
    expect(live.availOf('murungai-honey', '100 g')).toBe('in');
    expect(live.priceOf('murungai-honey', '1 kg')).toBeNull();
    expect(live.priceOf('no-such-honey', '250 g')).toBeNull();
    expect(live.availOf('no-such-honey', '250 g')).toBeNull();
    expect(live.fromOf('murungai-honey')).toBe(14000);
    expect(live.fromOf('litchi-honey')).toBeNull();
    expect(live.allOut('beeswax-candles')).toBe(true);
    expect(live.allOut('murungai-honey')).toBe(false);
    expect(live.allOut('no-such-honey')).toBe(false);
    expect(live.findCode('honey-sticks:box-10')).toEqual({ slug: 'honey-sticks', label: 'Box of 10 (100 g)' });
    expect(live.findCode('nope')).toBeNull();
    expect(live.packsOf('murungai-honey')).toEqual(['100 g', '250 g', '500 g']);
  });
  it('shows "low" only with the "Only a few left" display', async () => {
    const d = samplePriceData({ sd: 'low_and_sold_out' });
    d.p['murungai-honey']['100 g'][2] = 'low';
    install({ priceData: d });
    const live = await load();
    expect(live.availOf('murungai-honey', '100 g')).toBe('low');
  });
  it('without #price-data (or with broken JSON) nothing has a price and prices count as off', async () => {
    install();
    let live = await load();
    expect(live.showPrices()).toBe(false);
    expect(live.priceOf('murungai-honey', '250 g')).toBeNull();
    const b = install();
    (b.document as Record<string, unknown>).getElementById = (id: string) => (id === 'price-data' ? { textContent: '{ not json' } : null);
    live = await load();
    expect(live.showPrices()).toBe(false);
  });
});

describe('slots', () => {
  it('fills price, from, sold-out, delivery-note and copy slots from the data', async () => {
    const d = samplePriceData();
    d.p['beeswax-candles'].Small[2] = 'out';
    install({ priceData: d });
    const live = await load();
    const price = el({ price: 'murungai-honey|250 g', prefix: ' · ' }, { hidden: true });
    const noPrice = el({ price: 'litchi-honey|250 g' });
    const from = el({ from: 'honey-sticks', prefix: 'From ' }, { hidden: true });
    const soldProduct = el({ soldout: 'beeswax-candles' }, { hidden: true });
    const soldPack = el({ soldout: 'murungai-honey|250 g' });
    const note = el({ deliveryNote: '' }, { hidden: true });
    const showCopy = el({ showPrices: '' }, { hidden: true });
    const hideCopy = el({ hidePrices: '' });
    for (const s of [price, noPrice, from, soldProduct, soldPack, note, showCopy, hideCopy]) live.fillSlot(s as unknown as HTMLElement);
    expect([price.textContent, price.hidden]).toEqual([' · ₹310', false]);
    expect(noPrice.hidden).toBe(true);
    expect([from.textContent, from.hidden]).toEqual(['From ₹7', false]);
    expect(soldProduct.hidden).toBe(false);
    expect(soldPack.hidden).toBe(true);
    expect([note.textContent, note.hidden]).toEqual(['Delivery charges are confirmed on WhatsApp.', false]);
    expect(showCopy.hidden).toBe(false);
    expect(hideCopy.hidden).toBe(true);
  });
  it('hides every price slot while prices are off', async () => {
    install({ priceData: samplePriceData({ show: false }) });
    const live = await load();
    const slots = [el({ price: 'murungai-honey|250 g' }), el({ from: 'murungai-honey' }), el({ deliveryNote: '' }), el({ showPrices: '' })];
    for (const s of slots) live.fillSlot(s as unknown as HTMLElement);
    expect(slots.every((s) => s.hidden)).toBe(true);
    const hideCopy = el({ hidePrices: '' }, { hidden: true });
    live.fillSlot(hideCopy as unknown as HTMLElement);
    expect(hideCopy.hidden).toBe(false);
  });
});

describe('fetching /api/live.json', () => {
  const newer = (): PriceData => { const d = samplePriceData({ lv: 2 }); d.p['murungai-honey']['250 g'] = [33000, 35000, 'in', 'murungai-honey:250g']; return d; };

  it('waits for beezy:ready and an idle moment, then fetches once', async () => {
    const b = install({ priceData: samplePriceData(), slots: [el({ from: 'murungai-honey' })], fetchAnswer: newer() });
    const live = await load();
    live.startLive(() => false);
    b.runIdle();
    expect(b.fetch).not.toHaveBeenCalled();
    b.window.dispatchEvent(new Event('beezy:ready'));
    expect(b.fetch).not.toHaveBeenCalled(); // queued for an idle moment, not straight away
    b.runIdle();
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = b.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/live.json');
    expect(init.credentials).toBe('same-origin');
    expect(live.priceOf('murungai-honey', '250 g')?.price).toBe(33000);
    // a second ready event does nothing more
    b.window.dispatchEvent(new Event('beezy:ready'));
    b.runIdle();
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('Safari (no requestIdleCallback) waits 1.5 s', async () => {
    const b = install({ priceData: samplePriceData(), slots: [el({ live: '' })], idleCallback: false, fetchAnswer: newer() });
    const live = await load();
    live.startLive(() => false);
    b.window.dispatchEvent(new Event('beezy:ready'));
    vi.advanceTimersByTime(1400);
    expect(b.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('a page whose only slots are in the (empty) order drawer does not fetch; a page with an order does', async () => {
    const cartSlots = [el({ deliveryNote: '' }, { inCart: true }), el({ showPrices: '' }, { inCart: true }), el({ hidePrices: '' }, { inCart: true })];
    let b = install({ priceData: samplePriceData(), slots: cartSlots, motionReady: true, fetchAnswer: newer() });
    let live = await load();
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(b.fetch).not.toHaveBeenCalled();
    await live.refreshIfStale();
    expect(b.fetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    b = install({ priceData: samplePriceData(), slots: cartSlots, motionReady: true, fetchAnswer: newer() });
    live = await load();
    live.startLive(() => true);
    b.runIdle();
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('patches only slots whose value changed, and fires live:change once', async () => {
    const changed = countingSlot({ price: 'murungai-honey|250 g', prefix: ' · ' }, ' · ₹310');
    const same = countingSlot({ price: 'murungai-honey|100 g', prefix: ' · ' }, ' · ₹140');
    const b = install({ priceData: samplePriceData(), slots: [changed.slot, same.slot], motionReady: true, fetchAnswer: newer() });
    const live = await load();
    const events: PriceData[] = [];
    live.onLiveChange((d) => events.push(d));
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(changed.slot.textContent).toBe(' · ₹330');
    expect(changed.writes.n).toBe(1);
    expect(same.writes.n).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].lv).toBe(2);
    // the same answer again changes nothing and fires nothing
    vi.advanceTimersByTime(61_000);
    await live.refreshIfStale();
    expect(b.fetch).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(changed.writes.n).toBe(1);
  });

  it('an answer equal to the baked data fires no live:change', async () => {
    const b = install({ priceData: samplePriceData(), slots: [el({ live: '' })], motionReady: true, fetchAnswer: samplePriceData() });
    const live = await load();
    const spy = vi.fn();
    live.onLiveChange(spy);
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores an answer older than the baked data', async () => {
    const old = samplePriceData({ lv: 1 });
    old.p['murungai-honey']['250 g'] = [1000, null, 'out', 'murungai-honey:250g'];
    const b = install({ priceData: samplePriceData({ lv: 5 }), slots: [el({ live: '' })], motionReady: true, fetchAnswer: old });
    const live = await load();
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(live.priceOf('murungai-honey', '250 g')?.price).toBe(31000);
    expect(live.liveVersion()).toBe(5);
  });

  it('switching prices on or off live updates the copy slots', async () => {
    const show = countingSlot({ showPrices: '' }, '', true);
    const b = install({ priceData: samplePriceData({ show: false }), slots: [show.slot], motionReady: true, fetchAnswer: samplePriceData({ lv: 2 }) });
    const live = await load();
    expect(live.priceOf('murungai-honey', '250 g')?.price).toBeNull();
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(live.showPrices()).toBe(true);
    expect(show.slot.hidden).toBe(false);
    expect(live.priceOf('murungai-honey', '250 g')?.price).toBe(31000);
  });

  it('is silent on errors and keeps the baked values (network error, 500, bad JSON, wrong shape)', async () => {
    const answers: unknown[] = [
      () => Promise.reject(new TypeError('offline')),
      500,
      () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
      { lv: 9, show: true },
    ];
    for (const a of answers) {
      vi.unstubAllGlobals();
      const b = install({ priceData: samplePriceData(), slots: [el({ live: '' })], motionReady: true, fetchAnswer: a });
      const live = await load();
      const spy = vi.fn();
      live.onLiveChange(spy);
      live.startLive(() => false);
      b.runIdle();
      await flush();
      expect(b.fetch).toHaveBeenCalledTimes(1);
      expect(live.priceOf('murungai-honey', '250 g')?.price).toBe(31000);
      expect(spy).not.toHaveBeenCalled();
      // a failure is remembered for this tab, so the next page does not ask again at once
      expect(JSON.parse(b.sessionStorage.getItem('beezy-live-v1')!).fail).toBe(true);
    }
  });

  it('keeps an answer in sessionStorage for 2 minutes: the next page uses it without a request', async () => {
    const b = install({ priceData: samplePriceData(), slots: [el({ live: '' })], motionReady: true, fetchAnswer: newer() });
    let live = await load();
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(b.sessionStorage.getItem('beezy-live-v1')).toContain('"lv":2');

    // next page, 90 s later: the stored answer is used at once (before any idle moment), no request
    vi.advanceTimersByTime(90_000);
    live = await load();
    expect(live.priceOf('murungai-honey', '250 g')?.price).toBe(33000);
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);

    // a page after 2 minutes asks again
    vi.advanceTimersByTime(40_000);
    live = await load();
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshIfStale (drawer opening): only when the data is over 60 s old, and not right after a failure', async () => {
    let fail = false;
    const b = install({
      priceData: samplePriceData(), slots: [el({ live: '' })], motionReady: true,
      fetchAnswer: () => (fail ? Promise.reject(new TypeError('offline')) : { ok: true, status: 200, json: async () => newer() }),
    });
    const live = await load();
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    await live.refreshIfStale();
    expect(b.fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31_000);
    fail = true;
    await live.refreshIfStale();
    expect(b.fetch).toHaveBeenCalledTimes(2);
    // just failed: wait a minute before trying again
    vi.advanceTimersByTime(20_000);
    await live.refreshIfStale();
    expect(b.fetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(45_000);
    fail = false;
    await live.refreshIfStale();
    expect(b.fetch).toHaveBeenCalledTimes(3);
  });

  it('refetches when a tab comes back after more than 10 minutes hidden', async () => {
    const b = install({ priceData: samplePriceData(), slots: [el({ live: '' })], motionReady: true, fetchAnswer: newer() });
    const live = await load();
    live.startLive(() => false);
    b.runIdle();
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);
    b.setVisibility('hidden');
    vi.advanceTimersByTime(5 * 60_000);
    b.setVisibility('visible');
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1);
    b.setVisibility('hidden');
    vi.advanceTimersByTime(11 * 60_000);
    b.setVisibility('visible');
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(2);
  });

  it('refetches on a back/forward-cache restore when the data is older than the 2-minute cache', async () => {
    const b = install({ priceData: samplePriceData(), slots: [el({ live: '' })], motionReady: true, fetchAnswer: newer() });
    const live = await load();
    live.startLive(() => false);
    b.runIdle();
    await flush();
    const pageshow = (persisted: boolean) => { const e = new Event('pageshow') as Event & { persisted: boolean }; e.persisted = persisted; b.window.dispatchEvent(e); };
    vi.advanceTimersByTime(60_000);
    pageshow(true);
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1); // the stored answer is still fresh
    vi.advanceTimersByTime(3 * 60_000);
    pageshow(false);
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(1); // a normal load is not a restore
    pageshow(true);
    await flush();
    expect(b.fetch).toHaveBeenCalledTimes(2);
  });

  it('one request at a time', async () => {
    let resolve!: (v: unknown) => void;
    const b = install({ priceData: samplePriceData(), slots: [el({ live: '' })], fetchAnswer: () => new Promise((r) => { resolve = r; }) });
    const live = await load();
    const a = live.refresh();
    const c = live.refresh();
    expect(b.fetch).toHaveBeenCalledTimes(1);
    resolve({ ok: true, status: 200, json: async () => newer() });
    await Promise.all([a, c]);
    expect(live.priceOf('murungai-honey', '250 g')?.price).toBe(33000);
  });
});
