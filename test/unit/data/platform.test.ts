// settings, publishing, media, jobs, audit, time helpers and the D1 shim itself
import { describe, expect, test } from 'vitest';
import { getSettings, updateSettings, validateSetting } from '../../../src/server/settings';
import { getPublishStatus, handleEffects, hookUrl, markPublished, publishIfDue, publishNow, requestPublish } from '../../../src/server/publish';
import { isUploadKey, jpegInfo, kvMediaStore, newUlid, orphanUploads, saveUpload, serveMedia, setImagesPublicStmt, stripJpegMetadata } from '../../../src/server/media';
import { runCleanup, runDueJobsImpl, runReconcile, selfCheck } from '../../../src/server/jobs-impl';
import { listActivity, timeline } from '../../../src/server/audit';
import { DbError, auditInsert, batch, toId, versionedUpdate } from '../../../src/server/db';
import { addTime, fyLabel, fyStartYear, istDate, istMidnight, monthName } from '../../../src/server/time';
import { countStock, setAvailability } from '../../../src/server/stock';
import { addPayment, advanceOrder, assignInvoiceNo, confirmOrder, createManualOrder, getOrder, saveCustomer } from '../../../src/server/orders';
import { formatKg, formatPoolAmount, packAvailability, packEquivalents, parsePoolAmount, poolLevel, publicAvail } from '../../../src/lib/availability';
import { FakeCache, FakeCtx, FakeKV } from '../../helpers/fake-kv';
import { D1Shim } from '../../helpers/d1-sqlite';
import { HELPER, OWNER, freshDb, pool, row, rows, t } from '../../helpers/db';

const HOOK = 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/test-hook';

function fakeFetch(answers: Response[] = []) {
  const calls: { url: string; method?: string }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method });
    return answers.shift() ?? new Response(JSON.stringify({ success: true, result: { build_uuid: 'b-1', already_exists: false } }), { status: 200 });
  };
  return { fn, calls };
}

describe('availability (src/lib/availability.ts)', () => {
  const pool = (o: Partial<Parameters<typeof packAvailability>[0]>) => ({ trackStock: true, onHand: 1000, lowAt: 2000, availability: 'auto' as const, ...o });
  test('rules in order: override → untracked → below one pack → low level → in', () => {
    expect(packAvailability(pool({ availability: 'out', onHand: 99_999 }), 250)).toBe('out');
    expect(packAvailability(pool({ availability: 'in', onHand: -5 }), 250)).toBe('in');
    expect(packAvailability(pool({ trackStock: false, onHand: -5 }), 250)).toBe('in');
    expect(packAvailability(pool({ onHand: 249 }), 250)).toBe('out');
    expect(packAvailability(pool({ onHand: 250 }), 250)).toBe('low');
    expect(packAvailability(pool({ onHand: 2000 }), 250)).toBe('low');
    expect(packAvailability(pool({ onHand: 2001 }), 250)).toBe('in');
    expect(packAvailability(pool({ onHand: 5, lowAt: null }), 1)).toBe('in');
    expect(packAvailability(pool({ onHand: 0, lowAt: null }), 1)).toBe('out');
    expect(packAvailability(pool({ onHand: 9, lowAt: 5 }), 10)).toBe('out');
    expect(publicAvail('low', 'sold_out')).toBe('in');
    expect(publicAvail('low', 'low_and_sold_out')).toBe('low');
    expect(publicAvail('out', 'sold_out')).toBe('out');
    expect(poolLevel({ trackStock: true, onHand: -1, lowAt: 5 }, 1)).toBe('negative');
    expect(poolLevel({ trackStock: false, onHand: -1, lowAt: 5 }, 1)).toBe('untracked');
    expect(poolLevel({ trackStock: true, onHand: 99, lowAt: 5 }, 100)).toBe('empty');
  });
  test('amounts in the owner\'s words', () => {
    expect(formatKg(99_500)).toBe('99.5 kg');
    expect(formatKg(100_000)).toBe('100.0 kg');
    expect(formatKg(1_234_567)).toBe('1,234.6 kg');
    expect(formatKg(-750)).toBe('−0.8 kg');
    expect(formatKg(40)).toBe('40 g');
    expect(formatKg(0)).toBe('0.0 kg');
    expect(formatPoolAmount(1, 'piece')).toBe('1 piece');
    expect(formatPoolAmount(-2, 'piece')).toBe('−2 pieces');
    expect(parsePoolAmount('99.5', 'g')).toBe(99_500);
    expect(parsePoolAmount('99,5 kg', 'g')).toBe(99_500);
    expect(parsePoolAmount('100 KG', 'g')).toBe(100_000);
    expect(parsePoolAmount('250 g', 'g')).toBe(250);
    expect(parsePoolAmount('0.05', 'g')).toBe(50);
    expect(parsePoolAmount('-2', 'g')).toBeNull();
    expect(parsePoolAmount('-2', 'g', { allowNegative: true })).toBe(-2000);
    expect(parsePoolAmount('2.5 g', 'g')).toBeNull();
    expect(parsePoolAmount('ten', 'g')).toBeNull();
    expect(parsePoolAmount('12', 'piece')).toBe(12);
    expect(parsePoolAmount('12 pcs', 'piece')).toBe(12);
    expect(parsePoolAmount('1.5', 'piece')).toBeNull();
    expect(packEquivalents(99_100, [{ label: '100 g', poolQty: 100 }, { label: '250 g', poolQty: 250 }, { label: '500 g', poolQty: 500 }])).toBe('≈ 396 × 250 g or 991 × 100 g');
    expect(packEquivalents(0, [{ label: '100 g', poolQty: 100 }])).toBe('');
  });
});

