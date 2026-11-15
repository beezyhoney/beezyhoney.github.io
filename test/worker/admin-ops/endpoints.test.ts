// The ops JSON / file endpoints and server modules on real workerd D1 + KV (Miniflare): status chip, order search,
// CSV export, paged dump, backup download, plus a manual order → confirm → pay → deliver → sales → invoice run.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import seedSql from '../../../db/seed.sql?raw';
import { GET as statusGet } from '../../../src/pages/admin/api/status.json';
import { GET as searchGet } from '../../../src/pages/admin/api/orders/search.json';
import { GET as exportGet } from '../../../src/pages/admin/api/export/[name].csv';
import { GET as dumpGet } from '../../../src/pages/admin/api/dump.json';
import { GET as backupGet } from '../../../src/pages/admin/api/backups/[date].json';
import { addPayment, advanceOrder, confirmOrder, createManualOrder } from '../../../src/server/orders';
import { makeInvoice } from '../../../src/server/invoice';
import { exportCsv, monthToDate } from '../../../src/server/sales';
import { salesTotals } from '../../../src/server/sales-queries';
import { backupTick } from '../../../src/server/backup';
import { readBundle } from '../../../src/server/backup-format.mjs';
import { dumpPage } from '../../../src/admin/ops/system';
import { addHelper, updateHelper } from '../../../src/admin/ops/people';

const OWNER = { email: 'owner@example.test', role: 'owner' as const };
const HELPER = { email: 'helper@example.test', role: 'helper' as const };
const AT = '2026-11-15T04:30:00Z';

/** Calls an endpoint's GET like Astro would (only what our handlers read) */
function call(handler: (ctx: never) => Response | Promise<Response>, url: string, admin: typeof OWNER | typeof HELPER | undefined, params: Record<string, string> = {}) {
  return handler({ url: new URL(url, 'http://127.0.0.1/'), params, locals: { admin }, request: new Request(new URL(url, 'http://127.0.0.1/')) } as never);
}

let orderId = 0;
let ref = '';

beforeAll(async () => {
  const body = seedSql.split('\n').filter((l) => !l.startsWith('--')).join('\n');
  const statements = body.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  const v = await env.DB.prepare("SELECT id FROM variants WHERE code = 'murungai-honey:250g'").first<{ id: number }>();
  const made = await createManualOrder(env.DB, OWNER, { channel: 'phone', lines: [{ variantId: v!.id, qty: 3 }], customer: { name: 'Kavya', phone: '98765 43210' } }, AT);
  if (!made.ok) throw new Error(made.message);
  orderId = made.value.id;
  ref = made.value.ref;
});

describe('order flow on real D1', () => {
  it('confirm → pay → deliver → counts in sales → invoice BZ/2026-27/0001', async () => {
    const c = await confirmOrder(env.DB, OWNER, { id: orderId, version: 1 }, AT);
    expect(c.ok).toBe(true);
    const move = await env.DB.prepare('SELECT delta, reason FROM stock_moves WHERE order_id = ?').bind(orderId).first();
    expect(move).toEqual({ delta: -750, reason: 'sale' });
    const p = await addPayment(env.DB, OWNER, { id: orderId, amountPaise: 93000, method: 'upi', idemKey: 'k1' }, AT);
    expect(p).toMatchObject({ ok: true, value: { balancePaise: 0 } });
    expect((await advanceOrder(env.DB, OWNER, { id: orderId, version: 2, to: 'delivered' }, AT)).ok).toBe(true);
    const totals = await salesTotals(env.DB, monthToDate(AT).current);
    expect(totals).toMatchObject({ orders: 1, netPaise: 93000, grams: 750, collectedPaise: 93000, outstandingPaise: 0 });
    expect(await makeInvoice(env.DB, OWNER, { id: orderId }, AT)).toMatchObject({ ok: true, value: { invoiceNo: 'BZ/2026-27/0001' } });
    const csv = await exportCsv(env.DB, 'monthly_by_product', { from: '2026-11-01', to: '2026-11-30' }, AT);
    expect(csv.csv).toContain('Murungai Honey,250 g,murungai-honey:250g,1,3,930.00,0.750');
  });

  it('helpers can be added and switched off on D1', async () => {
    expect((await addHelper(env.DB, OWNER, { email: 'amma@example.test' }, AT)).ok).toBe(true);
    expect(await updateHelper(env.DB, OWNER, { email: 'amma@example.test', version: 1, active: false }, AT)).toEqual({ ok: true, value: { version: 2 } });
  });
});

