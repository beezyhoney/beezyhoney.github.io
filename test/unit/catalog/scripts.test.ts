// Build scripts: the zero-diff gate and sync-catalog's refusals. (A successful sync is exercised by every build.)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareBuilds } from '../../../scripts/zero-diff.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'beezy-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function site(name: string, files: Record<string, string>) {
  const dir = path.join(tmp, name);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

describe('zero-diff', () => {
  const page = (js: string, img: string, text = 'Hello') => `<html><script type="module" src="/_astro/${js}"></script><img src="/_astro/${img}"><p>${text}</p></html>`;
  const a = site('a', {
    'index.html': page('site.Ca4-TMR4.js', 'hero.CCwZtE_W_Z1H55HG.webp'),
    '_astro/site.Ca4-TMR4.js': 'import{a}from"./motion.BJkHjrFr.js";a()',
    '_astro/motion.BJkHjrFr.js': 'export const a=()=>1',
    '_astro/hero.CCwZtE_W_Z1H55HG.webp': 'IMG1',
  });

  it('ignores hashed names when the content is the same', () => {
    const b = site('b', {
      'index.html': page('site.Zz9-QQQQ.js', 'hero.AAAAAAAA_Z1H55HG.webp'),
      '_astro/site.Zz9-QQQQ.js': 'import{a}from"./motion.Qwerty12.js";a()',
      '_astro/motion.Qwerty12.js': 'export const a=()=>1',
      '_astro/hero.AAAAAAAA_Z1H55HG.webp': 'IMG1',
    });
    expect(compareBuilds(a, b).differences).toEqual([]);
  });

  it('reports changed text, changed images, added and removed files', () => {
    const c = site('c', {
      'index.html': page('site.Ca4-TMR4.js', 'hero.CCwZtE_W_Z1H55HG.webp', 'Hi'),
      '_astro/site.Ca4-TMR4.js': 'import{a}from"./motion.BJkHjrFr.js";a()',
      '_astro/motion.BJkHjrFr.js': 'export const a=()=>2',
      '_astro/hero.CCwZtE_W_Z1H55HG.webp': 'IMG2',
      'new.txt': 'x',
    });
    const d = compareBuilds(a, c).differences.map((x) => `${x.kind} ${x.path}`);
    expect(d).toContain('changed index.html');
    expect(d).toContain('changed _astro/motion.~.js');
    expect(d).toContain('added new.txt');
    expect(d.some((x) => x.startsWith('removed _astro/hero.~'))).toBe(true);
    expect(d.some((x) => x.startsWith('added _astro/hero.~'))).toBe(true);
  });

  it('compares image counts', () => {
    const e = site('e', {
      'index.html': page('site.Ca4-TMR4.js', 'hero.CCwZtE_W_Z1H55HG.webp'),
      '_astro/site.Ca4-TMR4.js': 'import{a}from"./motion.BJkHjrFr.js";a()',
      '_astro/motion.BJkHjrFr.js': 'export const a=()=>1',
      '_astro/hero.CCwZtE_W_Z1H55HG.webp': 'IMG1',
      '_astro/extra.CCwZtE_W_Zabc.webp': 'IMG3',
    });
    const d = compareBuilds(a, e).differences;
    expect(d.find((x) => x.path === '[image counts]')?.detail).toMatch(/webp: 1 -> 2/);
  });

  it('the CLI exits 1 on a difference and 0 when it is allowed', () => {
    const f = site('f', { 'index.html': page('site.Ca4-TMR4.js', 'hero.CCwZtE_W_Z1H55HG.webp', 'Changed'),
      '_astro/site.Ca4-TMR4.js': 'import{a}from"./motion.BJkHjrFr.js";a()', '_astro/motion.BJkHjrFr.js': 'export const a=()=>1',
      '_astro/hero.CCwZtE_W_Z1H55HG.webp': 'IMG1' });
    const run = (...extra: string[]) => spawnSync(process.execPath, ['scripts/zero-diff.mjs', a, f, ...extra], { cwd: root, encoding: 'utf8' });
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/- .*Hello/);
    expect(bad.stdout).toMatch(/\+ .*Changed/);
    expect(run('--allow', '*.html').status).toBe(0);
    expect(spawnSync(process.execPath, ['scripts/zero-diff.mjs', a], { cwd: root }).status).toBe(2);
  });
});

describe('sync-catalog', () => {
  const generated = path.join(root, 'src/data/generated/catalog.json');
  const mtime = () => { try { return statSync(generated).mtimeMs; } catch { return null; } };
  const sync = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['scripts/sync-catalog.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CATALOG_URL: '', CATALOG_FILE: '', CATALOG_SOURCE: '', ...env } });

  it('refuses an invalid catalog and leaves the generated catalog alone', () => {
    const before = mtime();
    const bad = JSON.parse(readFileSync(path.join(root, 'src/data/catalog.snapshot.json'), 'utf8'));
    bad.pools[0].onHand = 1000;
    const file = path.join(tmp, 'bad-catalog.json');
    writeFileSync(file, JSON.stringify(bad));
    const r = sync(['--file', file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown field "onHand"/);
    expect(mtime()).toBe(before);
  });

  it('refuses a catalog that names a photo that does not exist', () => {
    const bad = JSON.parse(readFileSync(path.join(root, 'src/data/catalog.snapshot.json'), 'utf8'));
    bad.products[0].photo = 'uploads/missing.jpg';
    const file = path.join(tmp, 'missing-photo.json');
    writeFileSync(file, JSON.stringify(bad));
    const r = sync(['--file', file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/photos missing.*uploads\/missing\.jpg/);
  });

  it('refuses a plain-http CATALOG_URL for a non-local host and writes nothing', () => {
    const before = mtime();
    const r = sync([], { CATALOG_URL: 'http://example.invalid/api/catalog.json' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/https/);
    expect(mtime()).toBe(before);
  });
});
