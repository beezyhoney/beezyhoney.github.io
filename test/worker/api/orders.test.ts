// POST /api/orders.json (contract 3, design §2.3) in workerd with the real D1: every intake rule.
// The answer is always 204 with no body; what is (or is not) stored is checked in D1.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as ordersGET, POST as ordersPOST } from '../../../src/pages/api/orders.json';
import { handleIntake, intakeOriginOk, MAX_BODY_BYTES, readBodyLimited } from '../../../src/server/intake';
import { row, rows, seedDb, sql } from './_seed';

const ORIGIN = 'https://beezyhoney.in';
const URL_ = `${ORIGIN}/api/orders.json`;
let n = 0;
const hex = (i: number) => i.toString(16).padStart(32, '0');
const AT = '2026-11-15T04:30:00Z'; // 10:00 IST

interface Body { v: number; ref: string; key: string; src: string; items: { c: string; s: string; p: string; q: number }[]; shown: number | null; lv: number | null; gift?: unknown }
const body = (over: Partial<Body> = {}): Body => ({
  v: 1, ref: 'BZ-7K3QD', key: hex(++n), src: 'cart',
  items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 2 }, { c: 'honey-sticks:box-10', s: 'honey-sticks', p: 'Box of 10 (100 g)', q: 1 }],
  shown: 69000, lv: 1, ...over,
});

function post(payload: unknown, headers: Record<string, string> = {}, init: { raw?: string } = {}) {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: init.raw ?? JSON.stringify(payload),
  });
}

async function send(payload: unknown, headers: Record<string, string> = {}, init: { raw?: string; at?: string } = {}) {
  const res = await handleIntake(env, post(payload, headers, init), { at: init.at ?? AT });
  expect(res.status).toBe(204);
  expect(await res.text()).toBe('');
  return res;
}

const orderByKey = (key: string) => row<Record<string, unknown>>('SELECT * FROM orders WHERE client_key = ?', key);
const count = async () => (await row<{ n: number }>('SELECT count(*) AS n FROM orders'))!.n;
const setIntake = (v: Record<string, unknown>) => sql("UPDATE settings SET value = ? WHERE key = 'order_intake'", JSON.stringify({ enabled: true, perIpHour: 20, perDay: 300, ...v })).run();

beforeAll(async () => {
  await seedDb();
});

beforeEach(async () => {
  await setIntake({});
  await sql('DELETE FROM rate_limits').run();
});

describe('origin and size checks (refused requests store nothing)', () => {
  it('stores nothing without a same-origin proof', async () => {
    const before = await count();
    await send(body(), { origin: '' });
    await send(body(), { origin: 'https://evil.example' });
    await send(body(), { origin: 'https://next.beezyhoney.in' }); // another public host, but not this request's origin
    await send(body(), { 'sec-fetch-site': 'cross-site' });
    await send(body(), { 'sec-fetch-site': 'same-site' });
    await send(body(), { origin: 'null' });
    expect(await count()).toBe(before);
  });

  it('intakeOriginOk: Sec-Fetch-Site same-origin (when sent) and Origin = this public origin', () => {
    const u = new URL(URL_);
    const r = (h: Record<string, string>) => new Request(URL_, { method: 'POST', headers: h });
    const hosts = env.PUBLIC_HOSTS;
    expect(intakeOriginOk(r({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' }), u, hosts)).toBe(true);
    expect(intakeOriginOk(r({ origin: ORIGIN }), u, hosts)).toBe(true); // older browsers without Sec-Fetch-Site
    expect(intakeOriginOk(r({ 'sec-fetch-site': 'same-origin' }), u, hosts)).toBe(false); // Origin is required
    expect(intakeOriginOk(r({ origin: 'https://admin.beezyhoney.in' }), new URL('https://admin.beezyhoney.in/api/orders.json'), hosts)).toBe(false);
    expect(intakeOriginOk(r({ origin: 'http://127.0.0.1:4421' }), new URL('http://127.0.0.1:4421/api/orders.json'), hosts)).toBe(true);
    expect(intakeOriginOk(r({ origin: ORIGIN }), u, '')).toBe(false); // no public hosts configured: fail closed
  });

  it('stores nothing for bodies over 8 KB (also when the length is not declared), or not UTF-8', async () => {
    const before = await count();
    const big = JSON.stringify({ ...body(), pad: 'x'.repeat(MAX_BODY_BYTES) });
    await send(null, {}, { raw: big });
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1000))); c.close(); },
    });
    const res = await handleIntake(env, new Request(URL_, { method: 'POST', headers: { origin: ORIGIN }, body: stream, duplex: 'half' } as RequestInit), { at: AT });
    expect(res.status).toBe(204);
    expect(await readBodyLimited(new Request(URL_, { method: 'POST', body: new Uint8Array([0xff, 0xfe, 0x41]) }), 100)).toBeNull();
    expect(await readBodyLimited(new Request(URL_, { method: 'POST', body: 'abc' }), 3)).toBe('abc');
    expect(await readBodyLimited(new Request(URL_, { method: 'POST', body: 'abcd' }), 3)).toBeNull();
    expect(await count()).toBe(before);
  });

  it('stores nothing for a bad schema: not JSON, ref, key, src, items, qty', async () => {
    const before = await count();
    await send(null, {}, { raw: 'not json' });
    await send(body({ v: 2 }));
    await send(body({ ref: 'BZ-0O1IS' })); // look-alike characters are not in the alphabet
    await send(body({ ref: 'bz-7k3qd' }));
    await send(body({ key: 'ABC' }));
    await send(body({ src: 'admin' }));
    await send(body({ items: [] }));
    await send(body({ items: Array.from({ length: 31 }, () => ({ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 1 })) }));
    await send(body({ items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 0 }] }));
    await send(body({ items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 100 }] }));
    await send(body({ shown: -5 }));
    expect(await count()).toBe(before);
  });
});

