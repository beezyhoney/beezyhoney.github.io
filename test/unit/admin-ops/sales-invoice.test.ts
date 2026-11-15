// src/server/sales.ts (periods, CSV) and src/server/invoice.ts on the D1 shim with the real seed.
import { describe, expect, it } from 'vitest';
import { freshDb, OWNER, t, variantId } from '../../helpers/db';
import { confirmOrder, createManualOrder, saveCustomer, setTestFlag } from '../../../src/server/orders';
import { csvCell, csvLine, exportCsv, exportRange, kgText, lastDayOfMonth, monthToDate, periodNav, periodQuery, rupees } from '../../../src/server/sales';
import { monthPeriod, financialYearPeriod, customPeriod, calendarYearPeriod } from '../../../src/server/sales-queries';
import { getInvoice, invoiceFy, invoiceTitle, lastInvoiceNumber, listInvoices, makeInvoice, ordersWithoutInvoice } from '../../../src/server/invoice';
import { updateSettings } from '../../../src/server/settings';

async function soldOrder(db: Awaited<ReturnType<typeof freshDb>>, at = t(0), qty = 2) {
  const v = await variantId(db, 'murungai-honey:250g');
  const r = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ variantId: v, qty }], deliveryPaise: 5000, customer: { name: 'Kavya', phone: '98765 43210', city: 'Madurai' } }, at);
  if (!r.ok) throw new Error(r.message);
  const c = await confirmOrder(db, OWNER, { id: r.value.id, version: 1 }, at);
  if (!c.ok) throw new Error(c.message);
  return r.value;
}

describe('periods', () => {
  it('month so far compares with the same days of last month, clamped', () => {
    const m = monthToDate('2026-11-15T04:30:00Z');
    expect([m.current.firstDay, m.current.endDay, m.previous.firstDay, m.previous.endDay]).toEqual(['2026-11-01', '2026-11-16', '2026-10-01', '2026-10-16']);
    const mar = monthToDate('2027-03-31T10:00:00Z');
    expect(mar.previous.firstDay).toBe('2027-02-01');
    expect(mar.previous.endDay).toBe('2027-03-01'); // 1–28 Feb
    // 23:59 IST on 31 Mar is still March; 00:00 IST on 1 Apr is April
    expect(monthToDate('2027-03-31T18:29:00Z').current.firstDay).toBe('2027-03-01');
    expect(monthToDate('2027-03-31T18:30:00Z').current.firstDay).toBe('2027-04-01');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });

  it('prev / next and the query string of each kind', () => {
    const at = '2026-11-15T04:30:00Z';
    expect(periodNav(monthPeriod('2026-11'), at)).toMatchObject({ prev: { key: '2026-10' }, next: null });
    expect(periodNav(monthPeriod('2026-10'), at).next?.key).toBe('2026-11');
    expect(periodNav(financialYearPeriod(2025), at).next?.key).toBe('2026-27');
    expect(periodNav(calendarYearPeriod(2026), at)).toMatchObject({ prev: { key: '2025' }, next: null });
    expect(periodNav(customPeriod('2026-11-01', '2026-11-07'), at).prev.key).toBe('2026-10-25..2026-10-31');
    expect(periodQuery(financialYearPeriod(2026))).toBe('period=fy&fy=2026');
    expect(periodQuery(customPeriod('2026-11-01', '2026-11-07'))).toBe('period=custom&from=2026-11-01&to=2026-11-07');
  });
});

describe('CSV helpers', () => {
  it('quotes, neutralises formulas, keeps negative amounts as numbers', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+91 98765')).toBe("'+91 98765");
    expect(csvCell('-50.50')).toBe('-50.50');
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell(12)).toBe('12');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('yes');
    expect(csvLine(['a', 1])).toBe('a,1\r\n');
    expect(rupees(31000)).toBe('310.00');
    expect(rupees(-5050)).toBe('-50.50');
    expect(rupees(null)).toBe('');
    expect(kgText(99500)).toBe('99.500');
    expect(kgText(-750)).toBe('-0.750');
    expect(exportRange({ from: '2026-04-01', to: '2026-04-30' })).toEqual({ from: '2026-03-31T18:30:00Z', to: '2026-04-30T18:30:00Z', label: '2026-04-01_to_2026-04-30' });
    expect(exportRange({ from: 'junk' }).label).toBe('all');
  });
});

