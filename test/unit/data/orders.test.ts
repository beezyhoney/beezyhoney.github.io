import { describe, expect, test } from 'vitest';
import {
  addPayment, advanceOrder, assignInvoiceNo, cancelOrder, clearTestData, confirmOrder, createFromPasted, createManualOrder,
  duplicateOrder, getOrder, listOrders, markSpam, orderCounts, restoreOrder, saveCharges, saveCustomer, saveLines, searchOrders,
  setTestFlag, undoConfirm, useCustomerPrices,
} from '../../../src/server/orders';
import { countStock } from '../../../src/server/stock';
import type { D1 } from '../../../src/server/db';
import { freshDb, HELPER, OWNER, pool, row, rows, t, variantId } from '../../helpers/db';

async function newOrder(db: D1, lines: { code: string; qty: number; unitPricePaise?: number | null }[], extra: Record<string, unknown> = {}) {
  const r = await createManualOrder(db, OWNER, { channel: 'phone', lines: lines.map((l) => ({ kind: 'item' as const, ...l })), ...extra }, t(0));
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

const saleMoves = (db: D1, orderId: number) => rows<{ pool_id: number; delta: number; reason: string; idem_key: string }>(db,
  'SELECT pool_id, delta, reason, idem_key FROM stock_moves WHERE order_id = ? ORDER BY id', orderId);

describe('manual orders and lines', () => {
  test('prices come from D1 and totals add up', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 2 }, { code: 'honey-sticks:box-10', qty: 1 }], { deliveryPaise: 5000 });
    const d = (await getOrder(db, o.id))!;
    expect(d.order.status).toBe('new');
    expect(d.order.ref).toMatch(/^BZ-[346789ACDEFGHJKMNPQRTUVWXY]{5}$/);
    expect(d.lines.map((l) => [l.name, l.pack, l.qty, l.unitPricePaise, l.lineTotalPaise])).toEqual([
      ['Murungai Honey with comb', '250 g', 2, 31000, 62000],
      ['Honey Sticks', 'Box of 10 (100 g)', 1, 7000, 7000],
    ]);
    expect(d.order.itemsTotalPaise).toBe(69000);
    expect(d.order.totalPaise).toBe(74000);
    expect(d.actions).toContain('confirm');
  });

  test('a double submit with the same form key makes one order', async () => {
    const db = await freshDb();
    const input = { channel: 'whatsapp' as const, lines: [{ code: 'murungai-honey:100g', qty: 1 }], idemKey: 'form-1' };
    const a = await createManualOrder(db, OWNER, input, t(0));
    const b = await createManualOrder(db, OWNER, input, t(1));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.duplicate).toBe(true);
    expect(b.value.id).toBe(a.value.id);
    expect((await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM orders')).n).toBe(1);
  });

  test('the same form key still makes one order after that order was confirmed or edited (no second sale)', async () => {
    const db = await freshDb();
    const input = { channel: 'phone' as const, lines: [{ code: 'murungai-honey:250g', qty: 2 }], status: 'confirmed' as const, idemKey: 'form-confirm-1' };
    const a = await createManualOrder(db, OWNER, input, t(0));
    expect(a.ok && a.value.confirm?.confirmNo).toBe(1);
    const b = await createManualOrder(db, OWNER, input, t(1)); // the second tap arrives after the first one finished
    expect(b).toMatchObject({ ok: true, value: { duplicate: true } });
    if (!a.ok || !b.ok) return;
    expect(b.value.id).toBe(a.value.id);
    expect(b.value.confirm).toBeUndefined();
    expect((await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM orders')).n).toBe(1);
    expect(await saleMoves(db, a.value.id)).toHaveLength(1);
    // a different key is a different order; a too-short key is refused
    const c = await createManualOrder(db, OWNER, { ...input, status: 'new', idemKey: 'form-other' }, t(2));
    expect(c.ok && c.value.duplicate).toBe(false);
    expect(await createManualOrder(db, OWNER, { ...input, idemKey: 'x' }, t(3))).toMatchObject({ ok: false, error: 'invalid' });
    // website orders cannot carry a form key
    await expect(db.prepare("UPDATE orders SET source = 'cart', client_key = '0123456789abcdef0123456789abcdef' WHERE id = ?").bind(c.ok ? c.value.id : 0).run()).rejects.toThrow(/CHECK/);
  });

  test('repeated packs are merged, custom lines allowed, bad input is refused', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 1 }, { code: 'murungai-honey:250g', qty: 2 }]);
    const d = (await getOrder(db, o.id))!;
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].qty).toBe(3);
    // review money/stock 4: a repeated pack at a different price is refused, never merged with the price dropped
    const twoPrices = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'murungai-honey:250g', qty: 1 }, { code: 'kombu-honey:100g', qty: 1 }, { code: 'murungai-honey:250g', qty: 2, unitPricePaise: 20000 }] });
    expect(twoPrices).toMatchObject({ ok: false, error: 'invalid', field: 'line-3', message: expect.stringContaining('already on line 1 at a different price') });
    expect(await saveLines(db, OWNER, { id: o.id, version: d.order.version, lines: [{ code: 'murungai-honey:250g', qty: 1, unitPricePaise: 30000 }, { code: 'murungai-honey:250g', qty: 1, unitPricePaise: 25000 }] }))
      .toMatchObject({ ok: false, field: 'line-2' });
    const samePrice = await saveLines(db, OWNER, { id: o.id, version: d.order.version, lines: [{ code: 'murungai-honey:250g', qty: 1, unitPricePaise: 25000, priceNote: 'Old customer' }, { code: 'murungai-honey:250g', qty: 1, unitPricePaise: 25000 }] });
    expect(samePrice).toMatchObject({ ok: true, value: { itemsTotalPaise: 50000 } });
    const bad = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'nope:1', qty: 1 }] });
    expect(bad).toMatchObject({ ok: false, error: 'invalid', field: 'line-1' });
    const zero = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'murungai-honey:250g', qty: 0 }] });
    expect(zero).toMatchObject({ ok: false, error: 'invalid' });
    const ch = await createManualOrder(db, OWNER, { channel: 'website' as never, lines: [{ code: 'murungai-honey:250g', qty: 1 }] });
    expect(ch).toMatchObject({ ok: false, field: 'channel' });
  });

  test('save lines while New; a stale version is a conflict', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 1 }]);
    const r = await saveLines(db, OWNER, { id: o.id, version: 1, lines: [
      { code: 'murungai-honey:250g', qty: 2, unitPricePaise: 30000, priceNote: 'Regular customer' },
      { kind: 'custom', name: 'Old stock jar', pack: '1 kg', qty: 1, unitPricePaise: null },
    ] }, t(1));
    expect(r).toEqual({ ok: true, value: { version: 2, itemsTotalPaise: 60000 } });
    const stale = await saveLines(db, OWNER, { id: o.id, version: 1, lines: [{ code: 'murungai-honey:100g', qty: 1 }] }, t(2));
    expect(stale).toMatchObject({ ok: false, error: 'conflict' });
    const d = (await getOrder(db, o.id))!;
    expect(d.lines.map((l) => [l.kind, l.qty, l.unitPricePaise, l.listPricePaise, l.priceNote])).toEqual([
      ['item', 2, 30000, 31000, 'Regular customer'],
      ['custom', 1, null, null, null],
    ]);
    expect(d.order.version).toBe(2);
  });
});