describe('storing an order', () => {
  it('prices from D1 (never the client), flags a mismatch, keeps no IP in clear', async () => {
    const b = body({ shown: 1 });
    await send(b);
    const o = await orderByKey(b.key);
    expect(o).toMatchObject({ ref: 'BZ-7K3QD', source: 'cart', channel: 'website', status: 'new', items_total_paise: 69000, total_paise: 69000, shown_total_paise: 1, price_mismatch: 1, updated_by: 'public' });
    expect(String(o!.ip_hash)).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(o)).not.toContain('203.0.113.7');
    const lines = await rows('SELECT kind, name_snapshot, pack_snapshot, qty, unit_price_paise, line_total_paise FROM order_lines WHERE order_id = ? ORDER BY sort', o!.id);
    expect(lines).toEqual([
      { kind: 'item', name_snapshot: 'Murungai Honey with comb', pack_snapshot: '250 g', qty: 2, unit_price_paise: 31000, line_total_paise: 62000 },
      { kind: 'item', name_snapshot: 'Honey Sticks', pack_snapshot: 'Box of 10 (100 g)', qty: 1, unit_price_paise: 7000, line_total_paise: 7000 },
    ]);
    const good = body({ shown: 69000 });
    await send(good);
    expect((await orderByKey(good.key))!.price_mismatch).toBe(0);
  });

  it('keeps unknown and sold-out items, flagged', async () => {
    await sql("UPDATE stock_pools SET track_stock = 1, on_hand = 0 WHERE code = 'sunflower-honey'").run();
    const b = body({ items: [
      { c: 'sunflower-honey:250g', s: 'sunflower-honey', p: '250 g', q: 1 },
      { c: 'gone-honey:1kg', s: 'gone-honey', p: '1 kg', q: 1 },
    ], shown: null });
    await send(b);
    const o = await orderByKey(b.key);
    expect(JSON.parse(String(o!.flags_json))).toEqual({ unknown: [{ c: 'gone-honey:1kg', s: 'gone-honey', p: '1 kg' }], soldOut: ['sunflower-honey:250g'] });
    const kinds = await rows<{ kind: string }>('SELECT kind FROM order_lines WHERE order_id = ? ORDER BY sort', o!.id);
    expect(kinds.map((k) => k.kind)).toEqual(['item', 'custom']);
    await sql("UPDATE stock_pools SET track_stock = 0, on_hand = 0 WHERE code = 'sunflower-honey'").run();
  });

  it('a resend of the same key updates the same order; after the owner touched it nothing changes', async () => {
    const b = body();
    await send(b);
    const first = await orderByKey(b.key);
    await send({ ...b, items: [{ c: 'murungai-honey:500g', s: 'murungai-honey', p: '500 g', q: 1 }], shown: 65000 });
    const second = await orderByKey(b.key);
    expect(second!.id).toBe(first!.id);
    expect(second).toMatchObject({ items_total_paise: 65000, version: 2 });
    expect((await rows('SELECT id FROM order_lines WHERE order_id = ?', first!.id)).length).toBe(1);
    // the owner edits it: a resend no longer changes anything
    await sql("UPDATE orders SET updated_by = 'owner@example.test', version = version + 1 WHERE id = ?", first!.id).run();
    await send(b);
    expect(await orderByKey(b.key)).toMatchObject({ items_total_paise: 65000, version: 3 });
    // a different ref with the same key is refused too
    await send({ ...b, ref: 'BZ-7K3QE' });
    expect((await orderByKey(b.key))!.ref).toBe('BZ-7K3QD');
  });

  it('a gift request may come without priced lines and keeps its gift details; bulk from gift.bulkFrom boxes', async () => {
    const gift = { size: 3, jar: '250 g', picks: ['murungai-honey', 'forest-honey', 'kombu-honey'], extras: [], boxes: 25, occasion: 'Wedding', neededBy: '2026-12-01', card: 'With love' };
    const b = body({ src: 'gift', items: [], shown: null, gift });
    await send(b);
    const o = await orderByKey(b.key);
    expect(o).toMatchObject({ source: 'gift', is_bulk: 1, needed_by: '2026-12-01', items_total_paise: 0 });
    expect(JSON.parse(String(o!.gift_json))).toMatchObject({ boxes: 25, picks: gift.picks, card: 'With love' });
    // a cart order without items is still refused
    const before = await count();
    await send(body({ src: 'cart', items: [], gift }));
    expect(await count()).toBe(before);
  });
});

