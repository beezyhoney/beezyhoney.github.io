import { describe, expect, test } from 'vitest';
import {
  askedVsConfirmed, calendarYearPeriod, customPeriod, financialYearPeriod, monthPeriod, periodFromParams, poolUsage,
  previousPeriod, productHistory, salesByProduct, salesReport, salesSeries, salesTotals,
} from '../../../src/server/sales-queries';
import { addPayment, cancelOrder, confirmOrder, createManualOrder, markSpam, saveCharges } from '../../../src/server/orders';
import { recordOrder } from '../../../src/server/intake';
import type { D1 } from '../../../src/server/db';
import { OWNER, freshDb, pool, row } from '../../helpers/db';

async function sale(db: D1, confirmedAt: string, lines: { code: string; qty: number; unitPricePaise?: number | null }[], extra: { deliveryPaise?: number; discountPaise?: number; isTest?: boolean } = {}) {
  const r = await createManualOrder(db, OWNER, { channel: 'phone', lines, isTest: extra.isTest }, confirmedAt);
  if (!r.ok) throw new Error(r.message);
  let version = 1;
  if (extra.deliveryPaise || extra.discountPaise) {
    const c = await saveCharges(db, OWNER, { id: r.value.id, version, deliveryPaise: extra.deliveryPaise ?? 0, discountPaise: extra.discountPaise ?? 0 }, confirmedAt);
    if (!c.ok) throw new Error(c.message);
    version = c.value.version;
  }
  const c = await confirmOrder(db, OWNER, { id: r.value.id, version }, confirmedAt);
  if (!c.ok) throw new Error(c.message);
  return { id: r.value.id, version: c.value.version };
}

describe('periods (IST)', () => {
  test('month, calendar year and financial year edges are IST midnights', () => {
    expect(monthPeriod('2026-04')).toMatchObject({ label: 'April 2026', from: '2026-03-31T18:30:00Z', to: '2026-04-30T18:30:00Z' });
    expect(financialYearPeriod(2026)).toMatchObject({ key: '2026-27', label: 'FY 2026-27', from: '2026-03-31T18:30:00Z', to: '2027-03-31T18:30:00Z' });
    expect(calendarYearPeriod(2026)).toMatchObject({ from: '2025-12-31T18:30:00Z', to: '2026-12-31T18:30:00Z' });
    expect(customPeriod('2026-11-01', '2026-11-15')).toMatchObject({ label: '1 Nov 2026 – 15 Nov 2026', from: '2026-10-31T18:30:00Z', to: '2026-11-15T18:30:00Z' });
    expect(previousPeriod(monthPeriod('2026-01')).key).toBe('2025-12');
    expect(previousPeriod(financialYearPeriod(2026)).key).toBe('2025-26');
    expect(previousPeriod(customPeriod('2026-11-11', '2026-11-15')).key).toBe('2026-11-06..2026-11-10');
    expect(periodFromParams({ period: 'fy' }, '2026-03-31T18:29:59Z').key).toBe('2025-26');
    expect(periodFromParams({ period: 'fy' }, '2026-03-31T18:30:00Z').key).toBe('2026-27');
    expect(periodFromParams({ month: '2026-02' }).key).toBe('2026-02');
    expect(periodFromParams({ period: 'custom', from: '2026-11-20', to: '2026-11-01' }, '2026-11-15T00:00:00Z').key).toBe('2026-11');
  });
});