describe('time helpers', () => {
  test('IST dates, months and financial years', () => {
    expect(istDate('2026-03-31T18:29:59Z')).toBe('2026-03-31');
    expect(istDate('2026-03-31T18:30:00Z')).toBe('2026-04-01');
    expect(istMidnight('2026-04-01')).toBe('2026-03-31T18:30:00Z');
    expect(fyStartYear('2027-03-31')).toBe(2026);
    expect(fyStartYear('2027-04-01')).toBe(2027);
    expect(fyLabel(2099)).toBe('2099-00');
    expect(monthName('2026-11-15')).toBe('November 2026');
    expect(addTime('2026-11-15T23:50:00Z', { minutes: 30 })).toBe('2026-11-16T00:20:00Z');
  });
});

describe('settings', () => {
  test('owner only, validated, version-checked, all or nothing', async () => {
    const db = await freshDb();
    expect(await updateSettings(db, HELPER, { values: { show_prices: true } })).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await updateSettings(db, OWNER, { values: { site_version: 9 } as never })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await updateSettings(db, OWNER, { values: { gift: { feePaise: 0, extras: { 'Beeswax candle': 'nope:1' }, bulkFrom: 20 } } })).toMatchObject({ ok: false, field: 'gift' });
    expect(await updateSettings(db, OWNER, { values: { offer: { text: 'x', href: 'https://evil.example/', until: null } } })).toMatchObject({ ok: false, field: 'offer' });
    const s = await getSettings(db);
    const ok = await updateSettings(db, OWNER, {
      values: { delivery_note: 'Free delivery above ₹1,000 in Tamil Nadu.', gift: { feePaise: 2000, extras: { 'Beeswax candle': 'beeswax-candles:small', 'Honey sticks': null }, bulkFrom: 25 }, business: { ...s.values.business, gstin: '33ABCDE1234F1Z5' } },
      versions: { delivery_note: s.versions.delivery_note, gift: s.versions.gift, business: s.versions.business },
    }, t(0));
    expect(ok).toEqual({ ok: true, value: { changed: ['delivery_note', 'gift', 'business'], effects: { publish: 'now', live: true } } });
    // stale versions: nothing is written
    const stale = await updateSettings(db, OWNER, { values: { delivery_note: 'Other', show_prices: true }, versions: { delivery_note: s.versions.delivery_note } }, t(1));
    expect(stale).toMatchObject({ ok: false, error: 'conflict' });
    const after = await getSettings(db);
    expect(after.values.show_prices).toBe(false);
    expect(after.values.delivery_note).toBe('Free delivery above ₹1,000 in Tamil Nadu.');
    expect(after.versions.delivery_note).toBe(2);
    expect(after.values.site_version).toBe(2);
    // unchanged values are skipped; private keys do not bump versions
    expect(await updateSettings(db, OWNER, { values: { delivery_note: 'Free delivery above ₹1,000 in Tamil Nadu.', privacy: { clearCustomerAfterMonths: 12 } } }, t(2)))
      .toEqual({ ok: true, value: { changed: ['privacy'], effects: { publish: null, live: false } } });
    expect((await getSettings(db)).values.live_version).toBe(2);
    // go-live time is set once
    expect((await updateSettings(db, OWNER, { values: { go_live_at: '2026-12-01T00:30:00Z' } }, t(3))).ok).toBe(true);
    expect(await updateSettings(db, OWNER, { values: { go_live_at: null } }, t(4))).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(validateSetting('business', { name: 'X', packerAddress: null, customerCare: null, fssai: '123', gstin: null })).toMatch(/FSSAI/);
    const audit = await listActivity(db, { entity: 'settings' });
    expect(audit[audit.length - 1].summary).toBe('Delivery note changed; Gift box settings changed; Business details changed');
  });
});

