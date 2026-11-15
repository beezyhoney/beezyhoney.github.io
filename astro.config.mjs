import { execFileSync } from 'node:child_process';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';

/** Commit being built: Workers Builds / GitHub Actions variables first, then the local git checkout. */
function buildCommit() {
  const fromCi = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA;
  if (fromCi) return fromCi.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Where scripts/sync-catalog.mjs took the catalog from (same precedence as that script). */
function catalogSource() {
  if (process.env.CATALOG_FILE) return 'file';
  if (process.env.CATALOG_SOURCE !== 'snapshot' && (process.env.CATALOG_URL ?? '').trim()) return 'remote';
  return 'snapshot';
}

// Baked into /build.json (src/pages/build.json.ts) through a Vite define, because prerendering runs inside workerd,
// where process.env and git are not available.
const BUILD_INFO = { builtAt: new Date().toISOString(), commit: buildCommit(), source: catalogSource() };

/** Production / staging host names accepted by the local dev and preview servers (see server.allowedHosts). */
const LOCAL_TEST_HOSTS = ['beezyhoney.in', 'next.beezyhoney.in', 'admin.beezyhoney.in', 'staging.beezyhoney.in', 'staging-admin.beezyhoney.in'];

/**
 * Page CSS is minified in the server environments (prerender, ssr). Without the adapter their cssTarget was 'esnext'
 * (Lightning CSS keeps rules as written); the Cloudflare Vite plugin defaults it to 'es2024', which rewrites some rules
 * (e.g. splits `text-decoration: underline 1px` into two declarations). This keeps 'esnext' so the public CSS stays
 * byte-identical. It runs after the Cloudflare plugin ('post'); `vite.environments` set through Astro did not reach it.
 */
const keepServerCssTarget = {
  name: 'beezy:server-css-target',
  enforce: 'post',
  configEnvironment(name) {
    if (name === 'ssr' || name === 'prerender') return { build: { cssTarget: 'esnext' } };
  },
};

/** Sitemap: public pages only (on-demand routes are never listed; this also guards against a prerendered one). */
export const sitemapFilter = (page) => !/\/(admin|api|media)\//.test(new URL(page).pathname);

// Live at the custom domain https://beezyhoney.in. Served from the root, so no `base`.
// `site` makes the canonical links, social previews and sitemap use the real address.
//
// Every public page stays prerendered (static assets, the Worker never runs for them). Only /api/*, /media/* and
// /admin/* render on demand in the Cloudflare Worker (wrangler.jsonc, src/worker.ts, src/middleware.ts).
//
// Local state for D1 / KV (Miniflare) lives in BEEZY_STATE_DIR (default .wrangler/state), so parallel checkouts or
// agents can each use their own database: `BEEZY_STATE_DIR=.wrangler/state-mine npm run dev`. The same folder must be
// given to `wrangler d1 ... --local --persist-to <dir>` (scripts/db-local.mjs does this). See docs/DEV-NOTES.md.
const stateDir = process.env.BEEZY_STATE_DIR || '.wrangler/state';
// The workerd inspector is off by default so dev/preview never grabs a port outside the one you choose.
// Set BEEZY_INSPECTOR_PORT=<port> to debug the Worker with Chrome DevTools.
const inspectorPort = process.env.BEEZY_INSPECTOR_PORT ? Number(process.env.BEEZY_INSPECTOR_PORT) : false;

export default defineConfig({
  site: 'https://beezyhoney.in',
  trailingSlash: 'always',
  compressHTML: true,
  build: { format: 'directory' },
  // Let `astro dev` / `astro preview` answer requests that carry the real host names (curl -H "Host: …"), so host
  // routing in src/middleware.ts can be tested locally. Unknown Host headers are still blocked (DNS rebinding guard).
  server: { allowedHosts: LOCAL_TEST_HOSTS },
  adapter: cloudflare({
    // Prerendered pages keep today's sharp → hashed /_astro/*.webp output; nothing is transformed at runtime.
    imageService: 'compile',
    persistState: { path: stateDir },
    inspectorPort,
  }),
  // No Astro sessions (and so no SESSION KV binding): the admin login keeps its own session in D1.
  session: false,
  // CSRF protection for on-demand form posts (the admin's plain HTML forms). The middleware adds its own
  // Sec-Fetch-Site / Origin check for every unsafe method on top.
  security: { checkOrigin: true },
  vite: {
    define: { __BEEZY_BUILD_INFO__: JSON.stringify(BUILD_INFO) },
    plugins: [keepServerCssTarget],
  },
  integrations: [sitemap({ filter: sitemapFilter })],
});
