import { describe, expect, test } from 'vitest';
import {
  addHarvest, adjustStock, countStock, createBatch, getPool, listBatches, listHarvests, listPools, poolHistory,
  setAvailability, setBatchPublic, setLowLevel, setTracking, stockAlerts, suggestBatchCode, updateBatch,
} from '../../../src/server/stock';
import { confirmOrder, createManualOrder } from '../../../src/server/orders';
import { buildCatalog, buildLivePayload, lookupBatch } from '../../../src/server/catalog';
import { HELPER, OWNER, freshDb, pool, row, rows, t } from '../../helpers/db';

const setting = async (db: Awaited<ReturnType<typeof freshDb>>, key: string) =>
  JSON.parse((await row<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key)).value);

describe('harvest (A3)', () => {
  test('adds grams, starts tracking, creates a batch with a suggested code and records it all', async () => {
    const db = await freshDb();
    const mur = await pool(db, 'murungai-honey');
    const r = await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 100_000, note: 'Main apiary' }, t(0));
    expect(r).toMatchObject({ ok: true, value: { batchCode: 'MUR-2611-01', onHand: 100_000, startedTracking: true } });
    if (!r.ok) return;
    expect(r.value.effects).toEqual({ publish: 'now', live: false }); // public batch → rebuild; untracked "in" → tracked "in": no status change
    const p = await pool(db, 'murungai-honey');
    expect(p).toMatchObject({ on_hand: 100_000, track_stock: 1 });
    const b = await row(db, 'SELECT code, code_key, harvest_id, harvested_label, packed_on, best_before, is_public, status FROM batches WHERE id = ?', r.value.batchId);
    expect(b).toEqual({ code: 'MUR-2611-01', code_key: 'MUR261101', harvest_id: r.value.harvestId, harvested_label: 'November 2026', packed_on: '2026-11-15', best_before: '2028-11', is_public: 1, status: 'active' });
    const moves = await poolHistory(db, mur.id);
    expect(moves.map((m) => [m.reason, m.delta, m.harvestId])).toEqual([['harvest', 100_000, r.value.harvestId]]);
    expect(moves[0].deltaText).toBe('+100.0 kg');
    expect(await setting(db, 'site_version')).toBe(2);
    // the next harvest of the month gets -02 and keeps tracking (no baseline reset)
    expect(await suggestBatchCode(db, (await row<{ product_id: number }>(db, 'SELECT product_id FROM stock_pools WHERE id = ?', mur.id)).product_id, '2026-11-20')).toBe('MUR-2611-02');
    const r2 = await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 2_500, batch: { isPublic: false } }, t(1));
    expect(r2).toMatchObject({ ok: true, value: { batchCode: 'MUR-2611-02', onHand: 102_500, startedTracking: false } });
    if (r2.ok) expect(r2.value.effects.publish).toBeNull();
    expect((await listHarvests(db)).map((h) => [h.amountText, h.batchCode])).toEqual([['2.5 kg', 'MUR-2611-02'], ['100.0 kg', 'MUR-2611-01']]);
    expect((await lookupBatch(db, 'mur 2611 01'))?.productName).toBe('Murungai Honey');
    expect(await lookupBatch(db, 'MUR-2611-02')).toBeNull(); // hidden from Know Your Jar
  });

  test('the first harvest ignores sales recorded before tracking (A3: earlier orders are never subtracted again)', async () => {
    const db = await freshDb();
    const o = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'murungai-honey:250g', qty: 3 }] }, t(0));
    if (!o.ok) throw new Error(o.message);
    await confirmOrder(db, OWNER, { id: o.value.id, version: 1 }, t(1));
    const mur = await pool(db, 'murungai-honey');
    expect(mur.on_hand).toBe(-750);
    const r = await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 100_000 }, t(2));
    expect(r).toMatchObject({ ok: true, value: { onHand: 100_000 } });
    const moves = await poolHistory(db, mur.id);
    expect(moves.map((m) => [m.reason, m.delta])).toEqual([['harvest', 100_000], ['count', 750], ['sale', -750]]);
  });

  test('a harvest into a pool tracked before (tracking off, then on) keeps the real stock (review: money/stock 1)', async () => {
    const db = await freshDb();
    let mur = await pool(db, 'murungai-honey');
    await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-10', amount: 50_000 }, t(0));
    const o = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'murungai-honey:250g', qty: 2 }] }, t(1));
    if (!o.ok) throw new Error(o.message);
    await confirmOrder(db, OWNER, { id: o.value.id, version: 1 }, t(2));
    mur = await pool(db, 'murungai-honey');
    expect(await setTracking(db, OWNER, { poolId: mur.id, version: mur.version, on: false }, t(3))).toMatchObject({ ok: true });
    // a sale while tracking is off is still in the ledger
    const o2 = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'murungai-honey:250g', qty: 1 }] }, t(4));
    if (!o2.ok) throw new Error(o2.message);
    await confirmOrder(db, OWNER, { id: o2.value.id, version: 1 }, t(5));
    const r = await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 10_000 }, t(6));
    expect(r).toMatchObject({ ok: true, value: { onHand: 59_250, startedTracking: true } });
    expect(await pool(db, 'murungai-honey')).toMatchObject({ on_hand: 59_250, track_stock: 1 });
    expect((await poolHistory(db, mur.id)).map((m) => m.reason)).toEqual(['harvest', 'sale', 'sale', 'harvest']); // no 'count' wiped the stock
  });

  test('switching tracking on by hand: a never-tracked pool starts from 0, a pool tracked before keeps its amount (review: money/stock 2)', async () => {
    const db = await freshDb();
    const o = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'murungai-honey:250g', qty: 3 }] }, t(0));
    if (!o.ok) throw new Error(o.message);
    await confirmOrder(db, OWNER, { id: o.value.id, version: 1 }, t(1));
    let mur = await pool(db, 'murungai-honey');
    expect(mur.on_hand).toBe(-750);
    const on = await setTracking(db, OWNER, { poolId: mur.id, version: mur.version, on: true }, t(2));
    expect(on).toMatchObject({ ok: true, value: { version: mur.version + 1 } });
    mur = await pool(db, 'murungai-honey');
    expect(mur).toMatchObject({ on_hand: 0, track_stock: 1 }); // not −0.75 kg (earlier orders are not subtracted again)
    expect((await poolHistory(db, mur.id)).map((m) => [m.reason, m.delta])).toEqual([['count', 750], ['sale', -750]]);
    // a stale version changes nothing, not even the start count
    const stale = await setTracking(db, OWNER, { poolId: mur.id, version: mur.version - 1, on: true }, t(3));
    expect(stale).toMatchObject({ ok: false, error: 'conflict' });
    // off, a harvest, a sale, off and on again: the amount stays
    await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 5_000 }, t(4));
    mur = await pool(db, 'murungai-honey');
    await setTracking(db, OWNER, { poolId: mur.id, version: mur.version, on: false }, t(5));
    await setTracking(db, OWNER, { poolId: mur.id, version: mur.version + 1, on: true }, t(6));
    expect(await pool(db, 'murungai-honey')).toMatchObject({ on_hand: 5_000, track_stock: 1 });
    expect((await poolHistory(db, mur.id)).filter((m) => m.reason === 'count')).toHaveLength(1);
  });

  test('refuses bad input, piece pools, used codes and a double submit', async () => {
    const db = await freshDb();
    const mur = await pool(db, 'murungai-honey');
    const sticks = await pool(db, 'honey-sticks');
    expect(await addHarvest(db, OWNER, { poolId: sticks.id, harvestedOn: '2026-11-15', amount: 100 }, t(0))).toMatchObject({ ok: false, error: 'invalid', field: 'poolId' });
    expect(await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-16', amount: 100 }, t(0))).toMatchObject({ ok: false, field: 'harvestedOn' }); // tomorrow in IST
    expect(await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 0 }, t(0))).toMatchObject({ ok: false, field: 'amount' });
    expect(await addHarvest(db, OWNER, { poolId: 999, harvestedOn: '2026-11-15', amount: 1 }, t(0))).toMatchObject({ ok: false, error: 'not_found' });
    expect(await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 1000, batch: { bestBefore: '2026-10' } }, t(0))).toMatchObject({ ok: false, field: 'batch.bestBefore' });
    const ok1 = await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 1000, idemKey: 'form-7' }, t(0));
    expect(ok1.ok).toBe(true);
    expect(await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 1000, idemKey: 'form-7', batch: { code: 'MUR-X1' } }, t(1))).toMatchObject({ ok: false, error: 'conflict' });
    expect(await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-15', amount: 1000, batch: { code: 'mur 2611 01' } }, t(1))).toMatchObject({ ok: false, error: 'conflict', field: 'batch.code' });
    expect((await pool(db, 'murungai-honey')).on_hand).toBe(1000);
    expect((await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM harvests')).n).toBe(1);
  });
});

