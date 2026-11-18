// src/server/dashboard.ts on the D1 shim with the real seed: ranges, sales, orders and delivery, stock, insights.
import { describe, expect, it } from 'vitest';
import { freshDb, OWNER, pool, row, variantId } from '../../helpers/db';
import { advanceOrder, createManualOrder } from '../../../src/server/orders';
import { addHarvest } from '../../../src/server/stock';
import {
  alignTo, busiest, change, cumulative, minusYear, ordersDash, overviewDash, rangeFromParam, salesDash, stockDash, weekStarts,
} from '../../../src/server/dashboard';

type Db = Awaited<ReturnType<typeof freshDb>>;

const NOW = '2026-11-15T04:30:00Z'; // Sunday 10:00 IST

async function order(db: Db, code: string, qty: number, at: string, o: { channel?: 'whatsapp' | 'phone'; status?: 'new' | 'confirmed'; isTest?: boolean; delivery?: number } = {}) {
  const v = await variantId(db, code);
  const r = await createManualOrder(db, OWNER, {
    channel: o.channel ?? 'phone', lines: [{ variantId: v, qty }], deliveryPaise: o.delivery ?? 0,
    status: o.status ?? 'confirmed', isTest: o.isTest ?? false,
  }, at);
  if (!r.ok) throw new Error(r.message);
  return r.value.id;
}

async function advance(db: Db, id: number, to: 'packed' | 'shipped' | 'delivered', at: string) {
  const { version } = await row<{ version: number }>(db, 'SELECT version FROM orders WHERE id = ?', id);
  const r = await advanceOrder(db, OWNER, { id, version, to }, at);
  if (!r.ok) throw new Error(r.message);
}

/** 100 kg of Murungai honey in, then five orders at known times (see the comments) */
async function shop() {
  const db = await freshDb();
  const murungai = await pool(db, 'murungai-honey');
  const h = await addHarvest(db, OWNER, { poolId: murungai.id, harvestedOn: '2026-10-26', amount: 100_000 }, '2026-10-26T05:00:00Z');
  if (!h.ok) throw new Error(h.message);

  // A: Tue 10 Nov 10:30 IST, 2 × 250 g + ₹50 delivery, whatsapp. Packed next day, sent the day after, delivered 14 Nov (4 days after confirming). Unpaid.
  const a = await order(db, 'murungai-honey:250g', 2, '2026-11-10T05:00:00Z', { channel: 'whatsapp', delivery: 5000 });
  await advance(db, a, 'packed', '2026-11-11T05:00:00Z');
  await advance(db, a, 'shipped', '2026-11-12T05:00:00Z');
  await advance(db, a, 'delivered', '2026-11-14T05:00:00Z');
  // B: Thu 12 Nov 18:30 IST, 1 × 100 g, still only confirmed 2.6 days later → late
  const b = await order(db, 'murungai-honey:100g', 1, '2026-11-12T13:00:00Z');
  // C: Thu 12 Nov 10:30 IST, 1 × 500 g, sent on 13 Nov (not late)
  const c = await order(db, 'murungai-honey:500g', 1, '2026-11-12T05:00:00Z');
  await advance(db, c, 'packed', '2026-11-12T07:00:00Z');
  await advance(db, c, 'shipped', '2026-11-13T05:00:00Z');
  // D: a test order and E: a new order nobody confirmed yet
  await order(db, 'murungai-honey:100g', 3, '2026-11-11T05:00:00Z', { isTest: true });
  const e = await order(db, 'murungai-honey:100g', 1, '2026-11-13T05:00:00Z', { status: 'new' });
  // F: an old sale, in the range before (1 Oct)
  const f = await order(db, 'murungai-honey:250g', 1, '2026-10-01T05:00:00Z');
  return { db, a, b, c, e, f, pool: murungai };
}

