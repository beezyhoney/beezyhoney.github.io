// scripts/check-dist.mjs: every gate on small synthetic dist folders.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  JS_BUDGET_EXTRA_GZIP,
  budgetFromStats,
  checkDist,
  checkHtml,
  cssUrls,
  isThirdParty,
  jsThirdPartyHosts,
  secretValues,
} from '../../../scripts/check-dist.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'beezy-check-dist-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function makeDist(files: Record<string, string>): string {
  const dir = path.join(tmp, `d${n++}`);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

const page = (body = '', head = '') =>
  `<!doctype html><html><head><link rel="canonical" href="https://beezyhoney.in/"><link rel="stylesheet" href="/_astro/a.css">${head}</head><body>${body}<script type="module" src="/_astro/site.js"></script></body></html>`;

const good = {
  'client/index.html': page('<a href="https://wa.me/911234">WhatsApp</a><a href="https://www.instagram.com/x/">Insta</a><img src="/_astro/a.webp" srcset="/_astro/a.webp 1x, /_astro/b.webp 2x">'),
  'client/shop/index.html': page('<script type="application/ld+json">{"sameAs":"https://www.instagram.com/x/","logo":"https://cdn.example.com/x.png"}</script>'),
  'client/_astro/a.css': 'body{background:url(/_astro/bg.webp)}@font-face{src:url(data:font/woff2;base64,AA==)}',
  'client/_astro/site.js': 'const w="https://wa.me/"+n;const ns="http://www.w3.org/2000/svg";',
  'client/_astro/a.webp': 'x',
  'client/_astro/b.webp': 'x',
  'server/entry.mjs': 'export default {fetch(){}}',
  'server/entry.mjs.map': '{"sourcesContent":["if (import.meta.env.DEV) { env.DEV_ADMIN_EMAIL }"]}',
  'server/.dev.vars': "DEV_ADMIN_EMAIL='dev@example.test'\n",
};
const noSecrets = path.join(tmp, 'no-such.dev.vars');

describe('isThirdParty', () => {
  it.each([
    ['/_astro/a.js', false],
    ['_astro/a.js', false],
    ['#top', false],
    ['data:image/png;base64,AA', false],
    ['blob:https://beezyhoney.in/1', false],
    ['mailto:a@b.c', false],
    ['https://beezyhoney.in/og.jpg', false],
    ['https://next.beezyhoney.in/x', false],
    ['https://cdn.example.com/x.js', true],
    ['//cdn.example.com/x.js', true],
    ['http://beezyhoney.in/x', true],
    ['https://beezyhoney.in.evil.example/x', true],
    ['ftp://example.com/x', true],
  ])('%s → %s', (url, expected) => {
    expect(isThirdParty(url)).toBe(expected);
  });
});

describe('checkHtml', () => {
  it('passes navigation links, canonical links and JSON-LD', () => {
    expect(checkHtml(good['client/index.html'], 'index.html')).toEqual([]);
    expect(checkHtml(good['client/shop/index.html'], 'shop/index.html')).toEqual([]);
  });

  it.each([
    ['<script src="https://cdn.example.com/a.js"></script>', '<script src>'],
    ['<link rel="stylesheet" href="https://fonts.example.com/css">', '<link rel="stylesheet">'],
    ['<link rel="preconnect" href="https://fonts.example.com">', '<link rel="preconnect">'],
    ['<link rel="icon" href="//cdn.example.com/i.png">', '<link rel="icon">'],
    ['<img src="https://img.example.com/a.jpg">', '<img src>'],
    ['<img srcset="/a.webp 1x, https://img.example.com/b.webp 2x">', '<img srcset>'],
    ['<iframe src="https://maps.example.com/embed"></iframe>', '<iframe src>'],
    ['<form action="https://forms.example.com/submit"></form>', '<form action>'],
    ['<div style="background:url(https://img.example.com/bg.jpg)"></div>', 'style url()'],
    ['<style>.a{background:url("https://img.example.com/bg.jpg")}</style>', '<style> url()'],
    ['<script>fetch("https://api.example.com/track")</script>', 'inline <script>'],
    ['<meta http-equiv="refresh" content="0;url=https://evil.example/">', '<meta refresh>'],
  ])('flags %s', (html, what) => {
    const problems = checkHtml(page(html), 'p.html');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(what);
  });

  it('flags /_image URLs', () => {
    expect(checkHtml(page('<img src="/_image/?href=%2Fa.jpg&w=100">'), 'p.html').join()).toContain('/_image');
  });
});

describe('helpers', () => {
  it('cssUrls finds url() and @import targets', () => {
    expect(cssUrls(`@import "https://x.example/a.css";a{b:url( '/a.webp' )}c{d:url(e.png)}`)).toEqual(['/a.webp', 'e.png', 'https://x.example/a.css']);
  });

  it('jsThirdPartyHosts ignores reviewed hosts and first-party ones', () => {
    expect(jsThirdPartyHosts('"https://wa.me/1" "http://www.w3.org/2000/svg" "https://beezyhoney.in/x" "https://gsap.com/docs"')).toEqual([]);
    expect(jsThirdPartyHosts('import("https://cdn.example.com/x.js");fetch("https://api.example.org/v1")')).toEqual(['cdn.example.com', 'api.example.org']);
  });

  it('secretValues picks long values and splits the admin emails, never example.test addresses', () => {
    const v = secretValues("# c\nDEV_ADMIN_EMAIL=dev@example.test\nADMIN_EMAILS='first@mail.example, second@mail.example'\nLOGIN_SECRET=0123456789abcdef\nIP_HASH_KEY=short\nDEPLOY_HOOK_URL=\n");
    expect(v).toEqual(['first@mail.example', 'second@mail.example', '0123456789abcdef']);
    // login aliases: every address of the alias=target pairs on its own
    expect(secretValues('ADMIN_ALIASES=one@site.example=first@mail.example, two@site.example=x@example.test\n'))
      .toEqual(['one@site.example', 'first@mail.example', 'two@site.example']);
  });

  it('budgetFromStats keeps webpCount and gzip per page', () => {
    const b = budgetFromStats({ webpCount: 5, pages: { '/': { totalGzipBytes: 100 }, '/a/': { totalGzipBytes: 200 } } });
    expect(b.webpCount).toBe(5);
    expect(b.pages).toEqual({ '/': 100, '/a/': 200 });
  });
});

describe('checkDist', () => {
  const baseline = { webpCount: 2, pages: { '/': 100_000, '/shop/': 100_000 } };

  it('passes a clean build (source maps may mention the dev variable; .dev.vars is skipped)', () => {
    const r = checkDist({ dist: makeDist(good), baseline, devVarsPath: noSecrets });
    expect(r.errors).toEqual([]);
    expect(r.pages.map((p) => p.url).sort()).toEqual(['/', '/shop/']);
  });

  it('fails on prerendered files where the Worker must answer', () => {
    for (const dir of ['admin', 'api', 'media']) {
      const r = checkDist({ dist: makeDist({ ...good, [`client/${dir}/index.html`]: page() }), baseline, devVarsPath: noSecrets });
      expect(r.errors.join('\n')).toContain(`dist/client/${dir}/ must not exist`);
    }
  });

  it('fails on /_image in CSS or JS and on third-party URLs in JS and CSS files', () => {
    const r = checkDist({
      dist: makeDist({
        ...good,
        'client/_astro/a.css': 'a{background:url(/_image?href=x)}b{c:url(https://cdn.example.com/x.png)}',
        'client/_astro/site.js': 'fetch("https://tracker.example.net/p")',
      }),
      baseline,
      devVarsPath: noSecrets,
    });
    const all = r.errors.join('\n');
    expect(all).toContain('_astro/a.css: contains an /_image URL');
    expect(all).toContain('third-party url() https://cdn.example.com/x.png');
    expect(all).toContain('tracker.example.net');
  });

  it('fails when WebP files drop below 90% of the baseline', () => {
    const r = checkDist({ dist: makeDist(good), baseline: { ...baseline, webpCount: 3 }, devVarsPath: noSecrets });
    expect(r.errors.join('\n')).toContain('WebP count 2 is below 90% of the baseline 3');
  });

  it('fails when a page loads more JavaScript than its baseline + the extra budget', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `const v${i}=${(i * 7919) % 104729};`).join('');
    const r = checkDist({ dist: makeDist({ ...good, 'client/_astro/site.js': big }), baseline: { webpCount: 2, pages: { '/': 10, '/shop/': 10 } }, devVarsPath: noSecrets });
    expect(r.errors.join('\n')).toMatch(/\/: JavaScript \d+ B gzip is over its budget/);
    expect(r.pages.find((p) => p.url === '/')?.budget).toBe(10 + JS_BUDGET_EXTRA_GZIP);
  });

  it('counts the chunks a page can import on demand (Vite writes them with backticks) in its total', () => {
    const lazy = Array.from({ length: 3000 }, (_, i) => `const w${i}=${(i * 7919) % 104729};`).join('');
    const dist = makeDist({ ...good, 'client/_astro/site.js': 'const t=()=>import(`./tools.js`);', 'client/_astro/tools.js': 'import"./dep.js";' + lazy, 'client/_astro/dep.js': 'export const d=1;' });
    const r = checkDist({ dist, baseline: { webpCount: 2, pages: { '/': 10, '/shop/': 10 } }, devVarsPath: noSecrets });
    const home = r.pages.find((p) => p.url === '/')!;
    expect(home.onDemand).toBeGreaterThan(1000);
    expect(home.gzip).toBe(home.load + home.onDemand);
    expect(r.errors.join('\n')).toMatch(/\/: JavaScript \d+ B gzip is over its budget/);
  });

  it('gives a new page the largest baseline budget', () => {
    const r = checkDist({ dist: makeDist({ ...good, 'client/new/index.html': page() }), baseline, devVarsPath: noSecrets });
    expect(r.pages.find((p) => p.url === '/new/')).toMatchObject({ base: null, budget: 100_000 + JS_BUDGET_EXTRA_GZIP });
  });

  it('fails when production Worker code contains the dev bypass or the e2e hook', () => {
    const dist = makeDist({ ...good, 'server/chunks/a.mjs': 'const e = env.DEV_ADMIN_EMAIL; globalThis.BEEZY_E2E_HOOK = 1;' });
    const prod = checkDist({ dist, baseline, devVarsPath: noSecrets }).errors.join('\n');
    expect(prod).toContain('dist/server/chunks/a.mjs contains "DEV_ADMIN_EMAIL"');
    expect(prod).toContain('dist/server/chunks/a.mjs contains "BEEZY_E2E_HOOK"');
    const e2e = checkDist({ dist, baseline, mode: 'e2e', devVarsPath: noSecrets }).errors.join('\n');
    expect(e2e).toContain('DEV_ADMIN_EMAIL');
    expect(e2e).not.toContain('BEEZY_E2E_HOOK');
  });

  it('fails when a value from .dev.vars leaks into dist (never printing it)', () => {
    const secret = 'super-secret-login-key-1234567890';
    const devVars = path.join(tmp, 'leak.dev.vars');
    writeFileSync(devVars, `LOGIN_SECRET=${secret}\n`);
    const r = checkDist({ dist: makeDist({ ...good, 'server/chunks/b.mjs': `const k="${secret}"`, 'server/.dev.vars': `LOGIN_SECRET=${secret}\n` }), baseline, devVarsPath: devVars });
    const all = r.errors.join('\n');
    expect(all).toContain('dist/server/chunks/b.mjs contains a value from .dev.vars');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('.dev.vars contains'); // the preview copy itself is allowed
  });

  it('fails when .dev.vars would be published as a static file', () => {
    const r = checkDist({ dist: makeDist({ ...good, 'client/.dev.vars': 'X=1' }), baseline, devVarsPath: noSecrets });
    expect(r.errors.join('\n')).toContain('dist/client/.dev.vars exists');
  });

  it('reports a missing build', () => {
    expect(checkDist({ dist: path.join(tmp, 'nope'), baseline }).errors[0]).toContain('does not exist');
  });

  // spawns two Node processes: give it room on a busy machine
  it('CLI exits 1 on failure and 0 on success, printing the per-page table', { timeout: 30_000 }, () => {
    const okDist = makeDist(good);
    const badDist = makeDist({ ...good, 'client/admin/index.html': page() });
    const baselineFile = path.join(tmp, 'baseline.json');
    writeFileSync(baselineFile, JSON.stringify(baseline));
    const run = (dist: string) => spawnSync(process.execPath, ['scripts/check-dist.mjs', '--dist', dist, '--baseline', baselineFile], { cwd: root, encoding: 'utf8' });
    const ok = run(okDist);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('JS gzip');
    expect(ok.stdout).toContain('check-dist: OK');
    const bad = run(badDist);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('dist/client/admin/ must not exist');
  });
});