describe('/admin/api endpoints', () => {
  it('status.json: chip shape, no-store, 401 without a login', async () => {
    const r = await call(statusGet as never, '/admin/api/status.json', HELPER);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = await r.json() as { website: { state: string; siteVersion: number }; health: { db: boolean } };
    expect(j.website.state).toBe('disabled'); // no deploy hook in tests
    expect(j.health.db).toBe(true);
    expect((await call(statusGet as never, '/admin/api/status.json', undefined)).status).toBe(401);
  });

  it('orders/search.json finds by the last letters of the code', async () => {
    const r = await call(searchGet as never, `/admin/api/orders/search.json?q=${ref.slice(-3)}`, HELPER);
    const j = await r.json() as { results: { id: number; ref: string; href: string }[] };
    expect(j.results.map((x) => x.id)).toContain(orderId);
    expect(j.results[0].href).toBe(`/admin/orders/${j.results[0].id}/`);
  });

  it('export csv: owner only, attachment, customer details only when asked', async () => {
    expect((await call(exportGet as never, '/admin/api/export/orders.csv', HELPER, { name: 'orders' })).status).toBe(403);
    expect((await call(exportGet as never, '/admin/api/export/x.csv', OWNER, { name: 'x' })).status).toBe(404);
    const r = await call(exportGet as never, '/admin/api/export/orders.csv', OWNER, { name: 'orders' });
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="beezy-orders-all-\d{4}-\d{2}-\d{2}\.csv"$/);
    const plain = await r.text();
    expect(plain).toContain(ref);
    expect(plain).not.toContain('Kavya');
    const personal = await (await call(exportGet as never, '/admin/api/export/orders.csv?personal=1', OWNER, { name: 'orders' })).text();
    expect(personal).toContain('Kavya');
  });

  it('dump.json: owner only, table list with counts, pages that add up', async () => {
    expect((await call(dumpGet as never, '/admin/api/dump.json', HELPER)).status).toBe(403);
    const meta = await (await call(dumpGet as never, '/admin/api/dump.json', OWNER)).json() as { tables: string[]; counts: Record<string, number>; migrations: string[] };
    expect(meta.tables).toContain('orders');
    expect(meta.tables).not.toContain('admin_sessions');
    expect(meta.counts.variants).toBe(47);
    expect(meta.migrations).toEqual(['0001_init.sql']);
    let after = 0;
    let rows = 0;
    for (;;) {
      const page = await dumpPage(env.DB, 'images', after, 50);
      rows += page!.rows.length;
      if (page!.next === null) break;
      after = page!.next;
    }
    expect(rows).toBe(meta.counts.images);
    expect((await call(dumpGet as never, '/admin/api/dump.json?table=login_codes', OWNER)).status).toBe(404);
    const empty = await dumpPage(env.DB, 'harvests');
    expect(empty?.columns).toContain('pool_id');
  });

  it('backups/<date>.json: a finished KV backup downloads as one restorable file', async () => {
    let state = '';
    for (let i = 0; i < 6 && state !== 'finished'; i++) state = (await backupTick({ DB: env.DB, BACKUPS: env.BACKUPS }, AT, { force: true })).state;
    expect(state).toBe('finished');
    expect((await call(backupGet as never, '/admin/api/backups/2026-11-15.json', HELPER, { date: '2026-11-15' })).status).toBe(403);
    expect((await call(backupGet as never, '/admin/api/backups/2026-11-14.json', OWNER, { date: '2026-11-14' })).status).toBe(404);
    expect((await call(backupGet as never, '/admin/api/backups/x.json', OWNER, { date: 'x' })).status).toBe(404);
    const r = await call(backupGet as never, '/admin/api/backups/2026-11-15.json', OWNER, { date: '2026-11-15' });
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="beezy-backup-2026-11-15.json"');
    const tables = readBundle(await r.json());
    expect(tables.find((t: { name: string }) => t.name === 'orders')?.rows.length).toBe(1);
  });
});
