// Phase 3 configuration: wrangler.jsonc, astro.config.mjs, .gitignore, .dev.vars.example, robots.txt, _headers,
// package.json and the on-demand route files.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

describe('wrangler.jsonc', () => {
  const config = unstable_readConfig({ config: path.join(root, 'wrangler.jsonc') }, { hideWarnings: true });
  const raw = read('wrangler.jsonc');

  it('is the beezyhoney Worker with the custom entry', () => {
    expect(config.name).toBe('beezyhoney');
    expect(path.relative(root, config.main ?? '').split(path.sep).join('/')).toBe('src/worker.ts');
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is never served on workers.dev or preview URLs', () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });

  it('serves the static client output with trailing-slash HTML and the 404 page', () => {
    expect(config.assets).toMatchObject({ binding: 'ASSETS', html_handling: 'force-trailing-slash', not_found_handling: '404-page' });
    expect(path.relative(root, config.assets?.directory ?? '').split(path.sep).join('/')).toBe('dist/client');
    // Selective Worker-first: only on-demand areas; public pages stay free static assets.
    expect(config.assets?.run_worker_first).toEqual(['/admin', '/admin/*', '/api/*', '/media/*']);
  });

  it('binds D1, the two KV namespaces and the login mail', () => {
    expect(config.d1_databases).toEqual([expect.objectContaining({ binding: 'DB', database_name: 'beezy', migrations_dir: 'db/migrations' })]);
    expect(config.kv_namespaces.map((k) => k.binding)).toEqual(['MEDIA', 'BACKUPS']);
    expect(config.r2_buckets).toEqual([]);
  });

  it('declares send_email WITHOUT any address restriction (no email is committed)', () => {
    expect(config.send_email).toEqual([{ name: 'LOGIN_MAIL' }]);
    expect(raw).not.toMatch(/destination_address|allowed_destination_addresses|allowed_sender_addresses/);
    expect(raw).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it('runs the cron every 15 minutes', () => {
    expect(config.triggers.crons).toEqual(['*/15 * * * *']);
  });

  it('has the host vars and no secrets; the deployed hosts never include localhost (review: security 3)', () => {
    expect(config.vars).toEqual({
      PUBLIC_HOSTS: 'beezyhoney.in,next.beezyhoney.in',
      ADMIN_HOST: 'admin.beezyhoney.in',
      PUBLIC_ORIGIN: 'https://beezyhoney.in',
    });
    for (const secret of ['ADMIN_EMAILS', 'ADMIN_ALIASES', 'LOGIN_SECRET', 'IP_HASH_KEY', 'DEPLOY_HOOK_URL', 'DEV_ADMIN_EMAIL']) {
      expect(raw).not.toMatch(new RegExp(`"${secret}"\\s*:`));
    }
  });

  it('turns observability on', () => {
    expect(config.observability?.enabled).toBe(true);
  });

  it('keeps an optional staging environment with its own resources', () => {
    const staging = unstable_readConfig({ config: path.join(root, 'wrangler.jsonc'), env: 'staging' }, { hideWarnings: true });
    expect(staging.name).toBe('beezyhoney-staging');
    expect(staging.d1_databases[0].database_name).toBe('beezy-staging');
    expect(staging.d1_databases[0].database_id).not.toBe(config.d1_databases[0].database_id);
    expect(staging.send_email).toEqual([{ name: 'LOGIN_MAIL' }]);
    expect(staging.workers_dev).toBe(false);
    expect(staging.vars.PUBLIC_HOSTS).toBe('staging.beezyhoney.in');
  });
});

describe('astro.config.mjs', async () => {
  const mod = await import('../../../astro.config.mjs');
  const config = mod.default as Record<string, any>;

  it('keeps the site settings', () => {
    expect(config.site).toBe('https://beezyhoney.in');
    expect(config.trailingSlash).toBe('always');
    expect(config.build).toMatchObject({ format: 'directory' });
    expect(config.compressHTML).toBe(true);
  });

  it('uses the Cloudflare adapter with sessions off and origin checks on', () => {
    expect(config.adapter.name).toBe('@astrojs/cloudflare');
    expect(config.session).toBe(false);
    expect(config.security).toEqual({ checkOrigin: true });
  });

  it('keeps admin, api and media out of the sitemap', () => {
    const f = mod.sitemapFilter as (u: string) => boolean;
    expect(f('https://beezyhoney.in/')).toBe(true);
    expect(f('https://beezyhoney.in/shop/murungai-honey/')).toBe(true);
    expect(f('https://beezyhoney.in/admin/')).toBe(false);
    expect(f('https://beezyhoney.in/admin/orders/')).toBe(false);
    expect(f('https://beezyhoney.in/api/live.json/')).toBe(false);
    expect(f('https://beezyhoney.in/media/uploads/x/')).toBe(false);
  });
});

describe('ignored and example files', () => {
  const ignored = (p: string) => {
    try { execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: root }); return true; } catch { return false; }
  };

  it('ignores local secrets, wrangler state, state folders and downloaded uploads', () => {
    for (const p of ['.dev.vars', '.dev.vars.staging', '.wrangler/state/v3/d1/x.sqlite', '.wrangler/state-agent/v3/x', '.beezy-state-a/v3/x', 'src/assets/img/uploads/01J.jpg', 'dist/client/index.html', '.env']) {
      expect(ignored(p), p).toBe(true);
    }
    expect(ignored('.dev.vars.example')).toBe(false);
    expect(ignored('wrangler.jsonc')).toBe(false);
    expect(ignored('worker-configuration.d.ts')).toBe(false);
  });

  it('.dev.vars.example has every local variable, with placeholders only', () => {
    const text = read('.dev.vars.example');
    const vars = Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(Object.keys(vars).sort()).toEqual(['ADMIN_ALIASES', 'ADMIN_EMAILS', 'DEPLOY_HOOK_URL', 'DEV_ADMIN_EMAIL', 'IP_HASH_KEY', 'LOGIN_SECRET', 'PUBLIC_HOSTS']);
    expect(vars.PUBLIC_HOSTS).toBe('beezyhoney.in,next.beezyhoney.in,localhost,127.0.0.1'); // local runs: localhost acts as public + admin host
    for (const email of text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []) expect(email).toMatch(/@example\.test$/);
    expect(vars.LOGIN_SECRET).not.toMatch(/^[0-9a-f]{64}$/);
    expect(vars.DEPLOY_HOOK_URL).toBe('');
  });
});

describe('public files', () => {
  it('robots.txt keeps the sitemap and disallows the on-demand areas', () => {
    const robots = read('public/robots.txt');
    for (const line of ['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /media/', 'Disallow: /admin/', 'Disallow: /photo-library.json', 'Sitemap: https://beezyhoney.in/sitemap-index.xml']) {
      expect(robots).toContain(line);
    }
  });

  it('_headers sets nosniff and referrer policy for assets and no-store for /build.json, without HSTS', () => {
    const h = read('public/_headers');
    expect(h).toMatch(/^\/\*\n {2}X-Content-Type-Options: nosniff\n {2}Referrer-Policy: strict-origin-when-cross-origin$/m);
    expect(h).toMatch(/^\/build\.json\n {2}Cache-Control: no-store$/m);
    expect(h).not.toMatch(/Strict-Transport-Security/i);
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(read('package.json'));

  it('pins the Cloudflare toolchain exactly', () => {
    expect(pkg.dependencies['@astrojs/cloudflare']).toMatch(/^\d+\.\d+\.\d+$/);
    for (const d of ['wrangler', '@cloudflare/vitest-plugin', 'vitest']) expect(pkg.devDependencies[d], d).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has the build, test and local database scripts', () => {
    expect(pkg.scripts.build).toBe('node scripts/sync-catalog.mjs && astro build && node scripts/check-dist.mjs');
    for (const s of ['dev', 'preview', 'test', 'test:unit', 'test:worker', 'db:migrate:local', 'db:seed:local', 'db:reset:local', 'types', 'check-dist']) {
      expect(pkg.scripts[s], s).toBeTruthy();
    }
  });
});

describe('on-demand route files', () => {
  const walk = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).flatMap((e) => (statSync(path.join(dir, e)).isDirectory() ? walk(path.join(dir, e)) : [path.join(dir, e)])) : [];

  it('every page or endpoint under src/pages/admin, /api and /media sets prerender = false', () => {
    const files = ['admin', 'api', 'media'].flatMap((d) => walk(path.join(root, 'src/pages', d))).filter((f) => /\.(astro|ts|js|mjs)$/.test(f));
    expect(files.length).toBeGreaterThan(0); // at least /api/health.json
    const missing = files.filter((f) => !/export\s+const\s+prerender\s*=\s*false\b/.test(readFileSync(f, 'utf8')));
    expect(missing.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('/build.json is prerendered', () => {
    expect(read('src/pages/build.json.ts')).toMatch(/export\s+const\s+prerender\s*=\s*true\b/);
  });
});
