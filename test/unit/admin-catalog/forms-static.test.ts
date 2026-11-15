// Editor form reading, the catalog words, and static rules for the catalog screens.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { formReader } from '../../../src/admin/forms';
import { S } from '../../../src/admin/catalog/strings';
import { packGramsOf, packPaiseOf, readGallery, readPacksForm, readProductForm } from '../../../src/admin/catalog/product-form';
import { fitSize, isHeic } from '../../../src/admin/catalog/upload';
import { riskOfClient } from '../../../src/admin/catalog/risk';
import { riskOf } from '../../../src/server/prices';
import { getProductEditor } from '../../../src/server/products-admin';
import { freshDb } from '../../helpers/db';

const root = path.resolve(import.meta.dirname, '../../..');
const walk = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
});
const mine = [
  ...['products', 'prices', 'stock', 'harvests', 'batches', 'labels', 'media'].flatMap((d) => walk(`src/pages/admin/${d}`)),
  'src/pages/admin/api/media.json.ts',
];

describe('reading the editor forms', () => {
  test('gallery: order boxes, removals and ticked additions', () => {
    const f = formReader(new URLSearchParams([
      ['g_src', 'a.jpg'], ['g_cap', ' A  jar '], ['g_order', '2'],
      ['g_src', 'b.jpg'], ['g_cap', 'Comb'], ['g_order', '1'],
      ['g_src', 'c.jpg'], ['g_cap', 'gone'], ['g_order', '3'], ['g_del', 'c.jpg'],
      ['g_add', 'd.jpg'], ['g_add', 'a.jpg'],
    ]));
    expect(readGallery(f)).toEqual([{ src: 'b.jpg', caption: 'Comb' }, { src: 'a.jpg', caption: 'A jar' }, { src: 'd.jpg', caption: '' }]);
  });

  test('product form and packs form', async () => {
    const db = await freshDb();
    const e = (await getProductEditor(db, 1))!;
    const f = formReader(new URLSearchParams([
      ['version', '1'], ['name', 'Murungai Honey'], ['category', 'comb-honey'], ['kind', 'Monofloral'], ['badge', 'With honeycomb'],
      ['with_comb', '0'], ['with_comb', '1'], ['tagline', 'x'], ['tone', '#EEF0D6'], ['tone_custom', 'aabbcc'], ['slug', 'other-slug'],
      ['short_code', 'mur'], ['photo', 'murungai-main.jpg'], ['card', ''], ['spec_l_0', 'Taste'], ['spec_v_0', 'Mild'], ['spec_l_3', 'Colour'], ['spec_v_3', ''],
      ['love_0', 'One'], ['love_2', 'Two'], ['colour_on', '0'], ['finder_on', '1'], ['taste', 'mild'], ['taste', 'bogus'], ['uses', 'daily'],
      ['bloom_on', '1'], ['bloom_all', '0'], ['months', '12'], ['months', '1'], ['in_gift_box', '1'],
    ]));
    const input = readProductForm(f, e);
    expect(input).toMatchObject({ version: 1, withComb: true, tone: '#aabbcc', shortCode: 'MUR', photo: 'murungai-main.jpg', card: null,
      specs: [['Taste', 'Mild'], ['Colour', '']], love: ['One', 'Two'], colour: null, finder: { taste: ['mild'], uses: ['daily'], rare: false }, bloom: [12, 1], inGiftBox: true });
    expect('slug' in input).toBe(false); // a live product's slug is never read from the form
    const p = formReader(new URLSearchParams([
      ['p1_v', '1'], ['p1_label', '100 g'], ['p1_grams', '100'], ['p1_price', '₹150'], ['p1_mrp', ''], ['p1_active', '0'], ['p1_active', '1'], ['p1_gift', '0'],
      ['p2_v', '1'], ['p2_label', '250 g'], ['p2_grams', '250 g'], ['p2_price', ''], ['p2_mrp', ''], ['p2_active', '0'],
      ['p3_v', '1'], ['p3_label', '500 g'], ['p3_grams', '500'], ['p3_price', '650'], ['p3_mrp', '700'], ['p3_active', '1'],
      ['new_label', '1 kg'], ['new_grams', '1 kg'], ['new_price', '1,200'],
    ]));
    const packs = readPacksForm(p, e);
    expect(p.ok).toBe(true);
    expect(packs.map((x) => [x.id ?? 'new', x.netGrams, x.pricePaise, x.mrpPaise, x.active, x.giftOk])).toEqual([
      [1, 100, 15000, null, true, false], [2, 250, null, null, false, false], [3, 500, 65000, 70000, true, false], ['new', 1000, 120000, null, true, false],
    ]);
    const bad = formReader(new URLSearchParams([['p1_v', '1'], ['p1_label', '100 g'], ['p1_grams', 'lots'], ['p1_price', '']]));
    readPacksForm(bad, { ...e, packs: e.packs.slice(0, 1) });
    expect(Object.keys(bad.errors)).toEqual(['pack_1']);
    expect(packGramsOf('')).toBeNull();
    expect(packPaiseOf('abc')).toBeNaN();
  });
});

describe('browser helpers (pure parts)', () => {
  test('resize keeps the long edge ≤ 2400 but never the short edge under 800', () => {
    expect(fitSize(4032, 3024)).toEqual({ width: 2400, height: 1800 });
    expect(fitSize(1600, 1200)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(8000, 1000)).toEqual({ width: 6400, height: 800 });
    expect(fitSize(4032, 3024, 480, 1)).toEqual({ width: 480, height: 360 });
    expect(isHeic({ name: 'IMG_1114.HEIC', type: '' })).toBe(true);
    expect(isHeic({ name: 'x.jpg', type: 'image/jpeg' })).toBe(false);
  });

  test('the browser price check uses the server rule', () => {
    for (const [a, b] of [[35000, 3500], [31000, 47000], [null, 900], [700, 800], [31000, 33000], [31000, null]] as const) {
      expect(riskOfClient(a, b)).toBe(riskOf(a, b));
    }
  });
});

describe('words and static rules', () => {
  test('catalog words do not repeat core keys, and placeholders are well-formed', () => {
    for (const [k, v] of Object.entries(S.en)) {
      expect(k, k).toMatch(/^[a-z]+\.[A-Za-z0-9_.]+$/);
      expect((v.match(/\{/g) ?? []).length, k).toBe((v.match(/\}/g) ?? []).length);
    }
  });

  test('every catalog page renders on demand, has no third-party URLs and no personal emails', () => {
    for (const f of [...mine, ...walk('src/admin/catalog')]) {
      const src = readFileSync(path.join(root, f), 'utf8');
      if (f.startsWith('src/pages/')) expect(src, f).toMatch(/^export const prerender = false;$/m);
      const urls = (src.match(/https?:\/\/[^\s'"`)<]+/g) ?? []).filter((u) => !u.startsWith('http://www.w3.org/2000/svg') && !/^https:\/\/beezyhoney\.in\b/.test(u));
      expect(urls, f).toEqual([]);
      const emails = (src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? []).filter((e) => !/@example\.(test|com)$/.test(e));
      expect(emails, f).toEqual([]);
    }
    expect(readFileSync(path.join(root, 'src/pages/photo-library.json.ts'), 'utf8')).toMatch(/^export const prerender = true;$/m);
  });
});
