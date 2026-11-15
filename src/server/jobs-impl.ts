// The scheduled work, called by src/server/jobs.ts (cron every 15 minutes, and lazily from admin page loads).
// Every job decides from D1 whether it is due, so running too often is harmless:
// - publish-if-due  every tick: fires a debounced automatic publish (stock-status changes)
// - backup          every tick from 02:30 IST until today's backup is complete (one chunk per tick)
// - cleanup         once per IST day: IP hashes after 30 days, expired login codes / sessions / rate buckets,
//                   phone + address (and, without an invoice, name + city and the gift card text) of orders
//                   delivered or cancelled more than privacy.clearCustomerAfterMonths ago
// - reconcile       once a week: pools' on_hand vs SUM(stock_moves.delta), orders' paid vs SUM(payments) and
//                   items total vs SUM(lines); any mismatch turns Help → Self-check red
// A job that throws is recorded in job_runs (ok = 0) and never stops the others.
import { type D1, all, first, stmt } from './db';
import { backupTick, lastBackup, type BackupTickResult } from './backup';
import type { KVLike } from './media';
import { publishIfDue, type WaitCtx } from './publish';
import { addMonths, addTime, istDate, nowIso } from './time';

export interface JobsEnv { DB: D1; BACKUPS?: KVLike; DEPLOY_HOOK_URL?: string }

export type JobName = 'publish' | 'backup' | 'cleanup' | 'reconcile';

export interface JobsResult {
  /** jobs that did work in this run */
  ran: JobName[];
  /** what each job reported (or its error) */
  results: Partial<Record<JobName, unknown>>;
}

const IP_HASH_DAYS = 30;
const RECONCILE_EVERY_DAYS = 7;

async function record(db: D1, job: JobName, at: string, ok: boolean, detail: unknown): Promise<void> {
  await stmt(db, 'INSERT INTO job_runs (job, started_at, finished_at, ok, detail_json) VALUES (?, ?, ?, ?, ?)', job, at, at, ok, JSON.stringify(detail ?? null)).run();
}

/** Has `job` run (successfully) at or after `since`? */
async function ranSince(db: D1, job: JobName, since: string): Promise<boolean> {
  return (await first(db, 'SELECT 1 AS x FROM job_runs WHERE job = ? AND ok = 1 AND started_at >= ? LIMIT 1', job, since)) !== null;
}

/** Start of the IST day of `at`, as a UTC timestamp */
const istDayStart = (at: string) => `${new Date(Date.parse(`${istDate(at)}T00:00:00Z`) - 330 * 60_000).toISOString().slice(0, 19)}Z`;

export interface CleanupResult { ipHashesCleared: number; loginCodes: number; sessions: number; rateBuckets: number; customersCleared: number }

/** The daily privacy and housekeeping clean-up (also callable on its own) */
export async function runCleanup(db: D1, at: string = nowIso()): Promise<CleanupResult> {
  const privacy = await first<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'privacy'");
  const months = privacy ? (JSON.parse(privacy.value) as { clearCustomerAfterMonths: number }).clearCustomerAfterMonths : 24;
  const day = istDate(at);
  const cutoff = `${addMonths(day.slice(0, 7), -months)}-${day.slice(8)}T00:00:00Z`;
  const res = await db.batch([
    stmt(db, 'UPDATE orders SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?', addTime(at, { days: -IP_HASH_DAYS })),
    stmt(db, 'DELETE FROM login_codes WHERE expires_at < ?', addTime(at, { days: -1 })),
    stmt(db, 'DELETE FROM admin_sessions WHERE expires_at < ?', at),
    stmt(db, 'DELETE FROM rate_limits WHERE expires_at < ?', at),
    stmt(db, `UPDATE orders SET customer_phone = NULL, customer_address = NULL,
        customer_name = CASE WHEN invoice_no IS NULL THEN NULL ELSE customer_name END,
        customer_city = CASE WHEN invoice_no IS NULL THEN NULL ELSE customer_city END,
        gift_json = CASE WHEN gift_json IS NULL THEN NULL ELSE json_set(gift_json, '$.card', NULL) END,
        personal_cleared_at = ?1
      WHERE personal_cleared_at IS NULL AND status IN ('delivered', 'cancelled')
        AND COALESCE(delivered_at, cancelled_at) < ?2`, at, cutoff),
  ]);
  return {
    ipHashesCleared: res[0].meta.changes, loginCodes: res[1].meta.changes, sessions: res[2].meta.changes,
    rateBuckets: res[3].meta.changes, customersCleared: res[4].meta.changes,
  };
}