describe('ranges and helpers', () => {
  it('every range ends today and compares with a like-for-like period', () => {
    const r30 = rangeFromParam('30', NOW);
    expect([r30.period.firstDay, r30.period.endDay, r30.days, r30.by]).toEqual(['2026-10-17', '2026-11-16', 30, 'day']);
    expect([r30.previous.firstDay, r30.previous.endDay]).toEqual(['2026-09-17', '2026-10-17']);
    expect(rangeFromParam('7', NOW).period.firstDay).toBe('2026-11-09');
    const month = rangeFromParam('month', NOW);
    expect([month.period.firstDay, month.period.endDay, month.previous.firstDay, month.previous.endDay]).toEqual(['2026-11-01', '2026-11-16', '2026-10-01', '2026-10-16']);
    const fy = rangeFromParam('fy', NOW);
    expect([fy.period.firstDay, fy.period.endDay, fy.previous.firstDay, fy.previous.endDay, fy.by]).toEqual(['2026-04-01', '2026-11-16', '2025-04-01', '2025-11-16', 'month']);
    expect(rangeFromParam('nonsense', NOW).key).toBe('30');
    expect(rangeFromParam(null, NOW).key).toBe('30');
    // 31 Mar is still the old financial year, 1 Apr starts the new one
    expect(rangeFromParam('fy', '2027-03-31T10:00:00Z').period.firstDay).toBe('2026-04-01');
    expect(rangeFromParam('fy', '2027-03-31T18:30:00Z').period.firstDay).toBe('2027-04-01');
  });

  it('small helpers', () => {
    expect(minusYear('2028-02-29')).toBe('2027-02-28');
    expect(change(150, 100)).toBe(0.5);
    expect(change(5, 0)).toBeNull();
    expect(cumulative([1, 2, 3])).toEqual([1, 3, 6]);
    expect(alignTo([1, 2], 4)).toEqual([1, 2, 0, 0]);
    expect(alignTo([1, 2, 3], 2)).toEqual([1, 2]);
    // Sunday 15 Nov belongs to the week of Monday 9 Nov
    expect(weekStarts(NOW, 3)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
    expect(busiest([{ weekday: 1, part: 1, orders: 1 }])).toBeNull();
    expect(busiest([{ weekday: 1, part: 1, orders: 4 }, { weekday: 3, part: 3, orders: 2 }])).toEqual({ weekday: 1, part: 1, orders: 4 });
  });
});

describe('sales dashboard', () => {
  it('counts only real sales, groups by channel and by weekday and time of day (IST), compares with the range before', async () => {
    const { db } = await shop();
    const d = await salesDash(db, rangeFromParam('30', NOW));
    // A, B, C count; the test order and the unconfirmed one do not; F is in the range before
    expect(d.totals.orders).toBe(3);
    expect(d.previous.orders).toBe(1);
    expect(d.totals.netPaise).toBe(2 * 31000 + 5000 + 14000 + 65000);
    expect(d.channels.find((x) => x.channel === 'whatsapp')).toMatchObject({ orders: 1, netPaise: 67000 });
    expect(d.channels.find((x) => x.channel === 'phone')).toMatchObject({ orders: 2 });
    // one bar per day, zeros filled, and the same length for the range before
    expect(d.series).toHaveLength(30);
    expect(d.previousSeries).toHaveLength(30);
    expect(d.series.find((p) => p.key === '2026-11-10')?.netPaise).toBe(67000);
    // Thursday 12 Nov has B and C (₹790), more than A on the Tuesday (₹670)
    expect(d.best?.key).toBe('2026-11-12');
    expect(d.best?.netPaise).toBe(14000 + 65000);
    // A: Tuesday morning; B: Thursday evening; C: Thursday morning
    expect(d.heat).toEqual(expect.arrayContaining([
      { weekday: 2, part: 1, orders: 1 }, { weekday: 4, part: 3, orders: 1 }, { weekday: 4, part: 1, orders: 1 },
    ]));
    expect(d.byProduct.products[0].name).toBe('Murungai Honey');
    expect(d.insights.map((i) => i.id)).toContain('sales.up');
    expect(d.insights.map((i) => i.id)).toContain('sales.outstanding');
  });

  it('a long range is drawn per month', async () => {
    const { db } = await shop();
    const d = await salesDash(db, rangeFromParam('fy', NOW));
    expect(d.series.map((p) => p.key)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(d.series.at(-1)?.orders).toBe(3);
    expect(d.series.at(-2)?.orders).toBe(1);
  });

  it('an empty shop says so instead of dividing by zero', async () => {
    const db = await freshDb();
    const d = await salesDash(db, rangeFromParam('30', NOW));
    expect(d.totals.orders).toBe(0);
    expect(d.best).toBeNull();
    expect(d.insights).toEqual([{ id: 'sales.none', tone: 'info', vars: {} }]);
  });
});

describe('orders and delivery dashboard', () => {
  it('follows the orders through the steps and measures the time between them', async () => {
    const { db } = await shop();
    const d = await ordersDash(db, rangeFromParam('30', NOW), NOW);
    // came in during the range: A, B, C, E (the test order never counts); F came in earlier
    expect(d.funnel).toMatchObject({ received: 4, confirmed: 3, packed: 2, sent: 2, delivered: 1, cancelled: 0, spam: 0 });
    expect(d.previousReceived).toBe(1);
    expect(d.stages).toMatchObject({ delivered: 1, deliveredPaise: 67000, confirmToPack: 1, packToSend: 1, sendToDeliver: 2, confirmToDeliver: 4 });
    expect(d.buckets.find((b) => b.id === 'd45')?.count).toBe(1);
    expect(d.buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
    expect(d.deliveredSeries).toHaveLength(30);
    expect(d.deliveredSeries.find((p) => p.key === '2026-11-14')?.value).toBe(1);
    // now: F (1 Oct) and B (2.6 days) wait to be packed (late), C is on its way (not late). Oldest first.
    expect(d.open).toMatchObject({ confirmed: 2, packed: 0, shipped: 1, late: 2 });
    expect(d.open.list.map((o) => [o.status, o.late])).toEqual([['confirmed', true], ['confirmed', true], ['shipped', false]]);
    expect(d.unpaidDelivered).toEqual({ orders: 1, paise: 67000 });
    // website orders only: these three are manual, so there is nothing to time
    expect(d.response.orders).toBe(0);
    expect(d.insights.map((i) => i.id)).toEqual(expect.arrayContaining(['orders.late', 'orders.unpaid']));
  });
});

describe('stock dashboard', () => {
  it('shows what is left, how long it lasts, the weekly flow and the latest moves', async () => {
    const { db, pool: p } = await shop();
    const d = await stockDash(db, NOW);
    const onHand = (await row<{ on_hand: number }>(db, 'SELECT on_hand FROM stock_pools WHERE id = ?', p.id)).on_hand;
    // 100 kg in; sold 500 + 100 + 500 (A, B, C) + 250 (F) + 3 × 100 test? the test order is not a sale but it did take stock
    expect(onHand).toBeLessThan(100_000);
    expect(d.honeyGrams).toBe(onHand);
    const mur = d.cover.find((c) => c.id === p.id)!;
    expect(mur.daysOfCover).not.toBeNull();
    expect(mur.used30).toBeGreaterThan(0);
    expect(d.worthPaise).toBeGreaterThan(0);
    expect(d.flow).toHaveLength(8);
    expect(d.flow.at(-1)?.week).toBe('2026-11-09');
    const week = d.flow.find((w) => w.week === '2026-11-09')!;
    expect(week.sold).toBeGreaterThan(0);
    expect(d.flow.find((w) => w.week === '2026-10-26')?.harvested).toBe(100_000);
    expect(d.moves.length).toBeGreaterThan(0);
    expect(d.moves[0].id).toBeGreaterThan(d.moves.at(-1)!.id);
    // the other honeys are not counted yet
    expect(d.untracked).toBeGreaterThan(0);
    expect(d.insights.map((i) => i.id)).toContain('stock.untracked');
  });
});

describe('overview', () => {
  it('puts the three views together and keeps the four most important observations, worst first', async () => {
    const { db } = await shop();
    const o = await overviewDash(db, rangeFromParam('30', NOW), NOW);
    expect(o.sales.totals.orders).toBe(3);
    expect(o.orders.open.late).toBe(2);
    expect(o.stock.pools.length).toBeGreaterThan(10);
    expect(o.insights.length).toBeLessThanOrEqual(4);
    const order = { bad: 0, warn: 1, good: 2, info: 3 } as const;
    expect(o.insights.map((i) => order[i.tone])).toEqual([...o.insights.map((i) => order[i.tone])].sort((a, b) => a - b));
  });
});