describe('abuse limits', () => {
  it('over the hourly limit per IP hash, orders are stored as spam (never rejected)', async () => {
    await setIntake({ perIpHour: 2 });
    const keys = [body(), body(), body()];
    for (const k of keys) await send(k, { 'cf-connecting-ip': '198.51.100.9' });
    const statuses = await Promise.all(keys.map(async (k) => (await orderByKey(k.key))!.status));
    expect(statuses).toEqual(['new', 'new', 'spam']);
    // another IP is not affected
    const other = body();
    await send(other, { 'cf-connecting-ip': '198.51.100.10' });
    expect((await orderByKey(other.key))!.status).toBe('new');
    // buckets hold an HMAC of the IP, never the IP
    const buckets = await rows<{ bucket: string }>('SELECT bucket FROM rate_limits');
    expect(buckets.map((b) => b.bucket).join(' ')).not.toContain('198.51.100');
  });

  it('over the daily cap nothing is stored (the unusual-traffic alert reads the day counter)', async () => {
    await setIntake({ perDay: 2 });
    const keys = [body(), body(), body()];
    for (const k of keys) await send(k);
    expect(await orderByKey(keys[0].key)).not.toBeNull();
    expect(await orderByKey(keys[1].key)).not.toBeNull();
    expect(await orderByKey(keys[2].key)).toBeNull();
    const day = await row<{ count: number }>("SELECT count FROM rate_limits WHERE bucket = 'day:20261115'");
    expect(day!.count).toBe(3);
  });

  it('"Pause order recording" stores nothing', async () => {
    await setIntake({ enabled: false });
    const b = body();
    await send(b);
    expect(await orderByKey(b.key)).toBeNull();
  });
});

describe('the route module', () => {
  it('POST answers 204 at once and stores the order inside waitUntil', async () => {
    const b = body();
    const ctx = createExecutionContext();
    const res = await ordersPOST({ request: post(b), url: new URL(URL_), params: {}, locals: { cfContext: ctx } } as never);
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await waitOnExecutionContext(ctx);
    expect((await orderByKey(b.key))!.status).toBe('new');
  });

  it('GET is refused with 405', async () => {
    const res = await ordersGET({ request: new Request(URL_), url: new URL(URL_), params: {}, locals: {} } as never);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('a D1 failure is logged, never shown (still 204)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { ...env, DB: { prepare: env.DB.prepare.bind(env.DB), batch: () => Promise.reject(new Error('D1 down')) } } as never;
    const res = await handleIntake(broken, post(body()), { at: AT });
    expect(res.status).toBe(204);
    expect(err).toHaveBeenCalledWith('[orders] intake failed:', 'D1 down');
    err.mockRestore();
  });
});
