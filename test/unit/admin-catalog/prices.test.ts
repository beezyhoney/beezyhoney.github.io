// src/server/prices.ts on the D1 shim.
import { describe, expect, test } from 'vitest';
import { validateCatalog } from '../../../src/data/catalog.validate.mjs';
import { buildCatalog, buildLivePayload } from '../../../src/server/catalog';
import {
  bulkPreview, bulkPrice, checkPrice, listPriceGrid, priceHistory, riskOf, riskyChanges, roundToFive, savePrices, undoPriceChange,
} from '../../../src/server/prices';
import { HELPER, OWNER, freshDb, row, rows, t } from '../../helpers/db';

type Db = Awaited<ReturnType<typeof freshDb>>;
const setting = async (db: Db, key: string) => JSON.parse((await row<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key)).value);

describe('bulk rules', () => {
  test('± % and ± ₹, rounded to ₹5 (half up), never under ₹5', () => {
    expect(roundToFive(31250)).toBe(31500);
    expect(roundToFive(31240)).toBe(31000);
    expect(bulkPrice(31000, 'pct', 10)).toBe(34000);
    expect(bulkPrice(14000, 'pct', 10)).toBe(15500);
    expect(bulkPrice(65000, 'pct', -7)).toBe(60500);
    expect(bulkPrice(700, 'pct', -50)).toBe(500);
    expect(bulkPrice(31000, 'rs', 2000)).toBe(33000);
    expect(bulkPrice(31000, 'rs', -1234)).toBe(30000); // ₹297.66 → ₹300
    expect(bulkPrice(null, 'pct', 10)).toBeNull();
  });

  test('preview skips packs without a price; MRP follows and drops to "same as price" when it would not be higher', async () => {
    const db = await freshDb();
    const grid = await listPriceGrid(db);
    expect(grid).toHaveLength(47);
    const withMrp = grid.map((r) => (r.variantId === 2 ? { ...r, mrpPaise: 31500 } : r));
    const pv = bulkPreview(withMrp.filter((r) => r.productId === 1 || r.productId === 9), 'pct', 10);
    expect(pv.map((c) => [c.variantId, c.pricePaise, c.mrpPaise])).toEqual([[1, 15500, null], [2, 34000, 34500], [3, 71500, null]]);
    const lower = bulkPreview(withMrp.filter((r) => r.variantId === 2), 'rs', -100); // ₹310 − ₹1 → ₹310: no change
    expect(lower).toEqual([]);
  });

  test('risk: more than 50 % either way, or under ₹10', () => {
    expect(riskOf(35000, 3500)).toBe('big');
    expect(riskOf(31000, 46500)).toBeNull();
    expect(riskOf(31000, 47000)).toBe('big');
    expect(riskOf(null, 900)).toBe('low');
    expect(riskOf(700, 800)).toBe('low');
    expect(riskOf(31000, null)).toBeNull();
    expect(riskyChanges([{ oldPaise: 35000, newPaise: 3500, n: 1 }, { oldPaise: 100, newPaise: 2000, n: 2 }, { oldPaise: 30000, newPaise: 31000, n: 3 }]).map((r) => [r.n, r.risk]))
      .toEqual([[1, 'big'], [2, 'big']]);
    expect(checkPrice(50, null)).toMatch(/between/);
    expect(checkPrice(null, 1000)).toMatch(/needs a price/);
    expect(checkPrice(31000, 30000)).toMatch(/cannot be lower/);
    expect(checkPrice(31000, null)).toBeNull();
  });
});