export interface ReconcileResult {
  ok: boolean;
  pools: { poolId: number; name: string; cached: number; ledger: number }[];
  paid: { orderId: number; ref: string; cached: number; ledger: number }[];
  totals: { orderId: number; ref: string; cached: number; lines: number }[];
}

/** Compares the caches with their ledgers. `repair` rewrites the caches from the ledgers (developer use). */
export async function runReconcile(db: D1, opts: { repair?: boolean } = {}): Promise<ReconcileResult> {
  const [pools, paid, totals] = await db.batch([
    stmt(db, `SELECT s.id, s.name, s.on_hand, COALESCE((SELECT SUM(m.delta) FROM stock_moves m WHERE m.pool_id = s.id), 0) AS ledger
      FROM stock_pools s WHERE s.on_hand <> COALESCE((SELECT SUM(m.delta) FROM stock_moves m WHERE m.pool_id = s.id), 0)`),
    stmt(db, `SELECT o.id, o.ref, o.paid_paise, COALESCE((SELECT SUM(p.amount_paise) FROM payments p WHERE p.order_id = o.id), 0) AS ledger
      FROM orders o WHERE o.paid_paise <> COALESCE((SELECT SUM(p.amount_paise) FROM payments p WHERE p.order_id = o.id), 0)`),
    stmt(db, `SELECT o.id, o.ref, o.items_total_paise, COALESCE((SELECT SUM(l.line_total_paise) FROM order_lines l WHERE l.order_id = o.id), 0) AS lines
      FROM orders o WHERE o.items_total_paise <> COALESCE((SELECT SUM(l.line_total_paise) FROM order_lines l WHERE l.order_id = o.id), 0)`),
  ]);
  const out: ReconcileResult = {
    ok: !pools.results.length && !paid.results.length && !totals.results.length,
    pools: (pools.results as { id: number; name: string; on_hand: number; ledger: number }[]).map((r) => ({ poolId: r.id, name: r.name, cached: r.on_hand, ledger: r.ledger })),
    paid: (paid.results as { id: number; ref: string; paid_paise: number; ledger: number }[]).map((r) => ({ orderId: r.id, ref: r.ref, cached: r.paid_paise, ledger: r.ledger })),
    totals: (totals.results as { id: number; ref: string; items_total_paise: number; lines: number }[]).map((r) => ({ orderId: r.id, ref: r.ref, cached: r.items_total_paise, lines: r.lines })),
  };
  if (opts.repair && !out.ok) {
    await db.batch([
      stmt(db, 'UPDATE stock_pools SET on_hand = (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE pool_id = stock_pools.id)'),
      stmt(db, 'UPDATE orders SET paid_paise = (SELECT COALESCE(SUM(amount_paise), 0) FROM payments WHERE order_id = orders.id)'),
    ]);
  }
  return out;
}

/**
 * Runs every job that is due. Never throws; errors are recorded per job. `force` names jobs to run even when they
 * are not due (e.g. ['backup'] for "Back up now").
 */
