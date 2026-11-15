import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, test } from 'vitest';
import { BACKUP_TABLES, applyRetention, backupTick, backupToSql, daysToKeep, lastBackup, listBackups, manifestKey, readBackup, readBundle } from '../../../src/server/backup';
import { addPayment, confirmOrder, createManualOrder } from '../../../src/server/orders';
import { addHarvest } from '../../../src/server/stock';
import { recordOrder } from '../../../src/server/intake';
import { FakeKV } from '../../helpers/fake-kv';
import { OWNER, ROOT, freshDb, pool, rows, t } from '../../helpers/db';

const tmp = mkdtempSync(join(tmpdir(), 'beezy-backup-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function busyDb() {
  const db = await freshDb();
  const mur = await pool(db, 'murungai-honey');
  await addHarvest(db, OWNER, { poolId: mur.id, harvestedOn: '2026-11-14', amount: 50_000, note: "Owner's note with 'quotes'" }, t(0));
  for (let i = 0; i < 12; i++) {
    const r = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'murungai-honey:250g', qty: 1 + (i % 3) }], customer: { name: `Customer ${i}`, city: 'Chennai' } }, t(i));
    if (!r.ok) throw new Error(r.message);
    if (i % 2) {
      await confirmOrder(db, OWNER, { id: r.value.id, version: 1 }, t(i));
      await addPayment(db, OWNER, { id: r.value.id, amountPaise: 10050, method: 'upi', reference: 'ref ✓ ₹' }, t(i));
    }
  }
  await recordOrder(db, { v: 1, ref: 'BZ-7K3QD', key: 'f'.repeat(32), src: 'cart', shown: 31000, lv: 1, items: [{ c: 'murungai-honey:250g', s: 'murungai-honey', p: '250 g', q: 1 }] }, { ip: '203.0.113.9', ipHashKey: 'k', at: t(20) });
  return db;
}

async function dump(db: Awaited<ReturnType<typeof freshDb>>) {
  const out: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) out[table] = await rows(db, `SELECT * FROM ${table} ORDER BY rowid`);
  return out;
}

