// Captures the runtime values of the product data as it was when it lived in TypeScript
// (before the catalog refactor), so tests can prove the catalog reproduces it exactly.
// It reads the files from git, not from the working tree, so it can be re-run at any time.
//
// Usage: node scripts/capture-legacy.mjs [gitRef=b3c3489] [--out test/fixtures/legacy-data.json]
// Needs Node 22.18+ / 24 (built-in TypeScript type stripping).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = path.resolve(root, outIdx >= 0 ? args[outIdx + 1] : 'test/fixtures/legacy-data.json');
const ref = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') ?? 'b3c3489';

const FILES = ['products.ts', 'features.ts', 'batches.ts'];
const tmp = mkdtempSync(path.join(tmpdir(), 'beezy-legacy-'));
try {
  for (const f of FILES) {
    const src = execFileSync('git', ['show', `${ref}:src/data/${f}`], { cwd: root, encoding: 'utf8' });
    writeFileSync(path.join(tmp, f), src);
  }
  const load = (f) => import(pathToFileURL(path.join(tmp, f)).href);
  const products = await load('products.ts');
  const features = await load('features.ts');
  const batches = await load('batches.ts');

  const commit = execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
  const data = {
    _about: `Runtime values of src/data/{products,features,batches}.ts at ${commit}, captured by scripts/capture-legacy.mjs. Do not edit by hand.`,
    PRODUCTS: products.PRODUCTS,
    CATEGORIES: products.CATEGORIES,
    GRADES: products.GRADES,
    PRODUCT_NAMES: Object.fromEntries(products.PRODUCTS.map((p) => [p.slug, products.productName(p)])),
    FINDER_QUESTIONS: features.FINDER_QUESTIONS,
    FINDER_PROFILES: features.FINDER_PROFILES,
    BLOOM: features.BLOOM,
    BLOOM_NOTE: features.BLOOM_NOTE,
    MONTHS: features.MONTHS,
    BLOOM_TEXT: Object.fromEntries(products.PRODUCTS.map((p) => [p.slug, features.bloomText(features.BLOOM[p.slug])])),
    GIFT_SIZES: features.GIFT_SIZES,
    GIFT_JARS: features.GIFT_JARS,
    GIFT_OCCASIONS: features.GIFT_OCCASIONS,
    GIFT_EXTRAS: features.GIFT_EXTRAS,
    BATCHES: batches.BATCHES,
  };
  // JSON keeps key order, so the tests can compare order as well as values
  const json = JSON.stringify(data, null, 2) + '\n';
  if (JSON.stringify(JSON.parse(json)) !== JSON.stringify(data)) throw new Error('A value did not survive JSON (undefined or a function?)');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`legacy data from ${commit.slice(0, 7)}: ${data.PRODUCTS.length} products, ${data.CATEGORIES.length} categories, ${data.BATCHES.length} batches -> ${path.relative(root, out)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
