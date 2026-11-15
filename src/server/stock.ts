// Stock the owner's way (amendment A3): pools in grams (honey) or pieces (candles, sticks), an append-only ledger
// (stock_moves) with stock_pools.on_hand as its cache, harvests that add stock and create a batch, counts that set
// the real amount, adjustments, tracking, low levels, availability overrides, batches and stock alerts.
//
// Every write is one guarded D1 batch that also recomputes on_hand from the ledger and writes its audit row.
// When a write changes what the website shows for a pack (in / low / out), the same batch bumps live_version and
// sets publish_due_at (debounced rebuild, design §2.5).
import { batchKey } from '../data/catalog.validate.mjs';
import {
  type Avail, type AvailabilityOverride, type PoolLevel, type PoolUnit, type StockDisplay,
  formatPoolAmount, packAvailability, packEquivalents, poolLevel, publicAvail,
} from '../lib/availability';
import {
  type Actor, type D1, type D1Statement, type Effects, type Guard, type Result,
  all, auditInsert, batch, fail, first, ok, ownerOnly, stmt, tryBatch, uuid, versionedUpdate,
} from './db';
import { STOCK_PUBLISH_DELAY_MINUTES, bumpVersionStmt, schedulePublishStmt } from './settings';
import { addDays, addMonths, addTime, isDate, isMonth, istDate, monthName, nowIso } from './time';

export type MoveReason = 'harvest' | 'count' | 'sale' | 'sale_reversal' | 'damage' | 'sample' | 'return' | 'other';
export type AdjustReason = 'damage' | 'sample' | 'return' | 'other';
export const ADJUST_REASONS: readonly AdjustReason[] = ['damage', 'sample', 'return', 'other'];

// ───────────────────────────── reading pools ─────────────────────────────

export interface PackView {
  variantId: number;
  code: string;
  label: string;
  poolQty: number;
  active: boolean;
  /** availability from the stock (before the website's stock display rule) */
  avail: Avail;
}

export interface PoolView {
  id: number;
  code: string;
  name: string;
  unit: PoolUnit;
  productId: number;
  productSlug: string;
  productName: string;
  productStatus: 'draft' | 'live' | 'paused' | 'retired';
  trackStock: boolean;
  onHand: number;
  lowAt: number | null;
  availability: AvailabilityOverride;
  trackingSince: string | null;
  version: number;
  /** owner-facing level: untracked | negative | empty | low | ok */
  level: PoolLevel;
  /** '99.5 kg' / '12 pieces' */
  amountText: string;
  /** '≈ 396 × 250 g or 991 × 100 g' ('' when nothing is left) */
  equivalents: string;
  packs: PackView[];
}

interface PoolRow {
  id: number; code: string; name: string; unit: PoolUnit; product_id: number; slug: string; product_name: string;
  product_status: PoolView['productStatus']; track_stock: number; on_hand: number; low_at: number | null;
  availability: AvailabilityOverride; tracking_since: string | null; version: number;
}
interface PackRow { pool_id: number; id: number; code: string; label: string; pool_qty: number; active: number }

const POOL_SQL = `SELECT s.id, s.code, s.name, s.unit, s.product_id, p.slug, p.name AS product_name, p.status AS product_status,
    s.track_stock, s.on_hand, s.low_at, s.availability, s.tracking_since, s.version
  FROM stock_pools s JOIN products p ON p.id = s.product_id`;
const PACK_SQL = 'SELECT v.pool_id, v.id, v.code, v.label, v.pool_qty, v.active FROM variants v';

function toPoolView(r: PoolRow, packs: PackRow[]): PoolView {
  const state = { trackStock: r.track_stock === 1, onHand: r.on_hand, lowAt: r.low_at, availability: r.availability };
  const active = packs.filter((p) => p.active === 1);
  const smallest = active.length ? Math.min(...active.map((p) => p.pool_qty)) : 1;
  return {
    id: r.id, code: r.code, name: r.name, unit: r.unit, productId: r.product_id, productSlug: r.slug, productName: r.product_name,
    productStatus: r.product_status, trackStock: state.trackStock, onHand: r.on_hand, lowAt: r.low_at, availability: r.availability,
    trackingSince: r.tracking_since, version: r.version,
    level: poolLevel(state, smallest),
    amountText: formatPoolAmount(r.on_hand, r.unit),
    equivalents: r.unit === 'g' ? packEquivalents(r.on_hand, active.map((p) => ({ label: p.label, poolQty: p.pool_qty }))) : '',
    packs: packs.map((p) => ({ variantId: p.id, code: p.code, label: p.label, poolQty: p.pool_qty, active: p.active === 1, avail: packAvailability(state, p.pool_qty) })),
  };
}

/** Every pool for the Stock grid, in product order (retired and draft products only when asked) */
export async function listPools(db: D1, opts: { includeRetired?: boolean; includeDrafts?: boolean } = {}): Promise<PoolView[]> {
  const statuses = ['live', 'paused', ...(opts.includeRetired ? ['retired'] : []), ...(opts.includeDrafts ? ['draft'] : [])];
  const marks = statuses.map(() => '?').join(', ');
  const [poolRes, packRes] = await db.batch([
    stmt(db, `${POOL_SQL} WHERE p.status IN (${marks}) ORDER BY p.sort, p.slug, s.sort, s.id`, ...statuses),
    stmt(db, `${PACK_SQL} JOIN products p ON p.id = v.product_id WHERE p.status IN (${marks}) ORDER BY v.pool_id, v.sort, v.id`, ...statuses),
  ]);
  const packs = packRes.results as unknown as PackRow[];
  return (poolRes.results as unknown as PoolRow[]).map((r) => toPoolView(r, packs.filter((p) => p.pool_id === r.id)));
}

/** One pool, or null */
export async function getPool(db: D1, poolId: number): Promise<PoolView | null> {
  const [poolRes, packRes] = await db.batch([
    stmt(db, `${POOL_SQL} WHERE s.id = ?`, poolId),
    stmt(db, `${PACK_SQL} WHERE v.pool_id = ? ORDER BY v.sort, v.id`, poolId),
  ]);
  const r = poolRes.results[0] as unknown as PoolRow | undefined;
  return r ? toPoolView(r, packRes.results as unknown as PackRow[]) : null;
}

export interface MoveView {
  id: number;
  delta: number;
  /** '+100.0 kg' / '−2 pieces' */
  deltaText: string;
  reason: MoveReason;
  orderId: number | null;
  orderRef: string | null;
  harvestId: number | null;
  note: string | null;
  createdAt: string;
  createdBy: string;
}