describe('daily backup into KV', () => {
  test('waits until 02:30 IST, then writes small chunks, the manifest last, and finishes once a day', async () => {
    const db = await busyDb();
    const kv = new FakeKV();
    expect(await backupTick({ DB: db, BACKUPS: kv }, '2026-11-15T20:00:00Z')).toEqual({ state: 'not_due' }); // 01:30 IST on the 16th
    const steps = [];
    let at = Date.parse('2026-11-15T21:00:00Z'); // 02:30 IST
    for (let i = 0; i < 50; i++) {
      const r = await backupTick({ DB: db, BACKUPS: kv }, `${new Date(at).toISOString().slice(0, 19)}Z`, { maxRows: 40, pageSize: 25 });
      steps.push(r.state);
      if (r.state === 'finished') break;
      at += 15 * 60_000;
    }
    expect(steps.at(-1)).toBe('finished');
    expect(steps.filter((s) => s === 'progress').length).toBeGreaterThan(3);
    expect(await backupTick({ DB: db, BACKUPS: kv }, `${new Date(at + 60_000).toISOString().slice(0, 19)}Z`)).toEqual({ state: 'done_today', date: '2026-11-16' });
    const manifest = JSON.parse(new TextDecoder().decode(kv.data.get(manifestKey('2026-11-16'))!.value));
    expect(manifest.chunks.length).toBe(kv.ops.writes - 1); // one write per chunk + the manifest
    expect(manifest.tables.orders).toBe(13);
    expect(manifest.tables.variants).toBe(47);
    expect(Object.keys(manifest.tables)).toEqual([...BACKUP_TABLES]);
    expect(await lastBackup(db)).toMatchObject({ date: '2026-11-16' });
    expect((await listBackups({ DB: db, BACKUPS: kv })).map((m) => m.date)).toEqual(['2026-11-16']);
  });

  test('backup → restore SQL → fresh database gives the same rows (round trip)', async () => {
    const db = await busyDb();
    const kv = new FakeKV();
    let r;
    let i = 0;
    do { r = await backupTick({ DB: db, BACKUPS: kv }, t(i++), { force: true, maxRows: 60 }); } while (r.state !== 'finished' && i < 100);
    const bundle = await readBackup({ DB: db, BACKUPS: kv }, '2026-11-15');
    expect(bundle).not.toBeNull();
    expect(readBundle(bundle!).find((x) => x.name === 'orders')!.rows).toHaveLength(13);
    const sql = backupToSql(bundle!);
    const target = await freshDb({ seed: false });
    await target.exec(sql);
    expect(await dump(target)).toEqual(await dump(db));
    // restoring over an existing (seeded, changed) database replaces everything
    const other = await freshDb();
    await other.prepare("UPDATE variants SET price_paise = 99900 WHERE code = 'murungai-honey:250g'").run();
    await other.exec(sql);
    expect(await dump(other)).toEqual(await dump(db));
    expect(await rows(other, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('scripts/restore-backup.mjs reads a bundle file or a folder, and refuses to write into the repository', async () => {
    const db = await busyDb();
    const kv = new FakeKV();
    let r;
    do { r = await backupTick({ DB: db, BACKUPS: kv }, t(0), { force: true }); } while (r.state !== 'finished');
    const bundle = (await readBackup({ DB: db, BACKUPS: kv }, '2026-11-15'))!;
    const file = join(tmp, 'backup.json');
    writeFileSync(file, JSON.stringify(bundle));
    const folder = join(tmp, 'folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(bundle.manifest));
    bundle.chunks.forEach((c, i) => writeFileSync(join(folder, bundle.manifest.chunks[i].split('/').pop()!), JSON.stringify(c)));
    for (const input of [file, folder]) {
      const out = join(tmp, `restore-${input === file ? 'a' : 'b'}.sql`);
      const p = spawnSync(process.execPath, ['scripts/restore-backup.mjs', input, '--out', out], { cwd: ROOT, encoding: 'utf8' });
      expect(p.stderr).toBe('');
      expect(p.status).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(backupToSql(bundle));
    }
    const inRepo = spawnSync(process.execPath, ['scripts/restore-backup.mjs', file, '--out', join(ROOT, 'restore.sql')], { cwd: ROOT, encoding: 'utf8' });
    expect(inRepo.status).toBe(1);
    expect(inRepo.stderr).toContain('outside the repository');
    const noOut = spawnSync(process.execPath, ['scripts/restore-backup.mjs', file], { cwd: ROOT, encoding: 'utf8' });
    expect(noOut.status).toBe(1);
  });

  test('a damaged backup is refused', async () => {
    const db = await busyDb();
    const kv = new FakeKV();
    let r;
    do { r = await backupTick({ DB: db, BACKUPS: kv }, t(0), { force: true, maxRows: 100 }); } while (r.state !== 'finished');
    const bundle = (await readBackup({ DB: db, BACKUPS: kv }, '2026-11-15'))!;
    expect(() => backupToSql({ ...bundle, chunks: bundle.chunks.slice(1) })).toThrow(/chunks/);
    const broken = structuredClone(bundle);
    broken.manifest.tables.orders = 99;
    expect(() => backupToSql(broken)).toThrow(/orders/);
    const evil = structuredClone(bundle);
    evil.chunks[0].tables[0].columns[0] = 'key; DROP TABLE orders';
    expect(() => backupToSql(evil)).toThrow(/columns/);
  });

  test('retention keeps 35 daily and the first backup of each of 12 months; writes stay few', async () => {
    const days: string[] = [];
    for (let d = Date.parse('2025-06-01T00:00:00Z'); d <= Date.parse('2026-11-15T00:00:00Z'); d += 86_400_000) days.push(new Date(d).toISOString().slice(0, 10));
    const keep = daysToKeep(days, '2026-11-15');
    expect([...keep].filter((d) => d >= '2026-10-12').length).toBe(35);
    expect([...keep].filter((d) => d < '2026-10-12').sort()).toEqual(['2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']);
    const kv = new FakeKV();
    for (const d of days) {
      await kv.put(`daily/${d}/chunk-001.json`, '{}');
      await kv.put(`daily/${d}/manifest.json`, '{}');
    }
    await kv.put('daily/2026-11-10/chunk-002.json', '{}'); // part of a kept day
    await kv.put('daily/2025-12-02/chunk-001.json', '{}'); // an unfinished old day (no manifest change): goes
    const db = await freshDb({ seed: false });
    const before = kv.data.size;
    const deleted = await applyRetention({ DB: db, BACKUPS: kv }, '2026-11-15');
    expect(kv.data.size).toBe(before - deleted);
    const left = new Set([...kv.data.keys()].map((k) => k.slice(6, 16)));
    expect(left).toEqual(keep);
  });
});