export async function runDueJobsImpl(env: JobsEnv, ctx: WaitCtx, opts: { at?: string; force?: JobName[] } = {}): Promise<JobsResult> {
  const at = opts.at ?? nowIso();
  const force = new Set(opts.force ?? []);
  const out: JobsResult = { ran: [], results: {} };
  const attempt = async (job: JobName, fn: () => Promise<{ did: boolean; result: unknown }>) => {
    try {
      const { did, result } = await fn();
      if (did) out.ran.push(job);
      out.results[job] = result;
    } catch (e) {
      out.results[job] = { error: String((e as Error)?.message ?? e) };
      try { await record(env.DB, job, at, false, out.results[job]); } catch { /* D1 itself is failing */ }
    }
  };

  await attempt('publish', async () => {
    const r = await publishIfDue(env, ctx, at);
    const did = r.state === 'requested';
    if (did) await record(env.DB, 'publish', at, true, r);
    return { did, result: r };
  });

  if (env.BACKUPS) {
    await attempt('backup', async () => {
      const r: BackupTickResult = await backupTick({ DB: env.DB, BACKUPS: env.BACKUPS! }, at, { force: force.has('backup') });
      return { did: r.state === 'progress' || r.state === 'finished', result: r };
    });
  }

  await attempt('cleanup', async () => {
    if (!force.has('cleanup') && (await ranSince(env.DB, 'cleanup', istDayStart(at)))) return { did: false, result: { state: 'done_today' } };
    const r = await runCleanup(env.DB, at);
    await record(env.DB, 'cleanup', at, true, r);
    return { did: true, result: r };
  });

  await attempt('reconcile', async () => {
    if (!force.has('reconcile') && (await ranSince(env.DB, 'reconcile', addTime(at, { days: -RECONCILE_EVERY_DAYS })))) return { did: false, result: { state: 'not_due' } };
    // the run itself succeeded (ok = 1); a mismatch is reported in detail_json.mismatch for the self-check
    const r = await runReconcile(env.DB);
    await record(env.DB, 'reconcile', at, true, { ...r, mismatch: !r.ok });
    return { did: true, result: r };
  });

  return out;
}

export interface SelfCheck {
  d1: boolean;
  lastBackup: { date: string; finishedAt: string } | null;
  backupStale: boolean;
  lastRuns: Record<JobName, { at: string; ok: boolean | null } | null>;
  reconcile: { at: string; mismatch: boolean } | null;
  publishing: 'on' | 'off';
}

/** Help → Self-check: D1 reachable, last backup, last run of each job, last reconcile result, publishing configured */
export async function selfCheck(env: JobsEnv, at: string = nowIso(), staleDays = 2): Promise<SelfCheck> {
  let d1 = true;
  try { await first(env.DB, 'SELECT 1 AS x'); } catch { d1 = false; }
  if (!d1) return { d1, lastBackup: null, backupStale: true, lastRuns: { publish: null, backup: null, cleanup: null, reconcile: null }, reconcile: null, publishing: env.DEPLOY_HOOK_URL ? 'on' : 'off' };
  const runs = await all<{ job: JobName; at: string; ok: number | null }>(env.DB,
    'SELECT job, MAX(started_at) AS at, ok FROM job_runs GROUP BY job');
  const lastRuns = { publish: null, backup: null, cleanup: null, reconcile: null } as SelfCheck['lastRuns'];
  for (const r of runs) lastRuns[r.job] = { at: r.at, ok: r.ok === null ? null : r.ok === 1 };
  const rec = await first<{ started_at: string; detail_json: string }>(env.DB, "SELECT started_at, detail_json FROM job_runs WHERE job = 'reconcile' ORDER BY id DESC LIMIT 1");
  const lb = await lastBackup(env.DB);
  return {
    d1,
    lastBackup: lb,
    backupStale: !lb || lb.finishedAt < addTime(at, { days: -staleDays }),
    lastRuns,
    reconcile: rec ? { at: rec.started_at, mismatch: Boolean((JSON.parse(rec.detail_json) as { mismatch?: boolean }).mismatch) } : null,
    publishing: env.DEPLOY_HOOK_URL?.trim() ? 'on' : 'off',
  };
}
