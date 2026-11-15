// Phase 2 proof: the catalog snapshot reproduces exactly what products.ts / features.ts / batches.ts held
// before the data moved out of code (test/fixtures/legacy-data.json, captured from git by
// scripts/capture-legacy.mjs). Values AND key order are compared.
//
// When the catalog content changes on purpose later (owner edits pulled into the snapshot), these comparisons
// are expected to fail: update this file then, do not "fix" the snapshot back.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import legacy from '../../fixtures/legacy-data.json';
import snapshot from '../../../src/data/catalog.snapshot.json';
import { catalogData } from '../../../src/data/catalog';
import * as catalogModule from '../../../src/data/catalog';
import * as products from '../../../src/data/products';
import * as features from '../../../src/data/features';
import * as batches from '../../../src/data/batches';

const data = catalogData(snapshot, 'catalog.snapshot.json');
const NEW_PRODUCT_KEYS = ['status', 'shortCode', 'variants'];
/** A product without the fields the catalog added, keeping key order */
const legacyShape = (p: object) => Object.fromEntries(Object.entries(p).filter(([k]) => !NEW_PRODUCT_KEYS.includes(k)));
/** Exact: same values and same key order */
const same = (actual: unknown, expected: unknown) => {
  expect(actual).toStrictEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
};

describe('catalog snapshot reproduces the legacy data', () => {
  it('PRODUCTS (every legacy field, in order)', () => {
    expect(data.PRODUCTS.map((p) => p.slug)).toEqual(legacy.PRODUCTS.map((p) => p.slug));
    same(data.PRODUCTS.map(legacyShape), legacy.PRODUCTS);
  });
  it('products only gain status, shortCode and variants', () => {
    for (const p of data.PRODUCTS) {
      expect(Object.keys(p).slice(-3)).toEqual(NEW_PRODUCT_KEYS);
      expect(p.status).toBe('live');
      expect(p.variants.map((v) => v.label)).toEqual(p.packs);
    }
  });
  it('every product is live, so all three product lists are the same', () => {
    same(data.PRODUCT_PAGES, data.PRODUCTS);
    same(data.ALL_PRODUCTS, data.PRODUCTS);
  });
  it('CATEGORIES', () => same(data.CATEGORIES, legacy.CATEGORIES));
  it('FINDER_PROFILES', () => same(data.FINDER_PROFILES, legacy.FINDER_PROFILES));
  it('BLOOM', () => same(data.BLOOM, legacy.BLOOM));
  it('BLOOM_NOTE', () => same(data.BLOOM_NOTE, legacy.BLOOM_NOTE));
  it('BATCHES', () => same(data.BATCHES, legacy.BATCHES));
  it('helpers give the same results', () => {
    same(Object.fromEntries(data.PRODUCTS.map((p) => [p.slug, products.productName(p)])), legacy.PRODUCT_NAMES);
    same(Object.fromEntries(data.PRODUCTS.map((p) => [p.slug, features.bloomText(data.BLOOM[p.slug])])), legacy.BLOOM_TEXT);
  });
  it('constants that stay in code are unchanged', () => {
    same(products.GRADES, legacy.GRADES);
    same(features.FINDER_QUESTIONS, legacy.FINDER_QUESTIONS);
    same(features.MONTHS, legacy.MONTHS);
    same(features.GIFT_SIZES, legacy.GIFT_SIZES);
    same(features.GIFT_JARS, legacy.GIFT_JARS);
    same(features.GIFT_OCCASIONS, legacy.GIFT_OCCASIONS);
    same(features.GIFT_EXTRAS, legacy.GIFT_EXTRAS);
  });
});

describe('make-snapshot', () => {
  it('reproduces the committed snapshot from the legacy data and START_PRICES', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const out = execFileSync(process.execPath, ['scripts/make-snapshot.mjs', '--check'], { cwd: root, encoding: 'utf8' });
    expect(out).toMatch(/up to date: 16 products, 47 packs \(35 priced\), 18 stock pools/);
  });
});

describe('existing imports still work', () => {
  it('products.ts, features.ts and batches.ts re-export the loaded catalog', () => {
    expect(products.PRODUCTS).toBe(catalogModule.PRODUCTS);
    expect(products.CATEGORIES).toBe(catalogModule.CATEGORIES);
    expect(products.ALL_PRODUCTS).toBe(catalogModule.ALL_PRODUCTS);
    expect(products.PRODUCT_PAGES).toBe(catalogModule.PRODUCT_PAGES);
    expect(features.FINDER_PROFILES).toBe(catalogModule.FINDER_PROFILES);
    expect(features.BLOOM).toBe(catalogModule.BLOOM);
    expect(features.BLOOM_NOTE).toBe(catalogModule.BLOOM_NOTE);
    expect(batches.BATCHES).toBe(catalogModule.BATCHES);
    expect(typeof products.productName).toBe('function');
    expect(typeof features.bloomText).toBe('function');
  });
  it('the loaded catalog (generated or snapshot) is a valid catalog with products', () => {
    expect(['generated', 'snapshot']).toContain(catalogModule.CATALOG_SOURCE);
    expect(catalogModule.PRODUCTS.length).toBeGreaterThan(0);
    expect(catalogModule.SITE_VERSION).toBeGreaterThanOrEqual(1);
  });
});