describe('count, adjust and pool settings', () => {
  test('count sets the absolute amount, turns tracking on, and computes the difference inside the batch', async () => {
    const db = await freshDb();
    const small = await pool(db, 'beeswax-candles:small');
    const mur = await pool(db, 'murungai-honey');
    const r = await countStock(db, OWNER, { counts: [{ poolId: small.id, amount: 40 }, { poolId: mur.id, amount: 12_500 }] }, t(0));
    expect(r).toMatchObject({ ok: true, value: { startedTracking: [small.id, mur.id] } });
    expect(await pool(db, 'beeswax-candles:small')).toMatchObject({ on_hand: 40, track_stock: 1 });
    // a sale, then a recount to the real amount
    const o = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'beeswax-candles:small', qty: 5 }] }, t(1));
    if (!o.ok) throw new Error(o.message);
    await confirmOrder(db, OWNER, { id: o.value.id, version: 1 }, t(2));
    expect((await pool(db, 'beeswax-candles:small')).on_hand).toBe(35);
    const r2 = await countStock(db, OWNER, { counts: [{ poolId: small.id, amount: 33 }] }, t(3));
    expect(r2).toMatchObject({ ok: true, value: { changed: [{ poolId: small.id, before: 35, after: 33 }], startedTracking: [] } });
    expect((await pool(db, 'beeswax-candles:small')).on_hand).toBe(33);
    // counting the same amount writes no move
    await countStock(db, OWNER, { counts: [{ poolId: small.id, amount: 33 }] }, t(4));
    expect((await poolHistory(db, small.id)).map((m) => [m.reason, m.delta])).toEqual([['count', -2], ['sale', -5], ['count', 40]]);
    expect(await countStock(db, OWNER, { counts: [{ poolId: small.id, amount: -1 }] }, t(5))).toMatchObject({ ok: false, error: 'invalid' });
    expect(await countStock(db, OWNER, { counts: [] }, t(5))).toMatchObject({ ok: false, error: 'invalid' });
  });

  test('adjust: damage and samples take out, returns put back; tracking stays as it was', async () => {
    const db = await freshDb();
    const kom = await pool(db, 'kombu-honey');
    expect(await adjustStock(db, OWNER, { poolId: kom.id, reason: 'damage', delta: -500, note: 'Jar broke' }, t(0))).toMatchObject({ ok: true, value: { onHand: -500 } });
    expect(await adjustStock(db, OWNER, { poolId: kom.id, reason: 'return', delta: 250 }, t(1))).toMatchObject({ ok: true, value: { onHand: -250 } });
    expect(await adjustStock(db, OWNER, { poolId: kom.id, reason: 'damage', delta: 100 }, t(2))).toMatchObject({ ok: false, field: 'delta' });
    expect(await adjustStock(db, OWNER, { poolId: kom.id, reason: 'return', delta: -1 }, t(2))).toMatchObject({ ok: false, field: 'delta' });
    expect(await adjustStock(db, OWNER, { poolId: kom.id, reason: 'packed' as never, delta: -1 }, t(2))).toMatchObject({ ok: false, field: 'reason' });
    expect((await pool(db, 'kombu-honey')).track_stock).toBe(0);
    const audit = await rows<{ summary: string }>(db, "SELECT summary FROM audit_log WHERE action = 'stock.adjust' ORDER BY id");
    expect(audit.map((a) => a.summary)).toEqual(['Kombu Honey −0.5 kg (damaged): Jar broke', 'Kombu Honey +0.3 kg (returned)']);
  });

  test('availability levels follow the pool: out below one pack, low at the low level, override wins', async () => {
    const db = await freshDb();
    const mur = await pool(db, 'murungai-honey');
    await countStock(db, OWNER, { counts: [{ poolId: mur.id, amount: 1_800 }] }, t(0)); // low_at = 2000 g
    let view = (await getPool(db, mur.id))!;
    expect(view.level).toBe('low');
    expect(view.amountText).toBe('1.8 kg');
    expect(view.equivalents).toBe('≈ 7 × 250 g or 18 × 100 g');
    expect(view.packs.map((p) => [p.label, p.avail])).toEqual([['100 g', 'low'], ['250 g', 'low'], ['500 g', 'low']]);
    // stock display 'sold_out' (default) shows low as in on the website
    let live = await buildLivePayload(db, t(1));
    expect(live.p['murungai-honey']['500 g'][2]).toBe('in');
    await countStock(db, OWNER, { counts: [{ poolId: mur.id, amount: 300 }] }, t(2));
    live = await buildLivePayload(db, t(3));
    expect(Object.fromEntries(Object.entries(live.p['murungai-honey']).map(([k, v]) => [k, v[2]]))).toEqual({ '100 g': 'in', '250 g': 'in', '500 g': 'out' });
    view = (await getPool(db, mur.id))!;
    expect(await setAvailability(db, HELPER, { poolId: mur.id, version: view.version, availability: 'out' }, t(4))).toMatchObject({ ok: false, error: 'forbidden' });
    const r = await setAvailability(db, OWNER, { poolId: mur.id, version: view.version, availability: 'out' }, t(4));
    expect(r).toEqual({ ok: true, value: { version: view.version + 1, effects: { publish: 'scheduled', live: true } } });
    expect(await setAvailability(db, OWNER, { poolId: mur.id, version: view.version, availability: 'in' }, t(5))).toMatchObject({ ok: false, error: 'conflict' });
    live = await buildLivePayload(db, t(6));
    expect(Object.values(live.p['murungai-honey']).map((v) => v[2])).toEqual(['out', 'out', 'out']);
    // the recount to 300 g made 500 g sold out at t(2): due at t(32); the later override keeps the earlier time
    expect(await setting(db, 'publish_due_at')).toBe(t(32));
  });

  test('tracking off shows In stock again; the low level can be removed', async () => {
    const db = await freshDb();
    const mur = await pool(db, 'murungai-honey');
    await countStock(db, OWNER, { counts: [{ poolId: mur.id, amount: 0 }] }, t(0));
    let p = (await getPool(db, mur.id))!;
    expect(p.level).toBe('empty');
    const off = await setTracking(db, OWNER, { poolId: mur.id, version: p.version, on: false }, t(1));
    expect(off).toMatchObject({ ok: true, value: { effects: { live: true } } });
    p = (await getPool(db, mur.id))!;
    expect(p.level).toBe('untracked');
    expect(p.packs.every((x) => x.avail === 'in')).toBe(true);
    expect(await setLowLevel(db, OWNER, { poolId: mur.id, version: p.version, lowAt: null }, t(2))).toMatchObject({ ok: true });
    expect(await setLowLevel(db, OWNER, { poolId: mur.id, version: p.version + 1, lowAt: -5 }, t(3))).toMatchObject({ ok: false, field: 'lowAt' });
  });

  test('stock alerts list negative, empty and low pools; untracked pools never alert', async () => {
    const db = await freshDb();
    const ids = Object.fromEntries(await Promise.all(['murungai-honey', 'kombu-honey', 'beeswax-candles:large', 'forest-honey'].map(async (c) => [c, (await pool(db, c)).id])));
    await countStock(db, OWNER, { counts: [{ poolId: ids['murungai-honey'], amount: 1500 }, { poolId: ids['kombu-honey'], amount: 50 }, { poolId: ids['beeswax-candles:large'], amount: 20 }] }, t(0));
    await adjustStock(db, OWNER, { poolId: ids['kombu-honey'], reason: 'damage', delta: -100 }, t(1));
    await adjustStock(db, OWNER, { poolId: ids['forest-honey'], reason: 'damage', delta: -100 }, t(1)); // untracked
    const a = await stockAlerts(db, t(2));
    expect(a.pools.map((p) => [p.name, p.level, p.amountText])).toEqual([['Kombu Honey', 'negative', '−0.1 kg'], ['Murungai Honey', 'low', '1.5 kg']]);
    expect(a.bestBefore).toEqual([]);
  });

  test('listPools covers every pool of the website, in product order', async () => {
    const db = await freshDb();
    const pools = await listPools(db);
    expect(pools).toHaveLength(18);
    expect(pools[0]).toMatchObject({ code: 'murungai-honey', unit: 'g', trackStock: false, level: 'untracked', amountText: '0.0 kg', lowAt: 2000 });
    expect(pools.find((p) => p.code === 'honey-sticks')!.packs.map((p) => [p.label, p.poolQty])).toEqual([['1 stick', 1], ['Box of 10 (100 g)', 10]]);
  });
});

