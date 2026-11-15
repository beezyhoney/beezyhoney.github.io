// src/admin/ops/*: the order-lines form reader, people, categories, list reads, the paged dump and static rules.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { freshDb, HELPER, OWNER, row, t, variantId } from '../../helpers/db';
import { formReader } from '../../../src/admin/forms';
import { lineErrorPart, lineFieldFor, lineRowPrefixes, messageDayToIso, readLineForm } from '../../../src/admin/ops/orderForm';
import { addHelper, cleanEmail, updateHelper } from '../../../src/admin/ops/people';
import { updateCategory } from '../../../src/admin/ops/categories';
import { listCategories, listHelpers, listRequests, ownerEmails, packChoices, packGroups, showPricesChecklist, tabCounts, tableCounts, testOrderCount } from '../../../src/admin/ops/data';
import { builtSiteVersion, dumpPage, photoLibrary, statusPayload } from '../../../src/admin/ops/system';
import { S } from '../../../src/admin/ops/strings';
import { BACKUP_TABLES } from '../../../src/server/backup';
import { createFromPasted, createManualOrder, saveLines } from '../../../src/server/orders';

const form = (pairs: Record<string, string | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return formReader(p);
};

describe('readLineForm', () => {
  it('reads existing, new and other lines; empty price = today’s price; removed and unused rows skipped', () => {
    const f = form({
      line_count: '3', new_count: '2', custom_count: '2',
      l0_kind: 'item', l0_variant: '2', l0_was: '2', l0_wasprice: '310', l0_qty: '2', l0_price: '300', l0_note: 'old customer',
      l1_kind: 'item', l1_variant: '5', l1_was: '4', l1_wasprice: '125', l1_qty: '1', l1_price: '125',
      l2_kind: 'custom', l2_name: 'Old jar', l2_qty: '1', l2_price: '', l2_remove: '1',
      n0_variant: '7', n0_qty: '3', n0_price: '', n1_variant: '', n1_qty: '1',
      c0_kind: 'fee', c0_name: 'Gift box fee', c0_qty: '2', c0_price: '20', c1_name: '',
    });
    const lines = readLineForm(f);
    expect(f.ok).toBe(true);
    expect(lines).toEqual([
      { kind: 'item', variantId: 2, qty: 2, priceNote: 'old customer', unitPricePaise: 30000 },
      { kind: 'item', variantId: 5, qty: 1, priceNote: null }, // pack changed, old price kept → today's price
      { kind: 'item', variantId: 7, qty: 3 },
      { kind: 'fee', name: 'Gift box fee', pack: '', qty: 2, unitPricePaise: 2000 },
    ]);
    expect(lineRowPrefixes(f)).toEqual(['l0_', 'l1_', 'n0_', 'c0_']);
    expect(lineFieldFor('line-3', lineRowPrefixes(f))).toBe('n0_');
    expect(lineFieldFor('discountPaise', ['l0_'])).toBeNull();
  });

  it('records field errors (bad quantity, charge without amount, bad price)', () => {
    const f = form({ line_count: '0', new_count: '1', custom_count: '1', n0_variant: '2', n0_qty: '0', n0_price: '3O0', c0_kind: 'fee', c0_name: 'Fee', c0_qty: '1', c0_price: '' });
    readLineForm(f);
    expect(Object.keys(f.errors).sort()).toEqual(['c0_price', 'n0_price', 'n0_qty']);
  });

  it('maps server messages to the field of the row and reads message dates', () => {
    expect(lineErrorPart('Choose a product and pack.')).toBe('variant');
    expect(lineErrorPart('Quantity must be 1–999.')).toBe('qty');
    expect(lineErrorPart('A charge needs an amount.')).toBe('price');
    expect(lineErrorPart('The price note is too long (120 characters at most).')).toBe('note');
    expect(lineErrorPart('Write what this line is for.')).toBe('name');
    expect(messageDayToIso('20 Dec 2026')).toBe('2026-12-20');
    expect(messageDayToIso('5 September 2027')).toBe('2027-09-05');
    expect(messageDayToIso('2026-12-24')).toBe('2026-12-24');
    expect(messageDayToIso('31 Feb 2026')).toBeNull();
    expect(messageDayToIso('soon')).toBeNull();
  });

  it('the form reader output saves through orders.ts', async () => {
    const db = await freshDb();
    const v = await variantId(db, 'murungai-honey:250g');
    const made = await createManualOrder(db, OWNER, { channel: 'phone', lines: [{ variantId: v, qty: 1 }] }, t(0));
    if (!made.ok) throw new Error(made.message);
    const f = form({ line_count: '1', new_count: '1', custom_count: '0', l0_kind: 'item', l0_variant: String(v), l0_was: String(v), l0_wasprice: '310', l0_qty: '4', l0_price: '310', n0_variant: String(await variantId(db, 'honey-sticks:box-10')), n0_qty: '1' });
    const r = await saveLines(db, OWNER, { id: made.value.id, version: 1, lines: readLineForm(f) }, t(1));
    expect(r).toMatchObject({ ok: true, value: { itemsTotalPaise: 124000 + 7000 } });
  });
});