describe('savePrices', () => {
  test('saves changed rows only, writes history and bumps live + site versions', async () => {
    const db = await freshDb();
    const lv = await setting(db, 'live_version');
    const sv = await setting(db, 'site_version');
    const r = await savePrices(db, OWNER, { changes: [
      { variantId: 2, version: 1, pricePaise: 33000, mrpPaise: 35000 },
      { variantId: 1, version: 1, pricePaise: 14000, mrpPaise: null },   // unchanged
      { variantId: 25, version: 1, pricePaise: 30000, mrpPaise: 30000 }, // Karanji: from "Price on WhatsApp"; MRP = price → same
    ] }, t(0));
    expect(r).toMatchObject({ ok: true, value: { effects: { publish: 'now', live: true } } });
    if (!r.ok) return;
    expect(r.value.changed.map((c) => [c.variantId, c.oldPrice, c.newPrice, c.newMrp])).toEqual([[2, 31000, 33000, 35000], [25, null, 30000, null]]);
    expect(await setting(db, 'live_version')).toBe(lv + 1);
    expect(await setting(db, 'site_version')).toBe(sv + 1);
    await db.prepare("UPDATE settings SET value = 'true' WHERE key = 'show_prices'").run(); // live.json carries prices only while shown
    expect((await buildLivePayload(db)).p['karanji-honey']['100 g'][0]).toBe(30000);
    expect(validateCatalog(await buildCatalog(db))).toEqual([]);
    const audit = await row<{ summary: string }>(db, "SELECT summary FROM audit_log WHERE action = 'prices.save'");
    expect(audit.summary).toContain('Murungai Honey 250 g ₹310 → ₹330');
  });

  test('all or nothing: one stale pack → conflict, nothing saved; helpers refused; bad values name the field', async () => {
    const db = await freshDb();
    expect(await savePrices(db, HELPER, { changes: [{ variantId: 2, version: 1, pricePaise: 1, mrpPaise: null }] }, t(0))).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await savePrices(db, OWNER, { changes: [{ variantId: 2, version: 1, pricePaise: 50, mrpPaise: null }] }, t(0))).toMatchObject({ ok: false, field: 'price_2' });
    const res = await savePrices(db, OWNER, { changes: [
      { variantId: 2, version: 1, pricePaise: 33000, mrpPaise: null },
      { variantId: 3, version: 5, pricePaise: 70000, mrpPaise: null },
    ] }, t(0));
    expect(res).toMatchObject({ ok: false, error: 'conflict' });
    expect((await row<{ price_paise: number }>(db, 'SELECT price_paise FROM variants WHERE id = 2')).price_paise).toBe(31000);
    expect(await rows(db, 'SELECT id FROM price_history')).toEqual([]);
  });

  test('a repeated submit of the same form saves once', async () => {
    const db = await freshDb();
    const form = { changes: [{ variantId: 2, version: 1, pricePaise: 33000, mrpPaise: null }, { variantId: 3, version: 1, pricePaise: 70000, mrpPaise: null }] };
    expect((await savePrices(db, OWNER, form, t(0))).ok).toBe(true);
    expect(await savePrices(db, OWNER, form, t(0))).toMatchObject({ ok: false, error: 'conflict' });
    expect(await rows(db, 'SELECT id FROM price_history')).toHaveLength(2);
  });

  test('drafts change no website version', async () => {
    const db = await freshDb();
    await db.prepare("UPDATE products SET status = 'draft', first_live_at = NULL WHERE id = 9").run();
    const sv = await setting(db, 'site_version');
    const r = await savePrices(db, OWNER, { changes: [{ variantId: 25, version: 1, pricePaise: 20000, mrpPaise: null }] }, t(0));
    expect(r).toMatchObject({ ok: true, value: { effects: { publish: null, live: false } } });
    expect(await setting(db, 'site_version')).toBe(sv);
  });
});

describe('history and undo', () => {
  test('undo puts the old price back, only for the latest unchanged change', async () => {
    const db = await freshDb();
    await savePrices(db, OWNER, { changes: [{ variantId: 2, version: 1, pricePaise: 33000, mrpPaise: null }] }, t(0));
    await savePrices(db, OWNER, { changes: [{ variantId: 2, version: 2, pricePaise: 35000, mrpPaise: null }] }, t(1));
    let h = await priceHistory(db);
    expect(h.map((x) => [x.oldPrice, x.newPrice, x.canUndo])).toEqual([[33000, 35000, true], [31000, 33000, false]]);
    expect(await undoPriceChange(db, OWNER, { historyId: h[1].id }, t(2))).toMatchObject({ ok: false, error: 'conflict' });
    const u = await undoPriceChange(db, OWNER, { historyId: h[0].id }, t(2));
    expect(u).toMatchObject({ ok: true, value: { changed: [{ oldPrice: 35000, newPrice: 33000 }] } });
    expect((await row<{ price_paise: number }>(db, 'SELECT price_paise FROM variants WHERE id = 2')).price_paise).toBe(33000);
    h = await priceHistory(db);
    expect(h[0]).toMatchObject({ oldPrice: 35000, newPrice: 33000, canUndo: true });
    expect(h[0].reason).toMatch(/^Undo/);
  });
});
