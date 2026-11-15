import { describe, expect, test } from 'vitest';
import { MAX_BODY_BYTES, parseIntakeBody, recordOrder, type IntakeBody } from '../../../src/server/intake';
import { dayBucket, deleteExpired, hit, ipHash, ipHourBucket, peek, unusualTraffic, windowBucket } from '../../../src/server/ratelimit';
import { confirmOrder, getOrder, saveLines } from '../../../src/server/orders';
import { countStock, setAvailability } from '../../../src/server/stock';
import { updateSettings } from '../../../src/server/settings';
import { OWNER, freshDb, pool, row, t } from '../../helpers/db';

const KEY = '0123456789abcdef0123456789abcdef';
const body = (over: Partial<IntakeBody> = {}): IntakeBody => ({
  v: 1, ref: 'BZ-7K3QD', key: KEY, src: 'cart', shown: 69000, lv: 1,
  items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 2 }, { c: 'honey-sticks:box-10', s: 'honey-sticks', p: 'Box of 10 (100 g)', q: 1 }],
  ...over,
});
const meta = (at: string, ip = '203.0.113.7') => ({ ip, ipHashKey: 'test-key', at });

describe('parseIntakeBody (contract 3)', () => {
  test('accepts the contract shape and drops nothing important', () => {
    const r = parseIntakeBody(JSON.stringify(body()));
    expect(r).toEqual({ ok: true, body: body() });
    const g = parseIntakeBody(JSON.stringify(body({ src: 'gift', gift: { size: 3, jar: '100 g', picks: ['Murungai Honey', 'Kombu Honey'], extras: ['Beeswax candle'], boxes: 25, occasion: 'Wedding', neededBy: '2026-12-10', card: 'With love' } })));
    expect(g.ok && g.body.gift).toEqual({ size: 3, jar: '100 g', picks: ['Murungai Honey', 'Kombu Honey'], extras: ['Beeswax candle'], boxes: 25, occasion: 'Wedding', neededBy: '2026-12-10', card: 'With love' });
  });

  test.each([
    ['not JSON', '{nope'],
    ['bad version', JSON.stringify(body({ v: 2 as 1 }))],
    ['bad ref alphabet', JSON.stringify(body({ ref: 'BZ-7K3Q0' }))],
    ['lower-case ref', JSON.stringify(body({ ref: 'bz-7k3qd' }))],
    ['short key', JSON.stringify(body({ key: 'abc' }))],
    ['upper-case key', JSON.stringify(body({ key: KEY.toUpperCase() }))],
    ['bad src', JSON.stringify(body({ src: 'manual' as 'cart' }))],
    ['no items', JSON.stringify(body({ items: [] }))],
    ['31 items', JSON.stringify(body({ items: Array.from({ length: 31 }, () => ({ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 1 })) }))],
    ['qty 0', JSON.stringify(body({ items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 0 }] }))],
    ['qty 100', JSON.stringify(body({ items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 100 }] }))],
    ['qty 1.5', JSON.stringify(body({ items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 1.5 }] }))],
    ['negative shown', JSON.stringify(body({ shown: -1 }))],
    ['array', '[]'],
  ])('refuses %s', (_name, text) => {
    expect(parseIntakeBody(text).ok).toBe(false);
  });

  test('refuses bodies over 8 KB', () => {
    const big = JSON.stringify({ ...body(), pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect(parseIntakeBody(big)).toEqual({ ok: false, reason: 'too large' });
  });
});

