// Config the endpoints and the login depend on: wrangler.jsonc routing and bindings, package.json scripts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../../../scripts/predeploy-check.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const wrangler = parseJsonc(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('wrangler.jsonc', () => {
  it('sends browser navigations to /admin, /api and /media to the Worker first (never the static 404 page)', () => {
    // With not_found_handling and a compatibility date after 2025-04-01, an unmatched NAVIGATION is answered by the
    // assets (404 page) without running the Worker, so the admin would be unreachable in a browser.
    expect(wrangler.assets.not_found_handling).toBe('404-page');
    expect(wrangler.compatibility_date >= '2025-04-01').toBe(true);
    expect(wrangler.assets.run_worker_first).toEqual(['/admin', '/admin/*', '/api/*', '/media/*']);
  });

  it('keeps every public page a static asset (no catch-all Worker-first rule)', () => {
    for (const p of wrangler.assets.run_worker_first) expect(p).toMatch(/^\/(admin|api|media)(\/\*)?$/);
  });

  it('declares the login mail binding without addresses (none may be committed)', () => {
    expect(wrangler.send_email).toEqual([{ name: 'LOGIN_MAIL' }]);
    expect(JSON.stringify(wrangler)).not.toMatch(/@(?!example\.test)[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});

describe('package.json scripts for builds and deploys', () => {
  it('has the e2e build, catalog pull, predeploy check and a deploy that checks first', () => {
    expect(pkg.scripts['build:e2e']).toBe('node scripts/sync-catalog.mjs && astro build --mode e2e && node scripts/check-dist.mjs --mode e2e');
    expect(pkg.scripts['catalog:pull']).toBe('node scripts/sync-catalog.mjs');
    expect(pkg.scripts['predeploy-check']).toBe('node scripts/predeploy-check.mjs');
    expect(pkg.scripts.deploy).toBe('node scripts/predeploy-check.mjs && wrangler deploy');
    expect(pkg.scripts.build).toBe('node scripts/sync-catalog.mjs && astro build && node scripts/check-dist.mjs');
  });
});