describe('people', () => {
  it('adds helpers (never owners or twice), switches them off and ends their sessions', async () => {
    const db = await freshDb();
    expect(cleanEmail(' Helper@Example.TEST ')).toBe('helper@example.test');
    expect(cleanEmail('not an email')).toBeNull();
    expect((await addHelper(db, HELPER, { email: 'a@example.test' })).ok).toBe(false);
    expect(await addHelper(db, OWNER, { email: 'bad' })).toMatchObject({ ok: false, field: 'email' });
    expect(await addHelper(db, OWNER, { email: 'owner@example.test', owners: ['owner@example.test'] })).toMatchObject({ ok: false, field: 'email' });
    expect(await addHelper(db, OWNER, { email: 'Amma@Example.test', name: 'Amma' }, t(0))).toEqual({ ok: true, value: { email: 'amma@example.test' } });
    expect(await addHelper(db, OWNER, { email: 'amma@example.test' })).toMatchObject({ ok: false, error: 'conflict' });
    await db.prepare("INSERT INTO admin_sessions (token_hash, email, created_at, expires_at, last_seen_at, user_agent) VALUES ('h1', 'amma@example.test', ?, ?, ?, 'x')").bind(t(0), t(60 * 24 * 7), t(0)).run();
    const off = await updateHelper(db, OWNER, { email: 'amma@example.test', version: 1, active: false, name: 'Amma K' }, t(1));
    expect(off).toEqual({ ok: true, value: { version: 2 } });
    expect(await row(db, "SELECT COUNT(*) AS n FROM admin_sessions WHERE email = 'amma@example.test'")).toEqual({ n: 0 });
    expect(await updateHelper(db, OWNER, { email: 'amma@example.test', version: 1, active: true }, t(2))).toMatchObject({ ok: false, error: 'conflict' });
    const list = await listHelpers(db);
    expect(list).toMatchObject([{ email: 'amma@example.test', name: 'Amma K', active: false, version: 2 }]);
    const audit = await row<{ n: number }>(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'people.%'");
    expect(audit.n).toBe(2);
    expect(ownerEmails(' A@x.test, ,b@y.test ')).toEqual(['a@x.test', 'b@y.test']);
  });
});

describe('categories', () => {
  it('saves texts and photo, bumps site_version, refuses stale versions and unknown photos', async () => {
    const db = await freshDb();
    const [cat] = await listCategories(db);
    const site = async () => Number((await row<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'site_version'")).value);
    const before = await site();
    const base = { id: cat.id, version: cat.version, name: cat.name, title: cat.title, intro: cat.intro, image: cat.image };
    expect(await updateCategory(db, OWNER, base, t(0))).toEqual({ ok: true, value: { version: cat.version, effects: { publish: null, live: false } } });
    expect((await updateCategory(db, HELPER, { ...base, title: 'New' })).ok).toBe(false);
    expect(await updateCategory(db, OWNER, { ...base, image: 'nope.jpg' })).toMatchObject({ ok: false, field: 'image' });
    expect(await updateCategory(db, OWNER, { ...base, intro: 'x'.repeat(601) })).toMatchObject({ ok: false, field: 'intro' });
    const r = await updateCategory(db, OWNER, { ...base, title: 'Honey with the comb in it' }, t(1));
    expect(r).toEqual({ ok: true, value: { version: cat.version + 1, effects: { publish: 'now', live: false } } });
    expect(await site()).toBe(before + 1);
    expect(await updateCategory(db, OWNER, { ...base, title: 'Again' }, t(2))).toMatchObject({ ok: false, error: 'conflict' });
    expect(await site()).toBe(before + 1);
    expect((await listCategories(db))[0].title).toBe('Honey with the comb in it');
  });
});

describe('list reads', () => {
  it('packs, tab counts, requests sorted by needed-by, checklist, counts', async () => {
    const db = await freshDb();
    const packs = await packChoices(db);
    expect(packs.length).toBe(47);
    const groups = packGroups(packs, [], 'no price yet');
    expect(groups[0].options[0].label).toMatch(/^100 g · ₹/);
    expect(groups.some((g) => g.options.some((o) => o.label.endsWith('no price yet')))).toBe(true);
    const gift = (ref: string, needed: string | null) => createFromPasted(db, OWNER, {
      kind: 'gift', ref, lines: [{ name: 'Murungai Honey', pack: '100 g', qty: 3 }], gift: { size: 1, jar: '100 g', boxes: 3, picks: ['Murungai Honey'], extras: [], neededBy: needed, occasion: 'Diwali', card: null },
    }, {}, t(0));
    expect((await gift('BZ-AAAAA', '2026-12-20')).ok).toBe(true);
    expect((await gift('BZ-CCCCC', null)).ok).toBe(true);
    expect((await gift('BZ-DDDDD', '2026-11-20')).ok).toBe(true);
    const reqs = await listRequests(db, { at: t(0) });
    expect(reqs.map((r) => [r.ref, r.daysLeft])).toEqual([['BZ-DDDDD', 5], ['BZ-AAAAA', 35], ['BZ-CCCCC', null]]);
    expect(reqs[0].gift?.occasion).toBe('Diwali');
    expect(await tabCounts(db)).toMatchObject({ new: 3, requests: 3, spam: 0 });
    const check = await showPricesChecklist(db, { packerAddress: null, customerCare: '+91', fssai: '1' });
    expect(check.unpriced.length).toBe(12);
    expect(check).toMatchObject({ packerAddress: false, customerCare: true, fssai: true });
    expect(await testOrderCount(db)).toBe(0);
    const counts = await tableCounts(db, BACKUP_TABLES);
    expect(counts).toMatchObject({ products: 16, variants: 47, orders: 3 });
    await expect(tableCounts(db, ['orders; DROP TABLE x'])).rejects.toThrow();
  });

  it('dumpPage pages a table in rowid order and refuses other tables', async () => {
    const db = await freshDb();
    const first = await dumpPage(db, 'variants', 0, 20);
    expect(first?.rows.length).toBe(20);
    expect(first?.columns).toContain('code');
    expect(first?.columns).not.toContain('_backup_rowid');
    const rest = await dumpPage(db, 'variants', first!.next!, 100);
    expect(rest?.rows.length).toBe(27);
    expect(rest?.next).toBeNull();
    expect(await dumpPage(db, 'admin_sessions')).toBeNull();
    const empty = await dumpPage(db, 'payments');
    expect(empty).toMatchObject({ rows: [], next: null });
    expect(empty?.columns).toContain('amount_paise');
  });

  it('status payload and the deployed build / photo library reads', async () => {
    const db = await freshDb();
    const assets = (body: unknown, ok = true) => ({ fetch: async () => new Response(JSON.stringify(body), { status: ok ? 200 : 404 }) });
    expect(await builtSiteVersion(assets({ siteVersion: 3 }))).toBe(3);
    expect(await builtSiteVersion(assets({}, false))).toBeNull();
    expect(await builtSiteVersion(undefined)).toBeNull();
    const s = await statusPayload({ DB: db, DEPLOY_HOOK_URL: '' }, t(0));
    expect(s).toMatchObject({ website: { state: 'disabled' }, built: null, health: { db: true } });
    const lib = await photoLibrary(assets([{ path: 'a.jpg', thumb: '/_astro/a.webp', w: 240, h: 180 }, { path: 'b.jpg', src: 'https://evil.example/b.webp' }]));
    expect([...(lib?.values() ?? [])]).toEqual([{ path: 'a.jpg', src: '/_astro/a.webp', width: 240, height: 180, alt: undefined }]);
    expect(await photoLibrary(assets({ photos: [] }))).toBeNull();
  });
});

describe('words and pages', () => {
  it('area words load (no clash with core keys) and fill placeholders', () => {
    expect(S.t('order.sawPrice', { shown: '₹690', now: '₹710' })).toBe('Customer saw ₹690, today’s price ₹710.');
    expect(S.t('common.save')).toBe('Save');
  });

  const root = path.resolve(import.meta.dirname, '../../..');
  const walk = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
  const mine = ['orders', 'sales', 'requests', 'invoice', 'website', 'people', 'backup', 'activity', 'help', 'api/orders', 'api/export', 'api/backups']
    .flatMap((d) => walk(`src/pages/admin/${d}`)).concat(['src/pages/admin/index.astro', 'src/pages/admin/api/dump.json.ts', 'src/pages/admin/api/status.json.ts']);

  it('every ops page and endpoint renders on demand', () => {
    expect(mine.length).toBeGreaterThan(15);
    for (const f of mine) expect(readFileSync(path.join(root, f), 'utf8'), f).toMatch(/^export const prerender = false;$/m);
  });

  it('owner-only screens and endpoints check the role', () => {
    for (const f of ['website/index.astro', 'people/index.astro', 'backup/index.astro', 'activity/index.astro']) {
      expect(readFileSync(path.join(root, 'src/pages/admin', f), 'utf8'), f).toMatch(/canOpen\(admin\.role, '/);
    }
    for (const f of ['api/dump.json.ts', 'api/export/[name].csv.ts', 'api/backups/[date].json.ts']) {
      expect(readFileSync(path.join(root, 'src/pages/admin', f), 'utf8'), f).toMatch(/denied\(locals\.admin, 'owner'\)/);
    }
  });

  it('no third-party URLs or personal emails in the ops files', () => {
    const files = [...mine, ...walk('src/admin/ops'), 'src/server/sales.ts', 'src/server/invoice.ts'];
    for (const f of files) {
      const src = readFileSync(path.join(root, f), 'utf8');
      const urls = (src.match(/https?:\/\/[^\s'"`)<]+/g) ?? []).filter((u) => u !== 'http://x' && !u.startsWith('http://x/'));
      expect(urls, f).toEqual([]);
      const emails = (src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? []).filter((e) => !/@example\.(test|com)$/.test(e));
      expect(emails, f).toEqual([]);
    }
  });
});