describe('exportCsv', () => {
  it('orders: no customer details unless asked; money in rupees; IST times', async () => {
    const db = await freshDb();
    const o = await soldOrder(db);
    const plain = await exportCsv(db, 'orders', {}, t(0));
    expect(plain.csv.startsWith('﻿order_id,order_code')).toBe(true);
    expect(plain.csv).toContain(`${o.ref},2026-11-15 10:00,Confirmed,manual,phone,no,2026-11-15 10:00,620.00,0.00,50.00,670.00,0.00,670.00`);
    expect(plain.csv).not.toContain('Kavya');
    expect(plain.csv).not.toContain('98765');
    const personal = await exportCsv(db, 'orders', { personal: true }, t(0));
    expect(personal.csv).toContain('customer_name');
    expect(personal.csv).toContain('Kavya');
    expect(personal.csv).toContain('98765 43210');
    expect(personal.filename).toBe('beezy-orders-all-2026-11-15.csv');
  });

  it('order lines, monthly by product (sales only, not tests) and stock moves', async () => {
    const db = await freshDb();
    const o = await soldOrder(db);
    const test = await soldOrder(db, t(5), 1);
    const st = await setTestFlag(db, OWNER, { id: test.id, version: 2, isTest: true }, t(6));
    expect(st.ok).toBe(true);
    const lines = await exportCsv(db, 'order_lines', {}, t(10));
    expect(lines.csv).toContain(`${o.ref},Confirmed,2026-11-15 10:00,2026-11-15 10:00,no,item,Murungai Honey with comb,250 g,murungai-honey:250g,2,310.00,620.00,310.00,,0.500`);
    const monthly = await exportCsv(db, 'monthly_by_product', { from: '2026-11-01', to: '2026-11-30' }, t(10));
    expect(monthly.csv).toContain('2026-11,Comb Honey,Murungai Honey,250 g,murungai-honey:250g,1,2,620.00,0.500');
    expect(monthly.rows).toBe(1);
    const moves = await exportCsv(db, 'stock_moves', {}, t(10));
    expect(moves.csv).toMatch(/Murungai Honey,.*,grams,-500,-0\.500,sale,BZ-/);
    const none = await exportCsv(db, 'orders', { from: '2026-12-01', to: '2026-12-31' }, t(10));
    expect(none.rows).toBe(0);
  });
});

describe('invoices', () => {
  it('title follows the GSTIN', () => {
    expect(invoiceTitle(null)).toBe('Bill of supply');
    expect(invoiceTitle(' ')).toBe('Bill of supply');
    expect(invoiceTitle('33ABCDE1234F1Z5')).toBe('Tax invoice');
    expect(invoiceFy('BZ/2026-27/0001')).toBe('2026-27');
    expect(invoiceFy('x')).toBeNull();
  });

  it('viewing uses no number; making it is gapless per financial year and repeatable', async () => {
    const db = await freshDb();
    const a = await soldOrder(db);
    const b = await soldOrder(db, t(1));
    const view = await getInvoice(db, a.id, t(2));
    expect(view).toMatchObject({ invoiceNo: null, canInvoice: true, title: 'Bill of supply', totalPaise: 67000, amountWords: 'Rupees Six Hundred Seventy Only', fy: '2026-27' });
    expect(await lastInvoiceNumber(db, '2026-27')).toBe(0);
    expect((await ordersWithoutInvoice(db)).map((x) => x.orderId).sort()).toEqual([a.id, b.id].sort());
    const one = await makeInvoice(db, OWNER, { id: a.id }, t(3));
    expect(one).toMatchObject({ ok: true, value: { invoiceNo: 'BZ/2026-27/0001', already: false } });
    const again = await makeInvoice(db, OWNER, { id: a.id }, t(4));
    expect(again).toMatchObject({ ok: true, value: { invoiceNo: 'BZ/2026-27/0001', already: true } });
    const two = await makeInvoice(db, OWNER, { id: b.id }, t(5));
    expect(two.ok && two.value.invoiceNo).toBe('BZ/2026-27/0002');
    // a new financial year starts again at 0001
    const c = await soldOrder(db, '2027-04-01T00:00:00Z');
    const three = await makeInvoice(db, OWNER, { id: c.id }, '2027-04-01T00:10:00Z');
    expect(three.ok && three.value.invoiceNo).toBe('BZ/2027-28/0001');
    const list = await listInvoices(db, { at: t(10) });
    expect(list.rows.map((r) => r.invoiceNo)).toEqual(['BZ/2026-27/0002', 'BZ/2026-27/0001']);
    expect(list.years).toEqual(['2027-28', '2026-27']);
    const shown = await getInvoice(db, a.id, t(10));
    expect(shown).toMatchObject({ invoiceNo: 'BZ/2026-27/0001', invoiceDate: '2026-11-15', canInvoice: false, customer: { name: 'Kavya', city: 'Madurai' } });
  });

  it('new and test orders get no number; a GSTIN makes it a tax invoice', async () => {
    const db = await freshDb();
    const v = await variantId(db, 'murungai-honey:100g');
    const n = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ variantId: v, qty: 1 }] }, t(0));
    if (!n.ok) throw new Error('order');
    const view = await getInvoice(db, n.value.id);
    expect(view).toMatchObject({ canInvoice: false, reason: expect.stringContaining('Confirm the order first') });
    expect((await makeInvoice(db, OWNER, { id: n.value.id })).ok).toBe(false);
    const s = await updateSettings(db, OWNER, { values: { business: { name: 'Abinash Honey Farming', packerAddress: null, customerCare: null, fssai: null, gstin: '33ABCDE1234F1Z5' } } });
    expect(s.ok).toBe(true);
    expect((await getInvoice(db, n.value.id))?.title).toBe('Tax invoice');
    const sc = await saveCustomer(db, OWNER, { id: n.value.id, version: 1, name: 'X' });
    expect(sc.ok).toBe(true);
    expect(await getInvoice(db, 99999)).toBeNull();
  });
});