describe('confirm, undo, cancel (pools, A3)', () => {
  test('confirm writes one sale move per pool = −SUM(qty × pool_qty); confirming twice changes nothing', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [
      { code: 'murungai-honey:250g', qty: 2 },
      { code: 'murungai-honey:100g', qty: 3 },
      { code: 'honey-sticks:box-10', qty: 2 },
      { code: 'honey-sticks:1-stick', qty: 5 },
    ]);
    const first = await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(5));
    expect(first.ok).toBe(true);
    const second = await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(6));
    expect(second).toMatchObject({ ok: false, error: 'conflict', message: 'This order is already confirmed.' });
    const third = await confirmOrder(db, OWNER, { id: o.id, version: 2 }, t(6));
    expect(third).toMatchObject({ ok: false, error: 'conflict' });
    const mur = await pool(db, 'murungai-honey');
    const sticks = await pool(db, 'honey-sticks');
    expect(await saleMoves(db, o.id)).toEqual([
      { pool_id: mur.id, delta: -800, reason: 'sale', idem_key: `sale:${o.id}:1:${mur.id}` },
      { pool_id: sticks.id, delta: -25, reason: 'sale', idem_key: `sale:${o.id}:1:${sticks.id}` },
    ].sort((a, b) => a.pool_id - b.pool_id));
    expect(mur.on_hand).toBe(-800); // moves are written for untracked pools too; tracking stays off
    expect(mur.track_stock).toBe(0);
    expect(sticks.on_hand).toBe(-25);
    const d = (await getOrder(db, o.id))!;
    expect(d.order).toMatchObject({ status: 'confirmed', confirmNo: 1, confirmedAt: t(5), version: 2 });
  });

  test('an untracked pool never warns; a tracked pool may go negative (never blocks)', async () => {
    const db = await freshDb();
    const mur = await pool(db, 'murungai-honey');
    expect((await countStock(db, OWNER, { counts: [{ poolId: mur.id, amount: 300 }] }, t(0))).ok).toBe(true);
    const o = await newOrder(db, [{ code: 'murungai-honey:500g', qty: 1 }]);
    const r = await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(5));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.negative).toEqual([{ poolId: mur.id, name: 'Murungai Honey', onHand: -200, amountText: '−0.2 kg' }]);
    expect(r.value.effects).toEqual({ publish: 'scheduled', live: true }); // 300 g left = 100 g and 250 g in; after: all out
    expect((await pool(db, 'murungai-honey')).on_hand).toBe(-200);
  });

  test('undo confirm reverses once; re-confirm uses new keys', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 2 }]);
    const mur = await pool(db, 'murungai-honey');
    expect((await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(1))).ok).toBe(true);
    const u = await undoConfirm(db, OWNER, { id: o.id, version: 2 }, t(2));
    expect(u.ok).toBe(true);
    expect(await undoConfirm(db, OWNER, { id: o.id, version: 2 }, t(3))).toMatchObject({ ok: false, error: 'conflict' });
    expect((await pool(db, 'murungai-honey')).on_hand).toBe(0);
    let d = (await getOrder(db, o.id))!;
    expect(d.order).toMatchObject({ status: 'new', confirmedAt: null, version: 3 });
    // lines can be edited again while New
    expect((await saveLines(db, OWNER, { id: o.id, version: 3, lines: [{ code: 'murungai-honey:250g', qty: 1 }] }, t(4))).ok).toBe(true);
    expect((await confirmOrder(db, OWNER, { id: o.id, version: 4 }, t(5))).ok).toBe(true);
    const moves = await rows<{ delta: number; reason: string; idem_key: string }>(db, 'SELECT delta, reason, idem_key FROM stock_moves WHERE order_id = ? ORDER BY id', o.id);
    expect(moves.map((m) => [m.reason, m.delta])).toEqual([['sale', -500], ['sale_reversal', 500], ['sale', -250]]);
    expect(moves[0].idem_key).toBe(`sale:${o.id}:1:${mur.id}`);
    expect(moves[1].idem_key).toMatch(/^rev:\d+$/);
    expect(moves[2].idem_key).toBe(`sale:${o.id}:2:${mur.id}`);
    d = (await getOrder(db, o.id))!;
    expect(d.order.confirmNo).toBe(2);
    expect((await pool(db, 'murungai-honey')).on_hand).toBe(-250);
  });

  test('cancel from Confirmed restocks once; cancelling twice does nothing more', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'kombu-honey:100g', qty: 4 }]);
    await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(1));
    const c1 = await cancelOrder(db, OWNER, { id: o.id, version: 2, reason: 'Customer changed mind' }, t(2));
    expect(c1).toMatchObject({ ok: true, value: { version: 3, restocked: true } });
    const c2 = await cancelOrder(db, OWNER, { id: o.id, version: 2 }, t(3));
    expect(c2).toMatchObject({ ok: false, error: 'conflict' });
    const c3 = await cancelOrder(db, OWNER, { id: o.id, version: 3 }, t(3));
    expect(c3).toMatchObject({ ok: false, error: 'conflict', message: 'This order is already cancelled.' });
    const moves = await saleMoves(db, o.id);
    expect(moves.map((m) => m.reason)).toEqual(['sale', 'sale_reversal']);
    expect((await pool(db, 'kombu-honey')).on_hand).toBe(0);
  });

  test('cancel from New has no stock effect; from Sent it asks whether the jars came back', async () => {
    const db = await freshDb();
    const a = await newOrder(db, [{ code: 'kombu-honey:100g', qty: 1 }]);
    expect(await cancelOrder(db, OWNER, { id: a.id, version: 1 }, t(1))).toMatchObject({ ok: true, value: { restocked: false } });
    expect(await saleMoves(db, a.id)).toEqual([]);

    const b = await newOrder(db, [{ code: 'kombu-honey:250g', qty: 1 }]);
    await confirmOrder(db, OWNER, { id: b.id, version: 1 }, t(1));
    expect((await advanceOrder(db, OWNER, { id: b.id, version: 2, to: 'shipped', note: 'DTDC 12345' }, t(2))).ok).toBe(true);
    expect(await cancelOrder(db, OWNER, { id: b.id, version: 3 }, t(3))).toMatchObject({ ok: false, error: 'needs_restock_answer' });
    expect(await cancelOrder(db, OWNER, { id: b.id, version: 3, restock: false }, t(3))).toMatchObject({ ok: true, value: { restocked: false } });
    expect((await saleMoves(db, b.id)).map((m) => m.reason)).toEqual(['sale']);
    expect((await pool(db, 'kombu-honey')).on_hand).toBe(-250);
    expect((await getOrder(db, b.id))!.order.note).toBe('Sent: DTDC 12345');
  });

  test('lines are locked after confirm', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 1 }]);
    await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(1));
    const r = await saveLines(db, OWNER, { id: o.id, version: 2, lines: [{ code: 'murungai-honey:250g', qty: 5 }] }, t(2));
    expect(r).toMatchObject({ ok: false, error: 'conflict', message: 'This order is already confirmed.' });
    expect((await getOrder(db, o.id))!.lines[0].qty).toBe(1);
    // delivery charge may still be added after confirming
    expect(await saveCharges(db, OWNER, { id: o.id, version: 2, deliveryPaise: 6000, discountPaise: 1000 }, t(3))).toEqual({ ok: true, value: { version: 3, totalPaise: 36000 } });
  });

  test('a pack without a price blocks confirm with needs_price', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'litchi-honey:250g', qty: 1 }, { code: 'murungai-honey:100g', qty: 1 }]);
    const r = await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(1));
    expect(r).toMatchObject({ ok: false, error: 'needs_price', details: ['Litchi Honey 250 g'] });
    expect(r.ok ? '' : r.message).toBe('Add a price for Litchi Honey 250 g first.');
    expect((await saveLines(db, OWNER, { id: o.id, version: 1, lines: [{ code: 'litchi-honey:250g', qty: 1, unitPricePaise: 42000 }, { code: 'murungai-honey:100g', qty: 1 }] }, t(2))).ok).toBe(true);
    expect((await confirmOrder(db, OWNER, { id: o.id, version: 2 }, t(3))).ok).toBe(true);
  });

  test('status steps follow the allow-list and can be skipped', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 1 }]);
    expect(await advanceOrder(db, OWNER, { id: o.id, version: 1, to: 'packed' }, t(1))).toMatchObject({ ok: false, error: 'conflict' });
    await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(1));
    expect(await advanceOrder(db, OWNER, { id: o.id, version: 2, to: 'delivered' }, t(2))).toEqual({ ok: true, value: { version: 3 } });
    expect(await advanceOrder(db, OWNER, { id: o.id, version: 3, to: 'packed' }, t(3))).toMatchObject({ ok: false, error: 'conflict', message: 'This order is already delivered.' });
    expect(await undoConfirm(db, OWNER, { id: o.id, version: 3 }, t(3))).toMatchObject({ ok: false, error: 'conflict' });
  });
});