describe('publishing', () => {
  test('no deploy hook: a clear no-op', async () => {
    const db = await freshDb();
    const ctx = new FakeCtx();
    expect(hookUrl({ DEPLOY_HOOK_URL: '' })).toBeNull();
    expect(hookUrl({ DEPLOY_HOOK_URL: 'http://evil.example/hook' })).toBeNull();
    expect(hookUrl({ DEPLOY_HOOK_URL: 'http://127.0.0.1:4421/hook' })).toBe('http://127.0.0.1:4421/hook');
    expect(await requestPublish({ DB: db, DEPLOY_HOOK_URL: '' }, ctx, { reason: 'x' })).toMatchObject({ state: 'disabled' });
    expect(await publishNow({ DB: db }, ctx, OWNER)).toMatchObject({ state: 'disabled' });
    expect((await getPublishStatus({ DB: db }, t(0))).state).toBe('disabled');
    expect(ctx.pending).toHaveLength(0);
    expect((await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM publishes')).n).toBe(0);
  });

  test('an owner save calls the hook once (in waitUntil) and records the build; status follows /build.json', async () => {
    const db = await freshDb();
    const env = { DB: db, DEPLOY_HOOK_URL: HOOK };
    const ctx = new FakeCtx();
    const f = fakeFetch();
    const saved = await updateSettings(db, OWNER, { values: { show_prices: true } }, t(0));
    expect(saved.ok && saved.value.effects.publish).toBe('now');
    const r = await requestPublish(env, ctx, { reason: 'Prices shown', actor: OWNER, at: t(0), fetch: f.fn });
    expect(r).toEqual({ state: 'requested', publishId: 1, siteVersion: 2 });
    await ctx.settle();
    expect(f.calls).toEqual([{ url: HOOK, method: 'POST' }]);
    expect(await row(db, 'SELECT site_version, status, http_status, build_uuid, already_queued FROM publishes')).toEqual({ site_version: 2, status: 'requested', http_status: 200, build_uuid: 'b-1', already_queued: 0 });
    expect(await getPublishStatus(env, t(2))).toMatchObject({ state: 'updating', message: 'Updating… started 2 min ago' });
    expect(await getPublishStatus(env, t(6), 2)).toMatchObject({ state: 'up_to_date', publishedVersion: 2, message: 'Website up to date ✓ (10:06)' });
    expect(await handleEffects(env, ctx, OWNER, { publish: null, live: true }, 'x')).toBeNull();
  });

  test('a build that never shows up turns into "didn\'t finish" after 25 minutes; a failing hook is recorded', async () => {
    const db = await freshDb();
    const env = { DB: db, DEPLOY_HOOK_URL: HOOK };
    const ctx = new FakeCtx();
    await requestPublish(env, ctx, { reason: 'x', at: t(0), fetch: fakeFetch().fn });
    await ctx.settle();
    await db.prepare("UPDATE settings SET value = '2' WHERE key = 'site_version'").run();
    await db.prepare("UPDATE publishes SET site_version = 2").run();
    expect((await getPublishStatus(env, t(26))).state).toBe('failed');
    const ctx2 = new FakeCtx();
    await requestPublish(env, ctx2, { reason: 'y', at: t(30), fetch: fakeFetch([new Response('nope', { status: 500 })]).fn });
    await ctx2.settle();
    expect(await row(db, 'SELECT status, http_status, error FROM publishes WHERE id = 2')).toEqual({ status: 'failed', http_status: 500, error: 'Deploy hook answered 500' });
    const ctx3 = new FakeCtx();
    await requestPublish(env, ctx3, { reason: 'z', at: t(31), fetch: async () => { throw new Error('network down'); } });
    await ctx3.settle();
    expect(await row(db, 'SELECT status, error FROM publishes WHERE id = 3')).toEqual({ status: 'failed', error: 'network down' });
    expect(await markPublished(db, 2, t(40))).toBe(3);
  });

  test('stock-status changes are debounced: published once when due', async () => {
    const db = await freshDb();
    const env = { DB: db, DEPLOY_HOOK_URL: HOOK };
    const p = await pool(db, 'murungai-honey');
    await setAvailability(db, OWNER, { poolId: p.id, version: p.version, availability: 'out' }, t(0));
    expect(await getPublishStatus(env, t(1))).toMatchObject({ state: 'waiting', message: 'Changes waiting, automatic update at 10:30' });
    const ctx = new FakeCtx();
    const f = fakeFetch();
    expect(await publishIfDue(env, ctx, t(29), { fetch: f.fn })).toEqual({ state: 'not_due', dueAt: t(30) });
    expect(await publishIfDue(env, ctx, t(30), { fetch: f.fn })).toMatchObject({ state: 'requested', siteVersion: 2 });
    expect(await publishIfDue(env, ctx, t(31), { fetch: f.fn })).toEqual({ state: 'not_due', dueAt: null });
    await ctx.settle();
    expect(f.calls).toHaveLength(1);
  });
});

/** A tiny but valid-looking JPEG: SOI, APP0, APP1 (Exif with "GPS"), COM, DQT, SOF0 (w×h), SOS, data, EOI */
function jpeg(w: number, h: number): Uint8Array {
  const seg = (m: number, body: number[]) => [0xff, m, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii('GPS 13.0827N 80.2707E')]),
    ...seg(0xfe, ascii('camera comment')),
    ...seg(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1]),
    ...seg(0xdb, [0, ...Array(64).fill(1)]),
    ...seg(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    0x12, 0x34, 0xff, 0x00, 0x56,
    0xff, 0xd9,
  ]);
}
const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('media (KV MEDIA)', () => {
  test('reads JPEG sizes, strips Exif/XMP/IPTC/comments but keeps JFIF, ICC and the image data', () => {
    const j = jpeg(1600, 1200);
    expect(jpegInfo(j)).toEqual({ width: 1600, height: 1200 });
    const s = stripJpegMetadata(j)!;
    expect(text(j)).toContain('GPS');
    expect(text(s)).not.toContain('GPS');
    expect(text(s)).not.toContain('camera comment');
    expect(text(s)).toContain('JFIF');
    expect(text(s)).toContain('ICC_PROFILE');
    expect(jpegInfo(s)).toEqual({ width: 1600, height: 1200 });
    expect(Array.from(s.slice(-7))).toEqual([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
    expect(jpegInfo(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(stripJpegMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(newUlid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isUploadKey(`uploads/${newUlid()}.jpg`)).toBe(true);
    expect(isUploadKey(`uploads/thumbs/${newUlid()}.jpg`)).toBe(true);
    expect(isUploadKey('uploads/../x.jpg')).toBe(false);
    expect(isUploadKey('murungai-main.jpg')).toBe(false);
  });

  test('strips metadata between the scans of a progressive JPEG and cuts everything after the end of image (review: security 5)', () => {
    const seg = (m: number, body: number[]) => [0xff, m, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const base = Array.from(jpeg(1600, 1200));
    const eoi = base.length - 2;
    const progressive = new Uint8Array([
      ...base.slice(0, eoi), // SOI … first scan (with a stuffed FF00 in its data)
      ...seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii('GPS 2nd 11.0168N 76.9558E')]), // APP1 between scans
      ...seg(0xfe, ascii('between-scan comment')),
      ...seg(0xed, ascii('Photoshop 3.0 IPTC city')),
      ...seg(0xc4, [0, ...Array(16).fill(0), 1]), // a DHT for the next scan (kept)
      ...seg(0xda, [1, 1, 0, 0, 63, 0]),
      0x9a, 0xff, 0xd0, 0xbc, 0xff, 0x00, 0xde, // data with a restart marker and a stuffed byte
      0xff, 0xff, 0xd9, // a fill byte, then the end of image
      ...Array.from(jpeg(320, 240)).slice(0, 60), ...ascii('appended GPS 9.9N'), // data after EOI (e.g. a second picture)
    ]);
    const s = stripJpegMetadata(progressive)!;
    expect(s).not.toBeNull();
    for (const gone of ['GPS', 'between-scan comment', 'IPTC', 'appended']) expect(text(s)).not.toContain(gone);
    expect(jpegInfo(s)).toEqual({ width: 1600, height: 1200 });
    expect(Array.from(s.slice(-9))).toEqual([0x9a, 0xff, 0xd0, 0xbc, 0xff, 0x00, 0xde, 0xff, 0xd9]);
    expect(Array.from(s)).toEqual(expect.arrayContaining([0xff, 0xc4])); // the second scan's table stays
    // no end of image at all: not a well-formed JPEG
    expect(stripJpegMetadata(new Uint8Array(base.slice(0, eoi)))).toBeNull();
  });

  test('upload → KV with metadata → private until public → served through the cache', async () => {
    const db = await freshDb();
    const kv = new FakeKV();
    const env = { DB: db, MEDIA: kv };
    expect(await saveUpload(env, OWNER, { bytes: jpeg(600, 900), thumbBytes: jpeg(320, 480) })).toMatchObject({ ok: false, field: 'file' });
    expect(await saveUpload(env, OWNER, { bytes: new TextEncoder().encode('<svg/>'), thumbBytes: jpeg(320, 480) })).toMatchObject({ ok: false, field: 'file' });
    expect(await saveUpload(env, OWNER, { bytes: jpeg(1600, 1200), thumbBytes: new Uint8Array([1]) })).toMatchObject({ ok: false, field: 'thumb' });
    const up = await saveUpload(env, HELPER, { bytes: jpeg(2400, 1600), thumbBytes: jpeg(480, 320) }, t(0));
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(up.value.path).toMatch(/^uploads\/[0-9A-Z]{26}\.jpg$/);
    const stored = await kvMediaStore(kv).get(up.value.path);
    expect(stored!.meta).toEqual({ contentType: 'image/jpeg', width: 2400, height: 1600, bytes: up.value.bytes });
    expect(text(new Uint8Array(stored!.body))).not.toContain('GPS');
    expect(await row(db, 'SELECT source, public, width, height FROM images WHERE path = ?', up.value.path)).toEqual({ source: 'upload', public: 0, width: 2400, height: 1600 });
    expect((await orphanUploads(db)).map((o) => o.path)).toEqual([up.value.path]);

    const cache = new FakeCache();
    const url = `https://beezyhoney.in/media/${up.value.path}`;
    const draft = await serveMedia(env, new Request(url), up.value.path, { requirePublic: true, cache });
    expect(draft.status).toBe(404);
    const preview = await serveMedia(env, new Request(url), up.value.path, { requirePublic: false });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('cache-control')).toBe('private, max-age=300');
    await setImagesPublicStmt(db, [up.value.path]).run();
    const ctx = new FakeCtx();
    const res = await serveMedia(env, new Request(url), up.value.path, { requirePublic: true, cache, ctx });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy'].map((h) => [h, res.headers.get(h)]))).toEqual({
      'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
    });
    await ctx.settle();
    const reads = kv.ops.reads;
    const again = await serveMedia(env, new Request(`${url}?x=1`), up.value.path, { requirePublic: true, cache });
    expect(again.status).toBe(200);
    expect(kv.ops.reads).toBe(reads); // from the cache, no KV read
    expect(cache.hits).toBe(1);
    expect((await serveMedia(env, new Request(url), 'uploads/nope.jpg', { requirePublic: true, cache })).status).toBe(404);
    expect((await serveMedia(env, new Request(url), up.value.thumbPath, { requirePublic: true, cache: null })).status).toBe(200);
  });
});

describe('jobs', () => {
  test('cleanup: IP hashes after 30 days, expired sessions, personal details after the privacy window (invoiced keep name and city)', async () => {
    const db = await freshDb();
    await db.prepare(`INSERT INTO login_codes (email, code_hash, expires_at, created_at) VALUES ('a@example.test', 'h', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
    await db.prepare(`INSERT INTO admin_sessions (token_hash, email, created_at, expires_at) VALUES ('t1', 'a@example.test', '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z'), ('t2', 'a@example.test', '2026-11-14T00:00:00Z', '2026-11-21T00:00:00Z')`).run();
    const mk = async (customer: object, at: string) => {
      const r = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'murungai-honey:100g', qty: 1 }], customer }, at);
      if (!r.ok) throw new Error(r.message);
      await confirmOrder(db, OWNER, { id: r.value.id, version: 1 }, at);
      await advanceOrder(db, OWNER, { id: r.value.id, version: 2, to: 'delivered' }, at);
      return r.value.id;
    };
    const old = await mk({ name: 'Old Customer', phone: '90000 11111', address: '1 Long Street', city: 'Salem' }, '2024-10-01T05:00:00Z');
    const invoiced = await mk({ name: 'Invoiced Customer', phone: '90000 22222', city: 'Erode' }, '2024-10-01T05:00:00Z');
    await assignInvoiceNo(db, OWNER, { id: invoiced }, '2024-10-02T05:00:00Z');
    const recent = await mk({ name: 'Recent Customer', phone: '90000 33333' }, '2026-11-01T05:00:00Z');
    await db.prepare("UPDATE orders SET ip_hash = 'abc' WHERE id IN (?, ?)").bind(old, recent).run();
    const r = await runCleanup(db, '2026-11-15T05:00:00Z');
    expect(r).toEqual({ ipHashesCleared: 1, loginCodes: 1, sessions: 1, rateBuckets: 0, customersCleared: 2 });
    expect((await getOrder(db, old))!.order.customer).toEqual({ name: null, phone: null, address: null, city: null });
    expect((await getOrder(db, invoiced))!.order.customer).toEqual({ name: 'Invoiced Customer', phone: null, address: null, city: 'Erode' });
    expect((await getOrder(db, recent))!.order.customer.phone).toBe('90000 33333');
    expect(await row(db, 'SELECT ip_hash FROM orders WHERE id = ?', recent)).toEqual({ ip_hash: 'abc' });
  });

  test('reconcile finds caches that differ from their ledgers (and can repair them)', async () => {
    const db = await freshDb();
    const p = await pool(db, 'kombu-honey');
    await countStock(db, OWNER, { counts: [{ poolId: p.id, amount: 5000 }] }, t(0));
    const o = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'kombu-honey:100g', qty: 1 }] }, t(0));
    if (!o.ok) throw new Error(o.message);
    await addPayment(db, OWNER, { id: o.value.id, amountPaise: 1000, method: 'cash' }, t(0));
    expect((await runReconcile(db)).ok).toBe(true);
    await db.prepare('UPDATE stock_pools SET on_hand = 1 WHERE id = ?').bind(p.id).run();
    await db.prepare('UPDATE orders SET paid_paise = 5 WHERE id = ?').bind(o.value.id).run();
    const r = await runReconcile(db, { repair: true });
    expect(r).toMatchObject({ ok: false, pools: [{ poolId: p.id, cached: 1, ledger: 5000 }], paid: [{ orderId: o.value.id, cached: 5, ledger: 1000 }], totals: [] });
    expect((await runReconcile(db)).ok).toBe(true);
  });

  test('runDueJobsImpl runs what is due, once; errors never escape', async () => {
    const db = await freshDb();
    const kv = new FakeKV();
    const env = { DB: db, BACKUPS: kv, DEPLOY_HOOK_URL: '' };
    const ctx = new FakeCtx();
    const first = await runDueJobsImpl(env, ctx, { at: '2026-11-15T21:00:00Z' }); // 02:30 IST
    expect(first.ran).toEqual(['backup', 'cleanup', 'reconcile']);
    const second = await runDueJobsImpl(env, ctx, { at: '2026-11-15T21:15:00Z' });
    expect(second.ran).toEqual([]); // the seed fits in one backup chunk; cleanup and reconcile already ran
    expect(second.results.backup).toEqual({ state: 'done_today', date: '2026-11-16' });
    const check = await selfCheck(env, '2026-11-15T21:16:00Z');
    expect(check).toMatchObject({ d1: true, backupStale: false, publishing: 'off', reconcile: { mismatch: false } });
    expect(check.lastRuns.backup?.ok).toBe(true);
    const broken = { DB: { prepare() { throw new Error('D1 down'); }, batch() { throw new Error('D1 down'); }, exec() { throw new Error('D1 down'); } } as never };
    const r = await runDueJobsImpl(broken, ctx, { at: t(0) });
    expect(r.ran).toEqual([]);
    expect(r.results.publish).toEqual({ error: 'D1 down' });
  });
});

describe('audit and db helpers', () => {
  test('timeline and activity; audit never holds personal details', async () => {
    const db = await freshDb();
    const o = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ code: 'murungai-honey:100g', qty: 1 }] }, t(0));
    if (!o.ok) throw new Error(o.message);
    await saveCustomer(db, OWNER, { id: o.value.id, version: 1, name: 'Somebody Private', phone: '91234 56789' }, t(1));
    expect((await timeline(db, 'order', o.value.id)).map((a) => a.action)).toEqual(['order.create', 'order.customer']);
    const all = JSON.stringify(await rows(db, 'SELECT * FROM audit_log'));
    expect(all).not.toContain('Somebody');
    expect(all).not.toContain('91234');
    expect((await listActivity(db, { actionPrefix: 'order.' })).map((a) => a.action)).toEqual(['order.customer', 'order.create']);
    expect(await listActivity(db, { actionPrefix: `order.${'x'.repeat(60)}` })).toEqual([]); // a prefix, never a LIKE pattern
    expect(await listActivity(db, { actionPrefix: 'order%' })).toEqual([]);
  });

  test('versionedUpdate, guarded audit and constraint errors', async () => {
    const db = await freshDb();
    const p = await pool(db, 'murungai-honey');
    const s1 = versionedUpdate(db, { table: 'stock_pools', key: ['id', p.id], version: 1, set: { low_at: 3000 }, actor: OWNER, at: t(0) });
    expect((await s1.run()).meta.changes).toBe(1);
    expect((await versionedUpdate(db, { table: 'stock_pools', key: ['id', p.id], version: 1, set: { low_at: 1 }, actor: OWNER, at: t(1) }).run()).meta.changes).toBe(0);
    expect(() => versionedUpdate(db, { table: 'x; DROP', key: ['id', 1], version: 1, set: {}, actor: OWNER, at: t(0) })).toThrow();
    await auditInsert(db, { at: t(2), actor: OWNER, action: 'x', entity: 'y', entityId: 1, summary: 'never' }, { sql: 'EXISTS (SELECT 1 FROM orders WHERE id = ?)', params: [999] }).run();
    expect((await row<{ n: number }>(db, "SELECT COUNT(*) AS n FROM audit_log WHERE summary = 'never'")).n).toBe(0);
    const err = await batch(db, [db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('show_prices', 'true', 'x', 'y')")]).catch((e) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.kind).toBe('unique');
    expect(toId('12')).toBe(12);
    expect(toId('1e3')).toBeNull();
    expect(toId(-1)).toBeNull();
  });
});

describe('D1 shim (test/helpers/d1-sqlite.ts)', () => {
  test('behaves like D1 where it matters', async () => {
    const db = new D1Shim();
    await db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0), t TEXT)');
    const ins = await db.prepare('INSERT INTO a (n, t) VALUES (?1, ?1 || ?2)').bind(5, 'x').run();
    expect(ins.meta).toMatchObject({ changes: 1, last_row_id: 1 });
    expect(await db.prepare('SELECT t FROM a').first('t')).toBe('5x'); // integers bind as INTEGER, not 5.0
    expect(await db.prepare('SELECT * FROM a WHERE id = ?').bind(2).first()).toBeNull();
    expect(() => db.prepare('SELECT ?').bind(undefined)).toThrow(/D1_TYPE_ERROR/);
    expect(await db.prepare('SELECT ? AS b').bind(true).first('b')).toBe(1);
    await expect(db.batch([db.prepare('INSERT INTO a (n) VALUES (1)'), db.prepare('INSERT INTO a (n) VALUES (-1)')])).rejects.toThrow(/CHECK constraint failed/);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM a').first('c')).toBe(1); // rolled back
    const res = await db.batch([db.prepare('UPDATE a SET n = n + 1'), db.prepare('INSERT INTO a (n) VALUES (2) RETURNING id'), db.prepare('SELECT n FROM a ORDER BY id')]);
    expect(res.map((r) => r.meta.changes)).toEqual([1, 1, 0]);
    expect(res[1].results).toEqual([{ id: 2 }]);
    expect(res[2].results).toEqual([{ n: 6 }, { n: 2 }]);
    expect(await db.prepare('SELECT id, n FROM a ORDER BY id').raw({ columnNames: true })).toEqual([['id', 'n'], [1, 6], [2, 2]]);
    await expect(db.prepare('SELECT nope FROM a').all()).rejects.toThrow(/D1_ERROR/);
  });

  test('LIKE and GLOB match like SQLite and enforce D1 limits (50-byte patterns, 5-term compound SELECT)', async () => {
    const db = new D1Shim();
    const q = async (sql: string, ...p: unknown[]) => (p.length ? db.prepare(sql).bind(...p) : db.prepare(sql)).first<number>('r');
    // GLOB: case-sensitive, * ? and classes with ranges and ^ negation
    expect(await q("SELECT 'MUR-2611' GLOB 'MUR-*' AS r")).toBe(1);
    expect(await q("SELECT 'mur-2611' GLOB 'MUR-*' AS r")).toBe(0);
    expect(await q("SELECT 'abc' GLOB 'a?c' AS r")).toBe(1);
    expect(await q("SELECT 'murungai-honey:250g' NOT GLOB '*[^a-z0-9:-]*' AS r")).toBe(1);
    expect(await q("SELECT 'Murungai' NOT GLOB '*[^a-z0-9:-]*' AS r")).toBe(0);
    expect(await q("SELECT '2028-11' GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AS r")).toBe(1);
    expect(await q("SELECT 'a.b' GLOB 'a.b' AS r")).toBe(1);
    expect(await q("SELECT 'axb' GLOB 'a.b' AS r")).toBe(0);
    expect(await q("SELECT NULL GLOB 'a' AS r")).toBeNull();
    // LIKE: ASCII case-insensitive, % and _, ESCAPE
    expect(await q("SELECT 'Honey' LIKE 'h%' AS r")).toBe(1);
    expect(await q("SELECT 'sale:12:1:3' LIKE 'sale:' || ? || ':%' AS r", 12)).toBe(1);
    expect(await q("SELECT 'sale:123:1:3' LIKE 'sale:' || ? || ':%' AS r", 12)).toBe(0);
    expect(await q("SELECT 'a_c' LIKE 'a!_c' ESCAPE '!' AS r")).toBe(1);
    expect(await q("SELECT 'abc' LIKE 'a!_c' ESCAPE '!' AS r")).toBe(0);
    // D1 limits
    expect(await q("SELECT 'x' LIKE ? AS r", `${'a'.repeat(49)}%`)).toBe(0);
    await expect(q("SELECT 'x' LIKE ? AS r", `${'a'.repeat(50)}%`)).rejects.toThrow(/LIKE or GLOB pattern too complex/);
    await expect(db.exec(`CREATE TABLE t (c TEXT CHECK (c GLOB '${'[0-9]'.repeat(11)}'))`).then(() => db.prepare("INSERT INTO t VALUES ('1')").run()))
      .rejects.toThrow(/pattern too complex/);
    expect(await q('SELECT 1 AS r UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5')).toBe(1);
    await expect(q('SELECT 1 AS r UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6')).rejects.toThrow(/too many terms in compound SELECT/);
  });
});