/** Ledger of one pool, newest first (keyset paging with `beforeId`) */
export async function poolHistory(db: D1, poolId: number, opts: { limit?: number; beforeId?: number } = {}): Promise<MoveView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await all<{ id: number; delta: number; reason: MoveReason; order_id: number | null; ref: string | null; harvest_id: number | null; note: string | null; created_at: string; created_by: string; unit: PoolUnit }>(db,
    `SELECT m.id, m.delta, m.reason, m.order_id, o.ref, m.harvest_id, m.note, m.created_at, m.created_by, s.unit
       FROM stock_moves m JOIN stock_pools s ON s.id = m.pool_id LEFT JOIN orders o ON o.id = m.order_id
      WHERE m.pool_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`, poolId, opts.beforeId ?? Number.MAX_SAFE_INTEGER, limit);
  return rows.map((r) => ({
    id: r.id, delta: r.delta, deltaText: `${r.delta > 0 ? '+' : ''}${formatPoolAmount(r.delta, r.unit)}`, reason: r.reason,
    orderId: r.order_id, orderRef: r.ref, harvestId: r.harvest_id, note: r.note, createdAt: r.created_at, createdBy: r.created_by,
  }));
}

// ───────────────────────────── stock-status effects (used by orders.ts too) ─────────────────────────────

/** A pool as needed to predict whether a write changes what the website shows */
export interface PoolForecast {
  id: number;
  name: string;
  unit: PoolUnit;
  trackStock: boolean;
  onHand: number;
  lowAt: number | null;
  availability: AvailabilityOverride;
  /** pool quantities of the packs the website shows (active packs of live or paused products) */
  visibleQtys: number[];
}

/** Reads pools (and the stock display setting) for a forecast. One read batch. */
export async function readPoolForecasts(db: D1, poolIds: number[]): Promise<{ pools: Map<number, PoolForecast>; display: StockDisplay }> {
  const ids = JSON.stringify([...new Set(poolIds)]);
  const [poolRes, packRes, dispRes] = await db.batch([
    stmt(db, 'SELECT id, name, unit, track_stock, on_hand, low_at, availability FROM stock_pools WHERE id IN (SELECT value FROM json_each(?))', ids),
    stmt(db, `SELECT v.pool_id, v.pool_qty FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.pool_id IN (SELECT value FROM json_each(?)) AND v.active = 1 AND p.status IN ('live', 'paused')`, ids),
    stmt(db, "SELECT value FROM settings WHERE key = 'stock_display'"),
  ]);
  const pools = new Map<number, PoolForecast>();
  for (const r of poolRes.results as { id: number; name: string; unit: PoolUnit; track_stock: number; on_hand: number; low_at: number | null; availability: AvailabilityOverride }[]) {
    pools.set(r.id, { id: r.id, name: r.name, unit: r.unit, trackStock: r.track_stock === 1, onHand: r.on_hand, lowAt: r.low_at, availability: r.availability, visibleQtys: [] });
  }
  for (const p of packRes.results as { pool_id: number; pool_qty: number }[]) pools.get(p.pool_id)?.visibleQtys.push(p.pool_qty);
  const raw = (dispRes.results[0] as { value: string } | undefined)?.value;
  const display: StockDisplay = raw ? (JSON.parse(raw) as StockDisplay) : 'sold_out';
  return { pools, display };
}

/** The change a write makes to a pool (only the fields given change) */
export interface PoolChange { delta?: number; trackStock?: boolean; lowAt?: number | null; availability?: AvailabilityOverride; setOnHand?: number }

/** True when the change alters the public availability of any visible pack of the pool */
export function changesPublicStatus(before: PoolForecast, change: PoolChange, display: StockDisplay): boolean {
  const after = {
    trackStock: change.trackStock ?? before.trackStock,
    onHand: change.setOnHand ?? before.onHand + (change.delta ?? 0),
    lowAt: change.lowAt === undefined ? before.lowAt : change.lowAt,
    availability: change.availability ?? before.availability,
  };
  return before.visibleQtys.some((q) => publicAvail(packAvailability(before, q), display) !== publicAvail(packAvailability(after, q), display));
}

/** Predicts whether any of the changes alters the website (reads the pools first) */
export async function forecastStatusChange(db: D1, changes: Map<number, PoolChange>): Promise<{ changed: boolean; pools: Map<number, PoolForecast> }> {
  if (!changes.size) return { changed: false, pools: new Map() };
  const { pools, display } = await readPoolForecasts(db, [...changes.keys()]);
  let changed = false;
  for (const [id, ch] of changes) {
    const p = pools.get(id);
    if (p && changesPublicStatus(p, ch, display)) changed = true;
  }
  return { changed, pools };
}

/**
 * Statements for a stock-status change, added to the write's batch: live_version + 1 (the live endpoint shows it
 * within a minute) and publish_due_at = now + 30 min unless an earlier time is set (the baked pages catch up).
 */
export function stockStatusStatements(db: D1, at: string, by: string, guard?: Guard): D1Statement[] {
  return [
    bumpVersionStmt(db, 'live_version', at, by, guard),
    schedulePublishStmt(db, addTime(at, { minutes: STOCK_PUBLISH_DELAY_MINUTES }), at, guard),
  ];
}

/** UPDATE that sets on_hand of the given pools from the ledger (the cache rule of design §3.3) */
export function recomputePoolsStmt(db: D1, poolIds: number[], guard?: Guard): D1Statement {
  return stmt(db, `UPDATE stock_pools SET on_hand = (SELECT COALESCE(SUM(m.delta), 0) FROM stock_moves m WHERE m.pool_id = stock_pools.id)
    WHERE id IN (SELECT value FROM json_each(?))${guard ? ` AND ${guard.sql}` : ''}`, JSON.stringify([...new Set(poolIds)]), ...(guard?.params ?? []));
}

/**
 * The "start tracking" count (A3: orders confirmed before tracking are never subtracted again): a 'count' move that
 * brings the ledger of a pool that was **never tracked** (track_stock = 0 AND tracking_since IS NULL, checked inside
 * the batch) to 0. A pool that was tracked before and switched off keeps its ledger. Put it before the statement that
 * switches tracking on. `extra` adds a condition (e.g. the pool's version for a versioned update that follows).
 */