describe('sales aggregation', () => {
  test('31 Mar 23:59 IST and 1 Apr 00:00 IST fall in different months and financial years', async () => {
    const db = await freshDb();
    await sale(db, '2026-03-31T18:29:59Z', [{ code: 'murungai-honey:250g', qty: 1 }]); // 31 Mar 23:59:59 IST
    await sale(db, '2026-03-31T18:30:00Z', [{ code: 'murungai-honey:500g', qty: 1 }]); // 1 Apr 00:00 IST
    expect((await salesTotals(db, monthPeriod('2026-03'))).netPaise).toBe(31000);
    expect((await salesTotals(db, monthPeriod('2026-04'))).netPaise).toBe(65000);
    expect((await salesTotals(db, financialYearPeriod(2025))).netPaise).toBe(31000);
    expect((await salesTotals(db, financialYearPeriod(2026))).netPaise).toBe(65000);
    expect((await salesTotals(db, calendarYearPeriod(2026))).netPaise).toBe(96000);
    const series = await salesSeries(db, financialYearPeriod(2025));
    expect(series).toHaveLength(12);
    expect(series[0]).toMatchObject({ key: '2025-04', label: 'Apr', netPaise: 0 });
    expect(series[11]).toMatchObject({ key: '2026-03', label: 'Mar', netPaise: 31000, orders: 1, units: 1 });
    const days = await salesSeries(db, monthPeriod('2026-04'));
    expect(days).toHaveLength(30);
    expect(days[0]).toMatchObject({ key: '2026-04-01', label: '1', netPaise: 65000 });
  });

  test('totals: items, delivery, discount, net, units, grams, collected vs outstanding; only real sales count', async () => {
    const db = await freshDb();
    const at = '2026-11-10T06:00:00Z';
    const a = await sale(db, at, [{ code: 'murungai-honey:250g', qty: 2 }, { code: 'honey-sticks:box-10', qty: 1 }], { deliveryPaise: 5000, discountPaise: 2000 });
    await addPayment(db, OWNER, { id: a.id, amountPaise: 50000, method: 'upi' }, at);
    await sale(db, at, [{ code: 'beeswax-candles:large', qty: 2 }]);
    await sale(db, at, [{ code: 'dammar-honey:500g', qty: 1 }], { isTest: true });              // test order: never counts
    const c = await sale(db, at, [{ code: 'kombu-honey:500g', qty: 1 }]);
    await cancelOrder(db, OWNER, { id: c.id, version: c.version }, at);                          // cancelled: never counts
    const n = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'forest-honey:500g', qty: 1 }] }, at);  // New: never counts
    if (n.ok) await markSpam(db, OWNER, { id: n.value.id, version: 1 }, at);
    const tot = await salesTotals(db, monthPeriod('2026-11'));
    expect(tot).toEqual({
      orders: 2, itemsPaise: 69000 + 36000, deliveryPaise: 5000, discountPaise: 2000, netPaise: 72000 + 36000,
      units: 5, grams: 600, averageOrderPaise: 54000, collectedPaise: 50000, outstandingPaise: 22000 + 36000,
    });
  });

  test('kg sold uses the pack weight at confirm, not today\'s (review: money/stock 6)', async () => {
    const db = await freshDb();
    const at = '2026-11-10T06:00:00Z';
    await sale(db, at, [{ code: 'murungai-honey:250g', qty: 2 }]);
    // the owner later edits the pack's weight (e.g. the jar becomes 200 g); earlier sales keep 250 g each
    await db.prepare("UPDATE variants SET net_grams = 200 WHERE code = 'murungai-honey:250g'").run();
    await sale(db, at, [{ code: 'murungai-honey:250g', qty: 1 }]);
    expect((await salesTotals(db, monthPeriod('2026-11'))).grams).toBe(700);
    const by = await salesByProduct(db, monthPeriod('2026-11'));
    expect(by.products[0]).toMatchObject({ name: 'Murungai Honey', grams: 700 });
    expect(by.products[0].packs[0]).toMatchObject({ units: 3, grams: 700 });
  });

  test('by product with packs and category subtotals; custom lines are "Other items"', async () => {
    const db = await freshDb();
    const at = '2026-11-10T06:00:00Z';
    await sale(db, at, [{ code: 'murungai-honey:250g', qty: 2 }, { code: 'murungai-honey:100g', qty: 1 }]);
    await sale(db, at, [{ code: 'murungai-honey:250g', qty: 1 }, { code: 'beeswax-candles:small', qty: 4 }]);
    const r = await createManualOrder(db, OWNER, { channel: 'in_person', lines: [{ kind: 'custom', name: 'Comb piece', qty: 1, unitPricePaise: 10000 }] }, at);
    if (r.ok) await confirmOrder(db, OWNER, { id: r.value.id, version: 1 }, at);
    const by = await salesByProduct(db, monthPeriod('2026-11'));
    expect(by.totalPaise).toBe(93000 + 14000 + 32000 + 10000);
    expect(by.products.map((p) => [p.name, p.orders, p.units, p.paise, p.grams, p.sharePct])).toEqual([
      ['Murungai Honey', 2, 4, 107000, 850, 71.8],
      ['Beeswax Candles', 1, 4, 32000, 0, 21.5],
      ['Other items', 1, 1, 10000, 0, 6.7],
    ]);
    expect(by.products[0].packs.map((p) => [p.label, p.units, p.paise])).toEqual([['100 g', 1, 14000], ['250 g', 3, 93000]]);
    expect(by.categories.map((c) => [c.category, c.name, c.orders, c.paise])).toEqual([['comb-honey', 'Comb Honey', 2, 107000], ['from-the-hive', 'From the Hive', 1, 32000]]);
  });

  test('asked (website orders, any status but spam) vs confirmed; product history; pool usage', async () => {
    const db = await freshDb();
    const at = '2026-11-10T06:00:00Z';
    const key = (i: number) => i.toString(16).padStart(32, '0');
    const asked = await recordOrder(db, { v: 1, ref: 'BZ-7K3QD', key: key(1), src: 'cart', shown: null, lv: null, items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 3 }] }, { ip: null, ipHashKey: 'k', at });
    await recordOrder(db, { v: 1, ref: 'BZ-7K3QE', key: key(2), src: 'product', shown: null, lv: null, items: [{ c: 'kombu-honey:100g', s: 'kombu-honey', p: '100 g', q: 1 }] }, { ip: null, ipHashKey: 'k', at });
    await confirmOrder(db, OWNER, { id: asked.orderId!, version: 1 }, at);
    await sale(db, at, [{ code: 'murungai-honey:250g', qty: 1 }]); // a phone order: sold, not "asked" on the website
    const avc = await askedVsConfirmed(db, monthPeriod('2026-11'));
    expect(avc).toEqual([
      { productId: expect.any(Number), name: 'Murungai Honey', askedOrders: 1, askedUnits: 3, soldOrders: 2, soldUnits: 4 },
      { productId: expect.any(Number), name: 'Kombu Honey', askedOrders: 1, askedUnits: 1, soldOrders: 0, soldUnits: 0 },
    ]);
    const pid = (await row<{ id: number }>(db, "SELECT id FROM products WHERE slug = 'murungai-honey'")).id;
    const hist = await productHistory(db, pid, 24, '2026-11-15T00:00:00Z');
    expect(hist).toHaveLength(24);
    expect(hist[23]).toEqual({ month: '2026-11', units: 4, paise: 124000 });
    expect(hist[0]).toEqual({ month: '2024-12', units: 0, paise: 0 });
    expect(await poolUsage(db, (await pool(db, 'murungai-honey')).id, 30, '2026-11-15T00:00:00Z')).toBe(1000);
    const rep = await salesReport(db, monthPeriod('2026-11'));
    expect(rep.previousPeriod.key).toBe('2026-10');
    expect(rep.totals.orders).toBe(2);
    expect(rep.previous.orders).toBe(0);
  });
});