describe('recordOrder', () => {
  test('stores a New website order priced from D1 (never from the client) with no personal data', async () => {
    const db = await freshDb();
    const r = await recordOrder(db, body({ shown: 1 }), meta(t(0)));
    expect(r.outcome).toBe('new');
    const d = (await getOrder(db, r.orderId!))!;
    expect(d.order).toMatchObject({ ref: 'BZ-7K3QD', source: 'cart', channel: 'website', status: 'new', itemsTotalPaise: 69000, totalPaise: 69000, shownTotalPaise: 1, priceMismatch: true, shownLiveVersion: 1, updatedBy: 'public' });
    expect(d.lines.map((l) => [l.kind, l.name, l.pack, l.qty, l.unitPricePaise])).toEqual([
      ['item', 'Murungai Honey with comb', '250 g', 2, 31000], ['item', 'Honey Sticks', 'Box of 10 (100 g)', 1, 7000],
    ]);
    const o = await row<{ ip_hash: string; customer_name: string | null }>(db, 'SELECT ip_hash, customer_name FROM orders WHERE id = ?', r.orderId);
    expect(o.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(o.ip_hash).not.toContain('203');
    expect(o.customer_name).toBeNull();
  });

  test('a resend of the same cart updates the same record; after the owner edits or confirms, it changes nothing', async () => {
    const db = await freshDb();
    const a = await recordOrder(db, body(), meta(t(0)));
    const b = await recordOrder(db, body({ items: [{ c: 'murungai-honey:500g', s: 'murungai-honey', p: '500 g', q: 1 }], shown: 65000 }), meta(t(1)));
    expect(b).toEqual({ outcome: 'updated', orderId: a.orderId });
    let d = (await getOrder(db, a.orderId!))!;
    expect(d.lines.map((l) => l.pack)).toEqual(['500 g']);
    expect(d.order).toMatchObject({ itemsTotalPaise: 65000, priceMismatch: false, version: 2 });
    // a different ref with the same key is ignored
    expect(await recordOrder(db, body({ ref: 'BZ-4444A' }), meta(t(2)))).toEqual({ outcome: 'unchanged', orderId: a.orderId });
    // the owner edits → resends no longer overwrite
    expect((await saveLines(db, OWNER, { id: a.orderId!, version: 2, lines: [{ code: 'murungai-honey:500g', qty: 2 }] }, t(3))).ok).toBe(true);
    expect(await recordOrder(db, body(), meta(t(4)))).toEqual({ outcome: 'unchanged', orderId: a.orderId });
    d = (await getOrder(db, a.orderId!))!;
    expect(d.lines.map((l) => [l.pack, l.qty])).toEqual([['500 g', 2]]);
    await confirmOrder(db, OWNER, { id: a.orderId!, version: 3 }, t(5));
    expect(await recordOrder(db, body(), meta(t(6)))).toEqual({ outcome: 'unchanged', orderId: a.orderId });
    expect((await getOrder(db, a.orderId!))!.order.status).toBe('confirmed');
  });

  test('unknown and sold-out items are kept and flagged; old carts map by slug and pack label', async () => {
    const db = await freshDb();
    const kom = await pool(db, 'kombu-honey');
    await countStock(db, OWNER, { counts: [{ poolId: kom.id, amount: 0 }] }, t(0));
    await db.prepare("UPDATE products SET status = 'paused' WHERE slug = 'litchi-honey'").run();
    const r = await recordOrder(db, body({ items: [
      { c: '', s: 'murungai-honey', p: '100 g', q: 1 },                       // old cart without a code
      { c: 'kombu-honey:100g', s: 'kombu-honey', p: '100 g', q: 1 },          // sold out
      { c: 'litchi-honey:100g', s: 'litchi-honey', p: '100 g', q: 1 },        // paused product
      { c: 'gone-honey:1kg', s: 'gone-honey', p: '1 kg', q: 3 },              // unknown
      { c: 'murungai-honey:100g', s: 'murungai-honey', p: '100 g', q: 2 },    // same pack again → merged
    ] }), meta(t(1)));
    expect(r.outcome).toBe('new');
    const d = (await getOrder(db, r.orderId!))!;
    expect(d.lines.map((l) => [l.kind, l.name, l.pack, l.qty, l.unitPricePaise])).toEqual([
      ['item', 'Murungai Honey with comb', '100 g', 3, 14000],
      ['item', 'Kombu Honey', '100 g', 1, 28000],
      ['custom', 'Litchi Honey', '100 g', 1, null],
      ['custom', 'gone-honey', '1 kg', 3, null],
    ]);
    expect(d.order.flags).toEqual({
      unknown: [{ c: 'litchi-honey:100g', s: 'litchi-honey', p: '100 g' }, { c: 'gone-honey:1kg', s: 'gone-honey', p: '1 kg' }],
      soldOut: ['kombu-honey:100g'],
    });
  });

  test('gift orders keep gift_json, needed-by and the bulk flag', async () => {
    const db = await freshDb();
    const gift = { size: 3, jar: '100 g', picks: ['Murungai Honey'], extras: [], boxes: 20, occasion: 'Wedding', neededBy: '2026-12-10', card: null };
    const r = await recordOrder(db, body({ src: 'gift', gift }), meta(t(0)));
    const d = (await getOrder(db, r.orderId!))!;
    expect(d.order).toMatchObject({ source: 'gift', isBulk: true, neededBy: '2026-12-10', gift });
  });

  test('over 20 per IP hash per hour is stored as spam; over the daily cap nothing is stored; Pause stores nothing', async () => {
    const db = await freshDb();
    const key = (i: number) => i.toString(16).padStart(32, '0');
    for (let i = 1; i <= 20; i++) expect((await recordOrder(db, body({ key: key(i) }), meta(t(0)))).outcome).toBe('new');
    expect((await recordOrder(db, body({ key: key(21) }), meta(t(1)))).outcome).toBe('spam');
    expect((await recordOrder(db, body({ key: key(22) }), meta(t(1), '198.51.100.1'))).outcome).toBe('new'); // another IP
    expect((await recordOrder(db, body({ key: key(23) }), meta(t(61)))).outcome).toBe('new');                // next hour
    expect((await row<{ n: number }>(db, "SELECT COUNT(*) AS n FROM orders WHERE status = 'spam'")).n).toBe(1);

    await updateSettings(db, OWNER, { values: { order_intake: { enabled: true, perIpHour: 20, perDay: 24 } } }, t(62));
    expect((await recordOrder(db, body({ key: key(24) }), meta(t(62), '192.0.2.1'))).outcome).toBe('new');
    expect((await recordOrder(db, body({ key: key(25) }), meta(t(62), '192.0.2.2'))).outcome).toBe('daily_cap');
    expect(await unusualTraffic(db, 24, t(63))).toEqual([{ day: '2026-11-15', count: 25 }]);
    await updateSettings(db, OWNER, { values: { order_intake: { enabled: false, perIpHour: 20, perDay: 300 } } }, t(64));
    expect(await recordOrder(db, body({ key: key(26) }), meta(t(64)))).toEqual({ outcome: 'paused', orderId: null });
    expect((await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM orders')).n).toBe(24);
  });
});

describe('rate-limit buckets', () => {
  test('fixed windows count per bucket and expire', async () => {
    const db = await freshDb({ seed: false });
    const h = await ipHash('k', '203.0.113.7', '2026-11-15T04:30:00Z');
    expect(h).toHaveLength(32);
    expect(await ipHash('k', '203.0.113.7', '2026-11-15T18:29:00Z')).toBe(h);   // same IST day
    expect(await ipHash('k', '203.0.113.7', '2026-11-15T18:30:00Z')).not.toBe(h); // next IST day
    expect(await ipHash('other', '203.0.113.7', '2026-11-15T04:30:00Z')).not.toBe(h);
    // a missing IP_HASH_KEY uses a random per-isolate key: stable here, never a known fixed key
    const noKey = await ipHash('', '203.0.113.7', '2026-11-15T04:30:00Z');
    expect(await ipHash('', '203.0.113.7', '2026-11-15T05:30:00Z')).toBe(noKey);
    expect(noKey).not.toBe(await ipHash('beezy-local-ip-hash', '203.0.113.7', '2026-11-15T04:30:00Z'));
    expect(ipHourBucket('abc', '2026-11-15T04:29:59Z')).toBe('ip:abc:2026111509');
    expect(ipHourBucket('abc', '2026-11-15T04:30:00Z')).toBe('ip:abc:2026111510');
    expect(dayBucket('2026-11-15T18:30:00Z')).toBe('day:20261116');
    expect(windowBucket('login:a', 15, '2026-11-15T04:44:59Z').bucket).toBe(windowBucket('login:a', 15, '2026-11-15T04:30:00Z').bucket);
    expect(windowBucket('login:a', 15, '2026-11-15T04:45:00Z')).toEqual({ bucket: `login:a:${Date.parse('2026-11-15T04:45:00Z') / 60_000}`, resetsAt: '2026-11-15T05:00:00Z' });
    expect(await hit(db, 'b1', '2026-11-15T04:30:00Z')).toBe(1);
    expect(await hit(db, 'b1', '2026-11-15T04:31:00Z')).toBe(2);
    expect(await hit(db, 'b2', '2026-11-15T04:31:00Z', { minutes: 1 })).toBe(1);
    expect(await peek(db, 'b1')).toBe(2);
    expect(await peek(db, 'none')).toBe(0);
    expect(await deleteExpired(db, '2026-11-15T05:00:00Z')).toBe(1); // b2 expired at 04:32
    expect(await peek(db, 'b2')).toBe(0);
    expect(await deleteExpired(db, '2026-11-15T07:00:00Z')).toBe(1);
  });
});

describe('sold-out flag follows the availability override', () => {
  test('override out → flagged', async () => {
    const db = await freshDb();
    const p = await pool(db, 'sunflower-honey');
    await setAvailability(db, OWNER, { poolId: p.id, version: p.version, availability: 'out' }, t(0));
    const r = await recordOrder(db, body({ items: [{ c: 'sunflower-honey:250g', s: 'sunflower-honey', p: '250 g', q: 1 }] }), meta(t(1)));
    expect((await getOrder(db, r.orderId!))!.order.flags).toEqual({ soldOut: ['sunflower-honey:250g'] });
  });
});