describe('batches', () => {
  test('create, edit, hide and recall; the catalog and the lookup follow', async () => {
    const db = await freshDb();
    const pid = (await row<{ id: number }>(db, "SELECT id FROM products WHERE slug = 'dammar-honey'")).id;
    const c = await createBatch(db, OWNER, { productId: pid, harvestedLabel: 'September 2026', packedOn: '2026-10-02', bestBefore: '2028-09', publicNote: 'Small wild harvest.' }, t(0));
    expect(c).toMatchObject({ ok: true, value: { code: 'DAM-2610-01', effects: { publish: 'now' } } });
    if (!c.ok) return;
    let cat = await buildCatalog(db);
    expect(cat.batches).toEqual([{ code: 'DAM-2610-01', productSlug: 'dammar-honey', harvested: 'September 2026', packed: '2026-10-02', bestBefore: '2028-09', note: 'Small wild harvest.' }]);
    const list = await listBatches(db, { at: t(0) });
    expect(list[0]).toMatchObject({ code: 'DAM-2610-01', isPublic: true, estimatedLeft: null, bestBeforeState: 'ok' });
    expect(await updateBatch(db, OWNER, { id: c.value.id, version: 1, publicNote: 'Tiny wild harvest.', privateNote: 'From the east hive line' }, t(1))).toMatchObject({ ok: true, value: { version: 2, effects: { publish: 'now' } } });
    expect(await updateBatch(db, OWNER, { id: c.value.id, version: 1, publicNote: 'x' }, t(2))).toMatchObject({ ok: false, error: 'conflict' });
    expect(await updateBatch(db, OWNER, { id: c.value.id, version: 2, privateNote: 'Only private' }, t(2))).toMatchObject({ ok: true, value: { effects: { publish: null } } });
    expect(await setBatchPublic(db, OWNER, { id: c.value.id, version: 3, isPublic: false }, t(3))).toMatchObject({ ok: true, value: { version: 4, effects: { publish: 'now' } } });
    cat = await buildCatalog(db);
    expect(cat.batches).toEqual([]);
    expect(JSON.stringify(cat)).not.toContain('east hive');
    expect(await lookupBatch(db, 'DAM-2610-01')).toBeNull();
    // a second batch with the same code is refused
    expect(await createBatch(db, OWNER, { productId: pid, code: 'dam-2610-01', harvestedLabel: 'September 2026', packedOn: '2026-10-02', bestBefore: '2028-09' }, t(4))).toMatchObject({ ok: false, error: 'conflict' });
  });

  test('best-before alerts and the remainder estimate (newest batch first)', async () => {
    const db = await freshDb();
    const mur = await pool(db, 'murungai-honey');
    await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2024-12-01', amount: 10_000, batch: { bestBefore: '2026-12' } }, t(0));
    await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-01', amount: 5_000 }, t(1));
    await adjustStock(db, OWNER, { poolId: mur.id, reason: 'sample', delta: -12_000 }, t(2));
    const list = await listBatches(db, { at: t(3) });
    expect(list.map((b) => [b.code, b.estimatedLeft, b.bestBeforeState])).toEqual([['MUR-2611-01', 3_000, 'ok'], ['MUR-2412-01', 0, 'soon']]);
    const alerts = await stockAlerts(db, t(3));
    expect(alerts.bestBefore).toEqual([{ batchId: list[1].id, code: 'MUR-2412-01', productName: 'Murungai Honey', bestBefore: '2026-12', state: 'soon' }]);
    expect((await stockAlerts(db, '2027-01-01T00:00:00Z')).bestBefore[0].state).toBe('passed');
  });
});