export function startTrackingCountStmt(db: D1, poolId: number, idemKey: string, at: string, by: string, extra?: Guard): D1Statement {
  return stmt(db, `INSERT INTO stock_moves (pool_id, delta, reason, idem_key, note, created_at, created_by)
    SELECT ?, -t.total, 'count', ?, 'Start tracking: earlier sales are not counted again', ?, ?
      FROM (SELECT COALESCE(SUM(delta), 0) AS total FROM stock_moves WHERE pool_id = ?) t
     WHERE t.total <> 0 AND EXISTS (SELECT 1 FROM stock_pools WHERE id = ? AND track_stock = 0 AND tracking_since IS NULL)${extra ? ` AND ${extra.sql}` : ''}`,
  poolId, idemKey, at, by, poolId, poolId, ...(extra?.params ?? []));
}

const statusEffects = (changed: boolean, extra: Partial<Effects> = {}): Effects => ({
  publish: extra.publish ?? (changed ? 'scheduled' : null),
  live: changed || (extra.live ?? false),
});

// ───────────────────────────── harvest ─────────────────────────────

export interface HarvestInput {
  /** the pool the honey goes into (a gram pool) */
  poolId: number;
  /** harvest date 'YYYY-MM-DD' (IST), not in the future */
  harvestedOn: string;
  /** amount in the pool's unit: grams (the screen asks for kg, see parsePoolAmount) */
  amount: number;
  note?: string | null;
  hives?: number | null;
  /** moisture in tenths of a percent (18.5 % = 185) */
  moisturePctX10?: number | null;
  /** batch created with the harvest (A3). Leave out `batch` for the defaults; `batch: false` makes none. */
  batch?: false | {
    /** default: suggested '<SHORT>-<YYMM>-<NN>' */
    code?: string;
    /** default: the harvest date */
    packedOn?: string;
    /** 'YYYY-MM'; default: 24 months after the harvest month */
    bestBefore?: string;
    /** "Show in Know Your Jar"; default true */
    isPublic?: boolean;
    publicNote?: string | null;
    privateNote?: string | null;
  };
  /** one form submit = one harvest: the form's hidden key (a fresh uuid otherwise) */
  idemKey?: string;
}

export interface HarvestDone {
  harvestId: number;
  batchId: number | null;
  batchCode: string | null;
  /** pool amount after the harvest */
  onHand: number;
  /** true when this harvest switched tracking on (earlier untracked sales are not subtracted again) */
  startedTracking: boolean;
  effects: Effects;
}

const MAX_GRAMS = 100_000_000; // 100 tonnes: anything bigger is a typing mistake