describe('payments', () => {
  test('part payments, refunds and the paid cache', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'dammar-honey:250g', qty: 1 }]); // ₹900
    await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(1));
    expect(await addPayment(db, OWNER, { id: o.id, amountPaise: 40000, method: 'upi', reference: 'UPI 1234', idemKey: 'p1' }, t(2)))
      .toEqual({ ok: true, value: { paidPaise: 40000, balancePaise: 50000, duplicate: false } });
    expect(await addPayment(db, OWNER, { id: o.id, amountPaise: 40000, method: 'upi', idemKey: 'p1' }, t(3)))
      .toEqual({ ok: true, value: { paidPaise: 40000, balancePaise: 50000, duplicate: true } });
    expect(await addPayment(db, OWNER, { id: o.id, amountPaise: 50000, method: 'cash' }, t(4)))
      .toMatchObject({ ok: true, value: { paidPaise: 90000, balancePaise: 0 } });
    expect(await addPayment(db, OWNER, { id: o.id, amountPaise: -100000, method: 'upi' }, t(5)))
      .toMatchObject({ ok: false, error: 'invalid', field: 'amountPaise' });
    expect(await addPayment(db, OWNER, { id: o.id, amountPaise: -10000, method: 'upi', reference: 'refund' }, t(6)))
      .toMatchObject({ ok: true, value: { paidPaise: 80000, balancePaise: 10000 } });
    const d = (await getOrder(db, o.id))!;
    expect(d.payments.map((p) => p.amountPaise)).toEqual([40000, 50000, -10000]);
    expect(d.order.paidPaise).toBe(80000);
    expect((await row<{ s: number }>(db, 'SELECT SUM(amount_paise) AS s FROM payments WHERE order_id = ?', o.id)).s).toBe(80000);
    expect(await addPayment(db, OWNER, { id: o.id, amountPaise: 0, method: 'upi' }, t(7))).toMatchObject({ ok: false, error: 'invalid' });
  });

  test('"Confirmed & paid" records the total in the same batch', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 2 }], { deliveryPaise: 5000 });
    const r = await confirmOrder(db, OWNER, { id: o.id, version: 1, paid: { method: 'cash' } }, t(1));
    expect(r).toMatchObject({ ok: true, value: { paidPaise: 67000 } });
    const counts = await orderCounts(db, t(2));
    expect(counts).toMatchObject({ unpaidCount: 0, toSend: 1, newCount: 0 });
  });

  test('manual order saved as Confirmed & paid in one go', async () => {
    const db = await freshDb();
    const r = await createManualOrder(db, OWNER, { channel: 'in_person', lines: [{ code: 'beeswax-candles:small', qty: 3 }], status: 'confirmed', paid: { method: 'upi' } }, t(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.confirm).toMatchObject({ paidPaise: 24000, confirmNo: 1 });
    expect((await pool(db, 'beeswax-candles:small')).on_hand).toBe(-3);
  });
});