/** Suggested batch code '<SHORT>-<YYMM>-<NN>' for a product's harvest date, e.g. 'MUR-2611-01' */
export async function suggestBatchCode(db: D1, productId: number, harvestedOn: string): Promise<string | null> {
  const p = await first<{ short_code: string }>(db, 'SELECT short_code FROM products WHERE id = ?', productId);
  if (!p || !isDate(harvestedOn)) return null;
  const yymm = `${harvestedOn.slice(2, 4)}${harvestedOn.slice(5, 7)}`;
  const prefix = `${p.short_code}${yymm}`;
  const rows = await all<{ code_key: string }>(db, "SELECT code_key FROM batches WHERE code_key LIKE ? || '%'", prefix);
  let max = 0;
  for (const r of rows) {
    const n = Number(r.code_key.slice(prefix.length));
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return `${p.short_code}-${yymm}-${String(max + 1).padStart(2, '0')}`;
}

/** Normalised batch code as people type it: trimmed, capitals, single spaces */
const cleanCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * "Add harvest" (A3): one harvests row, one 'harvest' stock move and (by default) one batch, in one batch.
 * A harvest switches tracking on. When the pool was never tracked, a 'count' move first brings it to 0 so sales
 * recorded before tracking are not subtracted again; a pool tracked before (then switched off) keeps its ledger and
 * the harvest is added to it.
 * Errors: invalid (field), not_found (pool), conflict (batch code used, or the same form sent twice).
 */
export async function addHarvest(db: D1, actor: Actor, input: HarvestInput, at: string = nowIso()): Promise<Result<HarvestDone>> {
  const pool = await first<{ id: number; product_id: number; unit: PoolUnit; track_stock: number; tracking_since: string | null; name: string; short_code: string; product_status: string }>(db,
    `SELECT s.id, s.product_id, s.unit, s.track_stock, s.tracking_since, s.name, p.short_code, p.status AS product_status
       FROM stock_pools s JOIN products p ON p.id = s.product_id WHERE s.id = ?`, input?.poolId);
  if (!pool) return fail('not_found', 'This stock pool does not exist.', { field: 'poolId' });
  if (pool.unit !== 'g') return fail('invalid', 'Harvests are entered for honey (kg). Use Count or Adjust for pieces.', { field: 'poolId' });
  if (!isDate(input.harvestedOn)) return fail('invalid', 'Enter the harvest date.', { field: 'harvestedOn' });
  if (input.harvestedOn > istDate(at)) return fail('invalid', 'The harvest date cannot be in the future.', { field: 'harvestedOn' });
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > MAX_GRAMS) return fail('invalid', 'Enter how many kg were harvested.', { field: 'amount' });
  if (input.hives != null && !(Number.isSafeInteger(input.hives) && input.hives > 0 && input.hives < 100_000)) return fail('invalid', 'Hives must be a whole number.', { field: 'hives' });
  if (input.moisturePctX10 != null && !(Number.isSafeInteger(input.moisturePctX10) && input.moisturePctX10 >= 100 && input.moisturePctX10 <= 300)) return fail('invalid', 'Moisture must be between 10.0 and 30.0 %.', { field: 'moisturePctX10' });
  const note = input.note?.trim() || null;
  if (note && note.length > 500) return fail('invalid', 'The note is too long (500 characters at most).', { field: 'note' });

  // batch defaults (A3): suggested code, packed on the harvest date, best before +24 months, public
  let batchRow: null | { code: string; key: string; packedOn: string; bestBefore: string; isPublic: boolean; publicNote: string | null; privateNote: string | null } = null;
  if (input.batch !== false) {
    const b = input.batch ?? {};
    const code = b.code ? cleanCode(b.code) : await suggestBatchCode(db, pool.product_id, input.harvestedOn);
    const problem = checkBatchFields({ code, packedOn: b.packedOn ?? input.harvestedOn, bestBefore: b.bestBefore ?? addMonths(input.harvestedOn.slice(0, 7), 24), publicNote: b.publicNote, privateNote: b.privateNote });
    if (problem) return problem;
    const key = batchKey(code!);
    if (await first(db, 'SELECT 1 AS x FROM batches WHERE code_key = ?', key)) return fail('conflict', `Batch code ${code} is already used. Choose another.`, { field: 'batch.code' });
    batchRow = {
      code: code!, key, packedOn: b.packedOn ?? input.harvestedOn, bestBefore: b.bestBefore ?? addMonths(input.harvestedOn.slice(0, 7), 24),
      isPublic: b.isPublic ?? true, publicNote: b.publicNote?.trim() || null, privateNote: b.privateNote?.trim() || null,
    };
  }

  const idem = input.idemKey || uuid();
  const by = actor.email;
  const startedTracking = pool.track_stock === 0;
  // only a pool that was never tracked starts from 0; a pool tracked before (then switched off) keeps its ledger
  const firstTracking = startedTracking && pool.tracking_since === null;
  const harvested = { sql: 'EXISTS (SELECT 1 FROM harvests WHERE idem_key = ?)', params: [idem] };
  const forecast = await forecastStatusChange(db, new Map([[pool.id, firstTracking ? { trackStock: true, setOnHand: input.amount } : { trackStock: true, delta: input.amount }]]));

  const statements: D1Statement[] = [
    stmt(db, `INSERT INTO harvests (product_id, pool_id, harvested_on, qty, hives, moisture_pct_x10, note, idem_key, version, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    pool.product_id, pool.id, input.harvestedOn, input.amount, input.hives ?? null, input.moisturePctX10 ?? null, note, idem, at, by, at, by),
  ];
  if (firstTracking) statements.push(startTrackingCountStmt(db, pool.id, `count:${idem}:${pool.id}`, at, by));
  statements.push(
    stmt(db, `INSERT INTO stock_moves (pool_id, delta, reason, harvest_id, idem_key, note, created_at, created_by)
      SELECT ?, ?, 'harvest', h.id, 'harvest:' || h.id, ?, ?, ? FROM harvests h WHERE h.idem_key = ?`,
    pool.id, input.amount, note ? note.slice(0, 200) : null, at, by, idem),
    stmt(db, `UPDATE stock_pools SET on_hand = (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE pool_id = stock_pools.id),
        track_stock = 1, tracking_since = CASE WHEN track_stock = 1 THEN tracking_since ELSE ? END
      WHERE id = ? AND EXISTS (SELECT 1 FROM harvests WHERE idem_key = ?)`, at, pool.id, idem),
  );
  if (batchRow) {
    statements.push(stmt(db, `INSERT INTO batches (code, code_key, product_id, harvest_id, harvested_label, packed_on, best_before, public_note,
        private_note, is_public, status, version, created_at, created_by, updated_at, updated_by)
      SELECT ?, ?, h.product_id, h.id, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ? FROM harvests h WHERE h.idem_key = ?`,
    batchRow.code, batchRow.key, monthName(input.harvestedOn), batchRow.packedOn, batchRow.bestBefore, batchRow.publicNote,
    batchRow.privateNote, batchRow.isPublic, at, by, at, by, idem));
  }
  if (forecast.changed) statements.push(...stockStatusStatements(db, at, by, harvested));
  const publicBatch = batchRow?.isPublic === true && ['live', 'paused', 'retired'].includes(pool.product_status);
  if (publicBatch) statements.push(bumpVersionStmt(db, 'site_version', at, by, harvested));
  statements.push(auditInsert(db, {
    at, actor, action: 'stock.harvest', entity: 'pool', entityId: pool.id,
    summary: `Harvest: ${pool.name} +${formatPoolAmount(input.amount, 'g')} (${input.harvestedOn})${batchRow ? `, batch ${batchRow.code}` : ''}${startedTracking ? ', stock tracking started' : ''}`,
    after: { harvestedOn: input.harvestedOn, amount: input.amount, batch: batchRow?.code ?? null },
  }, harvested));
  statements.push(stmt(db, `SELECT (SELECT id FROM harvests WHERE idem_key = ?1) AS harvest_id,
      (SELECT b.id FROM batches b JOIN harvests h ON h.id = b.harvest_id WHERE h.idem_key = ?1) AS batch_id,
      (SELECT on_hand FROM stock_pools WHERE id = ?2) AS on_hand`, idem, pool.id));

  const res = await tryBatch(db, statements, { unique: 'This harvest was already saved, or the batch code is used. Reload the page.' });
  if (!res.ok) return res;
  const out = res.value[res.value.length - 1].results[0] as { harvest_id: number; batch_id: number | null; on_hand: number };
  return ok({
    harvestId: out.harvest_id, batchId: out.batch_id, batchCode: batchRow?.code ?? null, onHand: out.on_hand, startedTracking,
    effects: statusEffects(forecast.changed, publicBatch ? { publish: 'now' } : {}),
  });
}

/** Harvest log, newest first */
export async function listHarvests(db: D1, opts: { productId?: number; limit?: number } = {}): Promise<{
  id: number; productId: number; productName: string; poolId: number; harvestedOn: string; amount: number; amountText: string;
  hives: number | null; moisturePctX10: number | null; note: string | null; batchId: number | null; batchCode: string | null; createdAt: string; createdBy: string;
}[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await all<{ id: number; product_id: number; name: string; pool_id: number; harvested_on: string; qty: number; hives: number | null; moisture_pct_x10: number | null; note: string | null; batch_id: number | null; code: string | null; created_at: string; created_by: string }>(db,
    `SELECT h.id, h.product_id, p.name, h.pool_id, h.harvested_on, h.qty, h.hives, h.moisture_pct_x10, h.note, b.id AS batch_id, b.code,
            h.created_at, h.created_by
       FROM harvests h JOIN products p ON p.id = h.product_id LEFT JOIN batches b ON b.harvest_id = h.id
      WHERE (? IS NULL OR h.product_id = ?) ORDER BY h.harvested_on DESC, h.id DESC LIMIT ?`, opts.productId ?? null, opts.productId ?? null, limit);
  return rows.map((r) => ({
    id: r.id, productId: r.product_id, productName: r.name, poolId: r.pool_id, harvestedOn: r.harvested_on, amount: r.qty,
    amountText: formatPoolAmount(r.qty, 'g'), hives: r.hives, moisturePctX10: r.moisture_pct_x10, note: r.note, batchId: r.batch_id,
    batchCode: r.code, createdAt: r.created_at, createdBy: r.created_by,
  }));
}

// ───────────────────────────── count, adjust ─────────────────────────────

export interface CountDone {
  /** pools whose amount changed: before → after */
  changed: { poolId: number; name: string; before: number; after: number }[];
  /** pools whose tracking this count switched on */
  startedTracking: number[];
  effects: Effects;
}

/**
 * "Count" / "Count all": the owner types the real amount per pool (A3: "this is what I have today").
 * Writes a 'count' move of (typed − current) where they differ, turns tracking on, recomputes on_hand.
 * The difference is worked out inside the batch, so a sale confirmed meanwhile is never lost.
 * `idemKey` (the form's hidden key) makes a double submit a 'conflict' instead of a second count.
 */
export async function countStock(db: D1, actor: Actor, input: { counts: { poolId: number; amount: number }[]; note?: string | null; idemKey?: string }, at: string = nowIso()): Promise<Result<CountDone>> {
  const counts = input?.counts ?? [];
  if (!counts.length) return fail('invalid', 'Enter at least one amount.');
  if (counts.length > 100) return fail('invalid', 'Too many pools in one count.');
  const seen = new Set<number>();
  for (const c of counts) {
    if (!Number.isSafeInteger(c.poolId) || seen.has(c.poolId)) return fail('invalid', 'Each pool can be counted once.', { field: `pool-${c.poolId}` });
    seen.add(c.poolId);
    if (!Number.isSafeInteger(c.amount) || c.amount < 0 || c.amount > MAX_GRAMS) return fail('invalid', 'Amounts must be 0 or more.', { field: `pool-${c.poolId}` });
  }
  const note = input.note?.trim() || null;
  if (note && note.length > 200) return fail('invalid', 'The note is too long (200 characters at most).', { field: 'note' });

  const ids = counts.map((c) => c.poolId);
  const forecast = await forecastStatusChange(db, new Map(counts.map((c) => [c.poolId, { trackStock: true, setOnHand: c.amount }])));
  if (forecast.pools.size !== counts.length) return fail('not_found', 'A stock pool in this count does not exist. Reload the page.');
  const before = new Map([...forecast.pools.values()].map((p) => [p.id, p]));

  const idem = input.idemKey || uuid();
  const by = actor.email;
  const statements: D1Statement[] = counts.map((c) => stmt(db, `INSERT INTO stock_moves (pool_id, delta, reason, idem_key, note, created_at, created_by)
      SELECT ?1, ?2 - t.total, 'count', ?3, ?4, ?5, ?6
        FROM (SELECT COALESCE(SUM(delta), 0) AS total FROM stock_moves WHERE pool_id = ?1) t
       WHERE ?2 - t.total <> 0`, c.poolId, c.amount, `count:${idem}:${c.poolId}`, note, at, by));
  // A double submit is harmless: a count is an absolute amount, so the second one finds no difference and writes
  // no move; if a sale came in between, the repeated per-pool key aborts the batch ('conflict').
  statements.push(stmt(db, `UPDATE stock_pools SET on_hand = (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE pool_id = stock_pools.id),
      track_stock = 1, tracking_since = CASE WHEN track_stock = 1 THEN tracking_since ELSE ? END
    WHERE id IN (SELECT value FROM json_each(?))`, at, JSON.stringify(ids)));
  if (forecast.changed) statements.push(...stockStatusStatements(db, at, by));
  const changedNames = counts.filter((c) => before.get(c.poolId)!.onHand !== c.amount);
  const started = counts.filter((c) => !before.get(c.poolId)!.trackStock).map((c) => c.poolId);
  statements.push(auditInsert(db, {
    at, actor, action: 'stock.count', entity: counts.length === 1 ? 'pool' : 'pools', entityId: ids.join(','),
    summary: `Stock count: ${counts.map((c) => {
      const p = before.get(c.poolId)!;
      return `${p.name} ${formatPoolAmount(c.amount, p.unit)}${p.onHand !== c.amount ? ` (was ${formatPoolAmount(p.onHand, p.unit)})` : ''}`;
    }).join(', ')}`,
    before: Object.fromEntries(counts.map((c) => [c.poolId, before.get(c.poolId)!.onHand])),
    after: Object.fromEntries(counts.map((c) => [c.poolId, c.amount])),
  }));
  const res = await tryBatch(db, statements, { unique: 'This count was already saved. Reload the page to see it.' });
  if (!res.ok) return res;
  return ok({
    changed: changedNames.map((c) => ({ poolId: c.poolId, name: before.get(c.poolId)!.name, before: before.get(c.poolId)!.onHand, after: c.amount })),
    startedTracking: started,
    effects: statusEffects(forecast.changed),
  });
}

const ADJUST_WORDS: Record<AdjustReason, string> = { damage: 'damaged', sample: 'sample or gift', return: 'returned', other: 'other' };

/**
 * "Adjust": damage / sample (take stock out), return (put stock back), other (either way).
 * `delta` is signed, in the pool's unit. Does not switch tracking on (only harvests and counts do).
 */
export async function adjustStock(db: D1, actor: Actor, input: { poolId: number; reason: AdjustReason; delta: number; note?: string | null; idemKey?: string }, at: string = nowIso()): Promise<Result<{ onHand: number; effects: Effects }>> {
  if (!ADJUST_REASONS.includes(input?.reason)) return fail('invalid', 'Choose a reason.', { field: 'reason' });
  if (!Number.isSafeInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > MAX_GRAMS) return fail('invalid', 'Enter an amount.', { field: 'delta' });
  if ((input.reason === 'damage' || input.reason === 'sample') && input.delta > 0) return fail('invalid', 'Damage and samples take stock out.', { field: 'delta' });
  if (input.reason === 'return' && input.delta < 0) return fail('invalid', 'A return puts stock back.', { field: 'delta' });
  const note = input.note?.trim() || null;
  if (note && note.length > 200) return fail('invalid', 'The note is too long (200 characters at most).', { field: 'note' });
  const forecast = await forecastStatusChange(db, new Map([[input.poolId, { delta: input.delta }]]));
  const pool = forecast.pools.get(input.poolId);
  if (!pool) return fail('not_found', 'This stock pool does not exist.', { field: 'poolId' });

  const idem = input.idemKey || uuid();
  const by = actor.email;
  const statements: D1Statement[] = [
    stmt(db, 'INSERT INTO stock_moves (pool_id, delta, reason, idem_key, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.poolId, input.delta, input.reason, `adj:${idem}`, note, at, by),
    recomputePoolsStmt(db, [input.poolId]),
    ...(forecast.changed ? stockStatusStatements(db, at, by) : []),
    auditInsert(db, {
      at, actor, action: 'stock.adjust', entity: 'pool', entityId: input.poolId,
      summary: `${pool.name} ${input.delta > 0 ? '+' : ''}${formatPoolAmount(input.delta, pool.unit)} (${ADJUST_WORDS[input.reason]})${note ? `: ${note}` : ''}`,
      after: { reason: input.reason, delta: input.delta, note },
    }),
    stmt(db, 'SELECT on_hand FROM stock_pools WHERE id = ?', input.poolId),
  ];
  const res = await tryBatch(db, statements, { unique: 'This change was already saved. Reload the page.' });
  if (!res.ok) return res;
  return ok({ onHand: (res.value[res.value.length - 1].results[0] as { on_hand: number }).on_hand, effects: statusEffects(forecast.changed) });
}

// ───────────────────────────── pool settings ─────────────────────────────

async function updatePool(db: D1, actor: Actor, poolId: number, version: number, set: Record<string, unknown>, change: PoolChange,
  action: string, summary: (name: string) => string, at: string,
  /** statements run before the versioned update (they must check the version themselves) */
  before: D1Statement[] = []): Promise<Result<{ version: number; effects: Effects }>> {
  if (!Number.isSafeInteger(version)) return fail('invalid', 'Reload the page and try again.');
  const forecast = await forecastStatusChange(db, new Map([[poolId, change]]));
  const pool = forecast.pools.get(poolId);
  if (!pool) return fail('not_found', 'This stock pool does not exist.');
  const by = actor.email;
  const guard: Guard = { sql: 'EXISTS (SELECT 1 FROM stock_pools WHERE id = ? AND version = ? AND updated_at = ? AND updated_by = ?)', params: [poolId, version + 1, at, by] };
  const statements = [
    ...before,
    versionedUpdate(db, { table: 'stock_pools', key: ['id', poolId], version, set, actor, at }),
    ...(before.length ? [recomputePoolsStmt(db, [poolId], guard)] : []),
    ...(forecast.changed ? stockStatusStatements(db, at, by, guard) : []),
    auditInsert(db, { at, actor, action, entity: 'pool', entityId: poolId, summary: summary(pool.name), after: set }, guard),
  ];
  const res = await batch(db, statements);
  if (res[before.length].meta.changes !== 1) return fail('conflict', 'Someone else changed this pool. Reload the page.');
  return ok({ version: version + 1, effects: statusEffects(forecast.changed) });
}

/**
 * Tracking on/off by hand. Off shows "In stock" on the site and stops alerts.
 * On: a pool that was tracked before keeps its amount; a pool that was never tracked starts from 0 (the same
 * "start tracking" count as the first harvest, so orders confirmed before tracking are not subtracted again, A3).
 */
export async function setTracking(db: D1, actor: Actor, input: { poolId: number; version: number; on: boolean }, at: string = nowIso()) {
  if (typeof input?.on !== 'boolean') return fail('invalid', 'Choose on or off.');
  if (!input.on) {
    return updatePool(db, actor, input.poolId, input.version, { track_stock: 0 }, { trackStock: false },
      'stock.tracking', (n) => `${n}: stock tracking off`, at);
  }
  const cur = await first<{ track_stock: number; tracking_since: string | null }>(db, 'SELECT track_stock, tracking_since FROM stock_pools WHERE id = ?', input.poolId);
  const firstTracking = cur?.track_stock === 0 && cur.tracking_since === null;
  const versionHolds: Guard = { sql: 'EXISTS (SELECT 1 FROM stock_pools WHERE id = ? AND version = ?)', params: [input.poolId, input.version] };
  return updatePool(db, actor, input.poolId, input.version, { track_stock: 1, tracking_since: at },
    firstTracking ? { trackStock: true, setOnHand: 0 } : { trackStock: true },
    'stock.tracking', (n) => `${n}: stock tracking on${firstTracking ? ' (starts from 0)' : ''}`, at,
    firstTracking && Number.isSafeInteger(input.version) ? [startTrackingCountStmt(db, input.poolId, `count:track:${uuid()}:${input.poolId}`, at, actor.email, versionHolds)] : []);
}

/** Low-stock level in the pool's unit (null = no low level) */
export async function setLowLevel(db: D1, actor: Actor, input: { poolId: number; version: number; lowAt: number | null }, at: string = nowIso()) {
  if (input?.lowAt !== null && !(Number.isSafeInteger(input?.lowAt) && input.lowAt >= 0 && input.lowAt <= MAX_GRAMS)) return fail('invalid', 'The low level must be 0 or more.', { field: 'lowAt' });
  return updatePool(db, actor, input.poolId, input.version, { low_at: input.lowAt }, { lowAt: input.lowAt },
    'stock.low_level', (n) => `${n}: low-stock level ${input.lowAt === null ? 'removed' : 'changed'}`, at);
}

/** Availability override (owner only, design §4): 'auto' follows stock, 'in' always available, 'out' sold out */
export async function setAvailability(db: D1, actor: Actor, input: { poolId: number; version: number; availability: AvailabilityOverride }, at: string = nowIso()) {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  if (!['auto', 'in', 'out'].includes(input?.availability)) return fail('invalid', 'Choose Auto, Always available or Sold out.', { field: 'availability' });
  const words = { auto: 'follows stock', in: 'always available', out: 'sold out' } as const;
  return updatePool(db, actor, input.poolId, input.version, { availability: input.availability }, { availability: input.availability },
    'stock.availability', (n) => `${n}: ${words[input.availability]}`, at);
}

// ───────────────────────────── batches ─────────────────────────────

export type BatchStatus = 'active' | 'finished' | 'recalled';

export interface BatchView {
  id: number;
  code: string;
  productId: number;
  productName: string;
  productSlug: string;
  harvestId: number | null;
  harvestedLabel: string;
  packedOn: string;
  bestBefore: string;
  publicNote: string | null;
  privateNote: string | null;
  isPublic: boolean;
  status: BatchStatus;
  version: number;
  /** harvest amount in grams (null for batches without a harvest) */
  harvestAmount: number | null;
  /** rough amount still left from this batch: the pool's stock given to the newest batches first (grams) */
  estimatedLeft: number | null;
  /** 'ok' | 'soon' (within the alert window) | 'passed' */
  bestBeforeState: 'ok' | 'soon' | 'passed';
}

function bestBeforeState(bestBefore: string, today: string, warnDays: number): BatchView['bestBeforeState'] {
  const lastDay = addDays(`${addMonths(bestBefore, 1)}-01`, -1); // best before the end of that month
  if (today > lastDay) return 'passed';
  return addDays(today, warnDays) >= lastDay ? 'soon' : 'ok';
}

/** Batches with an estimated remainder (newest first) */
export async function listBatches(db: D1, opts: { productId?: number; status?: BatchStatus; at?: string } = {}): Promise<BatchView[]> {
  const today = istDate(opts.at ?? nowIso());
  const [rowsRes, alertRes] = await db.batch([
    stmt(db, `SELECT b.id, b.code, b.product_id, p.name, p.slug, b.harvest_id, b.harvested_label, b.packed_on, b.best_before, b.public_note,
        b.private_note, b.is_public, b.status, b.version, h.qty AS harvest_qty, h.pool_id, s.on_hand, s.track_stock, s.unit
      FROM batches b JOIN products p ON p.id = b.product_id LEFT JOIN harvests h ON h.id = b.harvest_id
      LEFT JOIN stock_pools s ON s.id = h.pool_id
      WHERE (?1 IS NULL OR b.product_id = ?1) AND (?2 IS NULL OR b.status = ?2)
      ORDER BY b.packed_on DESC, b.id DESC`, opts.productId ?? null, opts.status ?? null),
    stmt(db, "SELECT value FROM settings WHERE key = 'alerts'"),
  ]);
  const warnDays = (() => {
    try { return (JSON.parse((alertRes.results[0] as { value: string }).value) as { bestBeforeWarnDays: number }).bestBeforeWarnDays; } catch { return 60; }
  })();
  type R = { id: number; code: string; product_id: number; name: string; slug: string; harvest_id: number | null; harvested_label: string; packed_on: string; best_before: string; public_note: string | null; private_note: string | null; is_public: number; status: BatchStatus; version: number; harvest_qty: number | null; pool_id: number | null; on_hand: number | null; track_stock: number | null; unit: PoolUnit | null };
  const rows = rowsRes.results as unknown as R[];
  // estimate: per pool, give the stock on hand to the newest active batches first
  const left = new Map<number, number>();
  for (const r of rows) {
    if (r.pool_id === null || r.harvest_qty === null || r.status !== 'active' || r.track_stock !== 1) continue;
    if (!left.has(r.pool_id)) left.set(r.pool_id, Math.max(0, r.on_hand ?? 0));
  }
  const remaining = new Map(left);
  const estimate = new Map<number, number>();
  for (const r of rows) { // already newest first
    if (r.pool_id === null || r.harvest_qty === null || !remaining.has(r.pool_id) || r.status !== 'active') continue;
    const take = Math.min(r.harvest_qty, remaining.get(r.pool_id)!);
    estimate.set(r.id, take);
    remaining.set(r.pool_id, remaining.get(r.pool_id)! - take);
  }
  return rows.map((r) => ({
    id: r.id, code: r.code, productId: r.product_id, productName: r.name, productSlug: r.slug, harvestId: r.harvest_id,
    harvestedLabel: r.harvested_label, packedOn: r.packed_on, bestBefore: r.best_before, publicNote: r.public_note,
    privateNote: r.private_note, isPublic: r.is_public === 1, status: r.status, version: r.version, harvestAmount: r.harvest_qty,
    estimatedLeft: r.status === 'active' ? (estimate.get(r.id) ?? null) : 0,
    bestBeforeState: bestBeforeState(r.best_before, today, warnDays),
  }));
}

/** One batch, or null */
export async function getBatch(db: D1, id: number): Promise<BatchView | null> {
  return (await listBatches(db)).find((b) => b.id === id) ?? null;
}

function checkBatchFields(f: { code?: string | null; packedOn?: string; bestBefore?: string; publicNote?: string | null; privateNote?: string | null; harvestedLabel?: string }): ReturnType<typeof fail> | null {
  if (f.code !== undefined) {
    if (!f.code || f.code.length < 3 || f.code.length > 24 || batchKey(f.code).length < 3) return fail('invalid', 'The batch code needs 3–24 letters and numbers, e.g. MUR-2611-01.', { field: 'batch.code' });
  }
  if (f.packedOn !== undefined && !isDate(f.packedOn)) return fail('invalid', 'The packed date must look like 2026-11-15.', { field: 'batch.packedOn' });
  if (f.bestBefore !== undefined && !isMonth(f.bestBefore)) return fail('invalid', 'Best before must be a month like 2028-11.', { field: 'batch.bestBefore' });
  if (f.packedOn !== undefined && f.bestBefore !== undefined && isDate(f.packedOn) && f.bestBefore < f.packedOn.slice(0, 7)) return fail('invalid', 'Best before cannot be before the packed date.', { field: 'batch.bestBefore' });
  if (f.publicNote && f.publicNote.trim().length > 200) return fail('invalid', 'The public note is too long (200 characters at most).', { field: 'batch.publicNote' });
  if (f.privateNote && f.privateNote.trim().length > 500) return fail('invalid', 'The private note is too long (500 characters at most).', { field: 'batch.privateNote' });
  if (f.harvestedLabel !== undefined && !(f.harvestedLabel.trim().length >= 3 && f.harvestedLabel.trim().length <= 40)) return fail('invalid', 'Write when it was harvested, e.g. October 2026.', { field: 'batch.harvestedLabel' });
  return null;
}

/** A batch without a harvest (e.g. honey harvested before the portal); stock is not changed */
export async function createBatch(db: D1, actor: Actor, input: {
  productId: number; code?: string; harvestedLabel: string; packedOn: string; bestBefore: string;
  isPublic?: boolean; publicNote?: string | null; privateNote?: string | null;
}, at: string = nowIso()): Promise<Result<{ id: number; code: string; effects: Effects }>> {
  const p = await first<{ status: string }>(db, 'SELECT status FROM products WHERE id = ?', input?.productId);
  if (!p) return fail('not_found', 'This product does not exist.', { field: 'productId' });
  const code = input.code ? cleanCode(input.code) : await suggestBatchCode(db, input.productId, input.packedOn);
  const problem = checkBatchFields({ code, packedOn: input.packedOn, bestBefore: input.bestBefore, publicNote: input.publicNote, privateNote: input.privateNote, harvestedLabel: input.harvestedLabel ?? '' });
  if (problem) return problem;
  const key = batchKey(code!);
  const isPublic = input.isPublic ?? true;
  const publicNow = isPublic && p.status !== 'draft';
  const by = actor.email;
  const res = await tryBatch(db, [
    stmt(db, `INSERT INTO batches (code, code_key, product_id, harvest_id, harvested_label, packed_on, best_before, public_note, private_note,
        is_public, status, version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
    code, key, input.productId, input.harvestedLabel.trim(), input.packedOn, input.bestBefore, input.publicNote?.trim() || null,
    input.privateNote?.trim() || null, isPublic, at, by, at, by),
    ...(publicNow ? [bumpVersionStmt(db, 'site_version', at, by)] : []),
    stmt(db, `INSERT INTO audit_log (at, actor, action, entity, entity_id, summary)
      SELECT ?, ?, 'batch.create', 'batch', CAST(id AS TEXT), ? FROM batches WHERE code_key = ?`, at, by, `New batch ${code}`, key),
    stmt(db, 'SELECT id FROM batches WHERE code_key = ?', key),
  ], { unique: `Batch code ${code} is already used. Choose another.` });
  if (!res.ok) return { ...res, field: 'batch.code' };
  return ok({ id: (res.value[res.value.length - 1].results[0] as { id: number }).id, code: code!, effects: { publish: publicNow ? 'now' : null, live: false } });
}

/**
 * Edits a batch (code, dates, notes, Show in Know Your Jar, status). Version-checked.
 * A change to what Know Your Jar shows bumps site_version and asks for a publish.
 */
export async function updateBatch(db: D1, actor: Actor, input: {
  id: number; version: number; code?: string; harvestedLabel?: string; packedOn?: string; bestBefore?: string;
  publicNote?: string | null; privateNote?: string | null; isPublic?: boolean; status?: BatchStatus;
}, at: string = nowIso()): Promise<Result<{ version: number; effects: Effects }>> {
  const cur = await first<{ id: number; code: string; code_key: string; packed_on: string; best_before: string; is_public: number; status: BatchStatus; public_note: string | null; harvested_label: string; product_status: string }>(db,
    `SELECT b.id, b.code, b.code_key, b.packed_on, b.best_before, b.is_public, b.status, b.public_note, b.harvested_label, p.status AS product_status
       FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?`, input?.id);
  if (!cur) return fail('not_found', 'This batch does not exist.');
  if (input.status !== undefined && !['active', 'finished', 'recalled'].includes(input.status)) return fail('invalid', 'Unknown batch status.', { field: 'batch.status' });
  const code = input.code !== undefined ? cleanCode(input.code) : undefined;
  const problem = checkBatchFields({ code, packedOn: input.packedOn ?? cur.packed_on, bestBefore: input.bestBefore ?? cur.best_before, publicNote: input.publicNote, privateNote: input.privateNote, harvestedLabel: input.harvestedLabel });
  if (problem) return problem;
  const set: Record<string, unknown> = {};
  if (code !== undefined) { set.code = code; set.code_key = batchKey(code); }
  if (input.harvestedLabel !== undefined) set.harvested_label = input.harvestedLabel.trim();
  if (input.packedOn !== undefined) set.packed_on = input.packedOn;
  if (input.bestBefore !== undefined) set.best_before = input.bestBefore;
  if (input.publicNote !== undefined) set.public_note = input.publicNote?.trim() || null;
  if (input.privateNote !== undefined) set.private_note = input.privateNote?.trim() || null;
  if (input.isPublic !== undefined) set.is_public = input.isPublic ? 1 : 0;
  if (input.status !== undefined) set.status = input.status;
  if (!Object.keys(set).length) return ok({ version: input.version, effects: { publish: null, live: false } });
  const wasShown = cur.is_public === 1 && cur.status !== 'recalled';
  const isShown = (input.isPublic ?? cur.is_public === 1) && (input.status ?? cur.status) !== 'recalled';
  const publicFields = ['code', 'harvested_label', 'packed_on', 'best_before', 'public_note'].some((k) => k in set);
  const site = cur.product_status !== 'draft' && (wasShown !== isShown || (isShown && publicFields));
  const by = actor.email;
  const guard: Guard = { sql: 'EXISTS (SELECT 1 FROM batches WHERE id = ? AND version = ? AND updated_at = ? AND updated_by = ?)', params: [cur.id, input.version + 1, at, by] };
  const res = await tryBatch(db, [
    versionedUpdate(db, { table: 'batches', key: ['id', cur.id], version: input.version, set, actor, at }),
    ...(site ? [bumpVersionStmt(db, 'site_version', at, by, guard)] : []),
    auditInsert(db, {
      at, actor, action: 'batch.update', entity: 'batch', entityId: cur.id,
      summary: `Batch ${code ?? cur.code}: ${input.isPublic === false ? 'hidden from Know Your Jar' : input.isPublic === true && cur.is_public === 0 ? 'shown in Know Your Jar' : input.status && input.status !== cur.status ? `marked ${input.status}` : 'details changed'}`,
      before: { code: cur.code, packedOn: cur.packed_on, bestBefore: cur.best_before, isPublic: cur.is_public === 1, status: cur.status },
      after: set,
    }, guard),
  ], { unique: `Batch code ${code} is already used. Choose another.` });
  if (!res.ok) return { ...res, field: res.error === 'conflict' ? 'batch.code' : undefined };
  if (res.value[0].meta.changes !== 1) return fail('conflict', 'Someone else changed this batch. Reload the page.');
  return ok({ version: input.version + 1, effects: { publish: site ? 'now' : null, live: false } });
}