describe('other order actions', () => {
  test('customer prices become a discount; customer fields; spam and restore', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 2 }]);
    await db.prepare('UPDATE orders SET shown_total_paise = 60000, price_mismatch = 1 WHERE id = ?').bind(o.id).run();
    expect((await getOrder(db, o.id))!.actions).toContain('use_customer_prices');
    expect(await useCustomerPrices(db, OWNER, { id: o.id, version: 1 }, t(1))).toEqual({ ok: true, value: { version: 2, discountPaise: 2000 } });
    const d1 = (await getOrder(db, o.id))!;
    expect(d1.order).toMatchObject({ totalPaise: 60000, discountPaise: 2000, priceMismatch: false });
    expect(await saveCustomer(db, OWNER, { id: o.id, version: 2, name: 'Test Customer', phone: '+91 90000 00000', city: 'Madurai' }, t(2))).toEqual({ ok: true, value: { version: 3 } });
    expect(await saveCustomer(db, OWNER, { id: o.id, version: 3, phone: 'call me' }, t(2))).toMatchObject({ ok: false, field: 'phone' });
    expect(await markSpam(db, HELPER, { id: o.id, version: 3 }, t(3))).toEqual({ ok: true, value: { version: 4 } });
    expect(await confirmOrder(db, OWNER, { id: o.id, version: 4 }, t(4))).toMatchObject({ ok: false, error: 'conflict' });
    expect(await restoreOrder(db, OWNER, { id: o.id, version: 4 }, t(5))).toEqual({ ok: true, value: { version: 5 } });
    const audit = await rows<{ summary: string }>(db, "SELECT summary FROM audit_log WHERE entity = 'order' AND entity_id = ? ORDER BY id", String(o.id));
    expect(audit.map((a) => a.summary)).toEqual([
      `New phone order ${o.ref}`, "Matched the customer's total ₹600 (discount ₹20)", 'Customer details or note changed',
      'Marked as not a real order', 'Restored as a real order',
    ]);
    // personal details never go into the audit log
    expect(JSON.stringify(await rows(db, 'SELECT * FROM audit_log'))).not.toContain('Madurai');
  });

  test('search by full or partial code, name and phone', async () => {
    const db = await freshDb();
    const a = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 1 }], { ref: 'BZ-7K3QD', customer: { name: 'Kavitha', phone: '98400 12345' } });
    const b = await newOrder(db, [{ code: 'murungai-honey:100g', qty: 1 }], { ref: 'bz 4x3qd' });
    expect((await searchOrders(db, 'BZ-7K3QD')).map((r) => r.id)).toEqual([a.id]);
    expect((await searchOrders(db, '7k3qd')).map((r) => r.id)).toEqual([a.id]);
    expect((await searchOrders(db, '3QD')).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect((await searchOrders(db, 'kavi')).map((r) => r.id)).toEqual([a.id]);
    expect((await searchOrders(db, '12345')).map((r) => r.id)).toEqual([a.id]);
    expect(await searchOrders(db, 'QD')).toEqual([]);
    expect((await searchOrders(db, 'KAVITHA')).map((r) => r.id)).toEqual([a.id]);
    // long input never builds a LIKE pattern (D1 refuses patterns over 50 bytes); % and _ are plain characters
    expect(await searchOrders(db, `Kavitha ${'x'.repeat(70)}`)).toEqual([]);
    expect(await searchOrders(db, '9840012345 9840012345 9840012345 9840012345 9840012345 9840012345')).toEqual([]);
    expect(await searchOrders(db, 'ka%a')).toEqual([]);
    const hit = (await searchOrders(db, '7K3QD'))[0];
    expect(hit.items).toBe('Murungai Honey with comb 250 g × 1');
  });

  test('list tabs and counts', async () => {
    const db = await freshDb();
    const a = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 1 }]);
    const b = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 1 }]);
    await confirmOrder(db, OWNER, { id: b.id, version: 1 }, t(1));
    expect((await listOrders(db, { tab: 'new' })).rows.map((r) => r.id)).toEqual([a.id]);
    expect((await listOrders(db, { tab: 'unpaid' })).rows.map((r) => r.id)).toEqual([b.id]);
    expect((await listOrders(db, { tab: 'all' })).rows).toHaveLength(2);
    const page = await listOrders(db, { tab: 'all', limit: 1 });
    expect(page.next).not.toBeNull();
    const page2 = await listOrders(db, { tab: 'all', limit: 1, before: page.next! });
    expect(page2.rows.map((r) => r.id)).not.toContain(page.rows[0].id);
    const c = await orderCounts(db, t(60 * 25));
    expect(c).toMatchObject({ newCount: 1, newWaitingLong: 1, toSend: 1, unpaidCount: 1, unpaidPaise: 31000 });
  });

  test('duplicate, invoice numbers (gapless per financial year), test orders and Clear test data', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 1 }]);
    expect(await assignInvoiceNo(db, OWNER, { id: o.id }, t(1))).toMatchObject({ ok: false, error: 'not_allowed' });
    await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(1));
    expect(await assignInvoiceNo(db, OWNER, { id: o.id }, t(2))).toEqual({ ok: true, value: { invoiceNo: 'BZ/2026-27/0001', already: false } });
    expect(await assignInvoiceNo(db, OWNER, { id: o.id }, t(3))).toEqual({ ok: true, value: { invoiceNo: 'BZ/2026-27/0001', already: true } });
    const dup = await duplicateOrder(db, OWNER, { id: o.id }, t(4));
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    await confirmOrder(db, OWNER, { id: dup.value.id, version: 1 }, t(5));
    expect(await assignInvoiceNo(db, OWNER, { id: dup.value.id }, '2027-04-01T03:00:00Z')).toMatchObject({ ok: true, value: { invoiceNo: 'BZ/2027-28/0001' } });

    const test1 = await newOrder(db, [{ code: 'kombu-honey:100g', qty: 2 }], { isTest: true });
    await confirmOrder(db, OWNER, { id: test1.id, version: 1 }, t(6));
    expect(await assignInvoiceNo(db, OWNER, { id: test1.id }, t(7))).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await setTestFlag(db, OWNER, { id: o.id, version: 2, isTest: true }, t(7))).toMatchObject({ ok: false, error: 'not_allowed' });
    expect((await pool(db, 'kombu-honey')).on_hand).toBe(-200);
    expect(await clearTestData(db, HELPER, t(8))).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await clearTestData(db, OWNER, t(8))).toMatchObject({ ok: true, value: { orders: 1 } });
    expect((await pool(db, 'kombu-honey')).on_hand).toBe(0);
    expect(await getOrder(db, test1.id)).toBeNull();
    await db.prepare(`UPDATE settings SET value = '"2026-12-01T00:00:00Z"' WHERE key = 'go_live_at'`).run();
    expect(await clearTestData(db, OWNER, t(9))).toMatchObject({ ok: false, error: 'not_allowed' });
  });

  test('an invoice number freezes the order: no undo confirm, no charge or line edits, no spam; cancel still works (review: money/stock 3)', async () => {
    const db = await freshDb();
    const o = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 2 }]);
    await confirmOrder(db, OWNER, { id: o.id, version: 1 }, t(1));
    expect(await assignInvoiceNo(db, OWNER, { id: o.id }, t(2))).toMatchObject({ ok: true, value: { invoiceNo: 'BZ/2026-27/0001' } });
    const v = (await getOrder(db, o.id))!.order.version;
    const before = await row(db, 'SELECT status, items_total_paise, delivery_paise, discount_paise, total_paise, version FROM orders WHERE id = ?', o.id);
    const frozen = { ok: false, error: 'not_allowed', message: expect.stringContaining('Invoice BZ/2026-27/0001') };
    expect(await saveCharges(db, OWNER, { id: o.id, version: v, deliveryPaise: 5000, discountPaise: 1000 }, t(3))).toMatchObject(frozen);
    expect(await undoConfirm(db, OWNER, { id: o.id, version: v }, t(3))).toMatchObject(frozen);
    expect(await row(db, 'SELECT status, items_total_paise, delivery_paise, discount_paise, total_paise, version FROM orders WHERE id = ?', o.id)).toEqual(before);
    expect((await saleMoves(db, o.id)).map((m) => m.reason)).toEqual(['sale']);
    // even if an invoiced order were New again (old data), its lines, prices and spam mark stay refused
    const confirmedAt = (await row<{ c: string }>(db, 'SELECT confirmed_at AS c FROM orders WHERE id = ?', o.id)).c;
    await db.prepare("UPDATE orders SET status = 'new', confirmed_at = NULL WHERE id = ?").bind(o.id).run();
    expect(await saveLines(db, OWNER, { id: o.id, version: v, lines: [{ code: 'murungai-honey:250g', qty: 9 }] }, t(4))).toMatchObject(frozen);
    expect(await markSpam(db, OWNER, { id: o.id, version: v }, t(4))).toMatchObject(frozen);
    await db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = ? WHERE id = ?").bind(confirmedAt, o.id).run();
    const d = (await getOrder(db, o.id))!;
    expect(d.actions.filter((a) => ['save_lines', 'save_charges', 'undo_confirm', 'mark_spam', 'use_customer_prices'].includes(a))).toEqual([]);
    expect(d.actions).toEqual(expect.arrayContaining(['cancel', 'pay', 'pack']));
    expect(await cancelOrder(db, OWNER, { id: o.id, version: v }, t(5))).toMatchObject({ ok: true, value: { restocked: true } });
  });

  test('Clear test data keeps a later stock count: only test sales after the last count give stock back', async () => {
    const db = await freshDb();
    const mur = (await pool(db, 'murungai-honey')).id;
    expect((await countStock(db, OWNER, { counts: [{ poolId: mur, amount: 1000 }] }, t(0))).ok).toBe(true);
    const a = await newOrder(db, [{ code: 'murungai-honey:250g', qty: 1 }], { isTest: true });
    await confirmOrder(db, OWNER, { id: a.id, version: 1 }, t(1));
    expect((await pool(db, 'murungai-honey')).on_hand).toBe(750);
    // the owner counts the real jars: nothing left the farm, so 1 kg again
    expect((await countStock(db, OWNER, { counts: [{ poolId: mur, amount: 1000 }] }, t(2))).ok).toBe(true);
    const b = await newOrder(db, [{ code: 'murungai-honey:100g', qty: 1 }], { isTest: true });
    await confirmOrder(db, OWNER, { id: b.id, version: 1 }, t(3));
    expect((await pool(db, 'murungai-honey')).on_hand).toBe(900);
    const r = await clearTestData(db, OWNER, t(4));
    expect(r).toMatchObject({ ok: true, value: { orders: 2, effects: { publish: 'scheduled', live: true } } });
    const p = await pool(db, 'murungai-honey');
    expect(p.on_hand).toBe(1000); // not 1250: the 250 g before the second count was already counted
    expect((await row<{ s: number }>(db, 'SELECT SUM(delta) AS s FROM stock_moves WHERE pool_id = ?', mur)).s).toBe(1000);
    expect((await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM stock_moves WHERE order_id IS NOT NULL')).n).toBe(0);
    expect((await row<{ summary: string }>(db, "SELECT summary FROM audit_log WHERE action = 'orders.clear_test'")).summary).toBe('Cleared 2 test order(s)');
  });

  test('paste a WhatsApp message: catalog matches, unknown lines, shown total, duplicate code', async () => {
    const db = await freshDb();
    const parsed = {
      kind: 'order' as const, ref: 'BZ-7K3QD', totalPaise: 69000,
      lines: [
        { name: 'Murungai Honey with comb', pack: '250 g', qty: 2, unitPaise: 31000, linePaise: 62000 },
        { name: 'Honey Sticks', pack: 'Box of 10 (100 g)', qty: 1, unitPaise: 7000, linePaise: 7000 },
        { name: 'Mystery Honey', pack: '1 kg', qty: 1, unitPaise: null, linePaise: null },
      ],
    };
    const r = await createFromPasted(db, OWNER, parsed, {}, t(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unmatched).toEqual(['Mystery Honey 1 kg']);
    const d = (await getOrder(db, r.value.id))!;
    expect(d.order).toMatchObject({ ref: 'BZ-7K3QD', source: 'pasted', channel: 'whatsapp', shownTotalPaise: 69000, itemsTotalPaise: 69000, priceMismatch: false });
    expect(d.lines.map((l) => l.kind)).toEqual(['item', 'item', 'custom']);
    const again = await createFromPasted(db, OWNER, parsed, {}, t(1));
    expect(again).toMatchObject({ ok: false, error: 'conflict' });
    expect(again.ok ? null : again.details).toEqual([{ id: r.value.id, status: 'new', createdAt: t(0) }]);
    expect((await createFromPasted(db, OWNER, parsed, { force: true }, t(2))).ok).toBe(true);
    // review money/stock 5: a "Total so far" (some packs had no price) is not what the customer saw
    const soFar = await createFromPasted(db, OWNER, { ...parsed, ref: 'BZ-8M4RE', totalPaise: 62000, totalSoFar: true }, {}, t(3));
    if (!soFar.ok) throw new Error(soFar.message);
    expect((await getOrder(db, soFar.value.id))!.order).toMatchObject({ shownTotalPaise: null, priceMismatch: false });
  });
});

describe('variant ids', () => {
  test('lines can name packs by id too', async () => {
    const db = await freshDb();
    const id = await variantId(db, 'neela-kurinji-honey:500g');
    const r = await createManualOrder(db, OWNER, { channel: 'other', lines: [{ variantId: id, qty: 1 }] }, t(0));
    expect(r.ok).toBe(true);
    if (r.ok) expect((await getOrder(db, r.value.id))!.order.itemsTotalPaise).toBe(110000);
  });
});