/** Show or hide a batch in Know Your Jar */
export async function setBatchPublic(db: D1, actor: Actor, input: { id: number; version: number; isPublic: boolean }, at: string = nowIso()) {
  if (typeof input?.isPublic !== 'boolean') return fail('invalid', 'Choose show or hide.');
  return updateBatch(db, actor, { id: input.id, version: input.version, isPublic: input.isPublic }, at);
}

// ───────────────────────────── alerts ─────────────────────────────

export interface StockAlerts {
  /** tracked pools that are negative, empty or low (worst first) */
  pools: { poolId: number; name: string; level: 'negative' | 'empty' | 'low'; amountText: string }[];
  /** active batches whose best-before is near or passed */
  bestBefore: { batchId: number; code: string; productName: string; bestBefore: string; state: 'soon' | 'passed' }[];
}

/** Stock alerts for Today: low / sold out / negative pools and best-before warnings */
export async function stockAlerts(db: D1, at: string = nowIso()): Promise<StockAlerts> {
  const [pools, batches] = await Promise.all([listPools(db), listBatches(db, { status: 'active', at })]);
  const order = { negative: 0, empty: 1, low: 2 } as const;
  return {
    pools: pools.filter((p) => p.level === 'negative' || p.level === 'empty' || p.level === 'low')
      .map((p) => ({ poolId: p.id, name: p.name, level: p.level as 'negative' | 'empty' | 'low', amountText: p.amountText }))
      .sort((a, b) => order[a.level] - order[b.level] || a.name.localeCompare(b.name)),
    bestBefore: batches.filter((b) => b.bestBeforeState !== 'ok')
      .map((b) => ({ batchId: b.id, code: b.code, productName: b.productName, bestBefore: b.bestBefore, state: b.bestBeforeState as 'soon' | 'passed' })),
  };
}
