// Build gate (design §6), run by `npm run build` after `astro build`. Exits 1 on any failure.
// Layout from @astrojs/cloudflare: dist/client = static assets (served before the Worker), dist/server = the Worker.
//
// Fails when:
//   1. any file in dist/client mentions an /_image URL (images must be built at compile time, never at runtime);
//   2. a visitor page loads a third-party resource: src / srcset / poster / data / action, <link href> (except
//      canonical-style links), <script src>, CSS url() / @import, or a third-party URL inside JavaScript that is not
//      on the reviewed list below (WhatsApp / Instagram links, the SVG namespace, a licence comment);
//   3. any file exists under dist/client/admin (or /api, /media: a static file there would shadow the Worker route);
//   4. the WebP count drops below 90% of the baseline;
//   5. a page's JavaScript (gzip: files it loads, inline scripts, and the chunks it can import on demand later)
//      exceeds its baseline + JS_BUDGET_EXTRA_GZIP;
//   6. the production Worker code in dist/server (not its *.map source maps, which only carry the public sources)
//      contains the dev-bypass variable name or the e2e hook name, or a value from the local .dev.vars (owner
//      emails, keys) appears anywhere in dist (maps included) outside dist/server/.dev.vars.
//
// Usage: node scripts/check-dist.mjs [--dist dist] [--baseline scripts/dist-baseline.json] [--mode production|e2e]
//        node scripts/check-dist.mjs --write-baseline <path/to/baseline.json from scripts/dist-stats.mjs>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extOf, listFiles, pageScripts, pageUrl } from './dist-stats.mjs';

const root = path.resolve(import.meta.dirname, '..');

/**
 * Extra gzip JavaScript a page may load on top of its Phase 0 baseline. The design guessed 3 KB; the built price,
 * live-update, order-code/record, gift-estimate and offer-pill code measures about 6–7 KB at load plus about 1.7 KB
 * of order tools that load on demand (counted here too). 9 KB keeps a margin of under 1 KB on the heaviest page,
 * so any real growth still fails the build. (Integrator decision, 16 Nov 2026; see docs/RUNBOOK.md.)
 */
export const JS_BUDGET_EXTRA_GZIP = 9 * 1024;
/** WebP files may not drop below this share of the baseline count. */
export const WEBP_MIN_SHARE = 0.9;
/** First-party origins (absolute URLs to these are not third-party). */
export const FIRST_PARTY_ORIGINS = ['https://beezyhoney.in', 'https://www.beezyhoney.in', 'https://next.beezyhoney.in'];
/**
 * Hosts that may be NAMED inside JavaScript without loading anything from them. Reviewed by hand: a new host here
 * must be a link the visitor taps or a non-fetched identifier, never a script, style, font, image or API.
 */
export const JS_ALLOWED_HOSTS = [
  'wa.me', // WhatsApp order links (navigation)
  'api.whatsapp.com', // WhatsApp fallback link (navigation)
  'www.instagram.com', // Instagram profile link (navigation)
  'instagram.com',
  'www.w3.org', // SVG / XHTML namespace identifiers, never fetched
  'gsap.com', // GSAP licence / help text inside the bundled library
];
/** Strings that must never reach a production Worker bundle. */
export const FORBIDDEN_SERVER_STRINGS = ['DEV_ADMIN_EMAIL', 'BEEZY_E2E_HOOK'];
/** <link rel> values that do not load anything. */
const NON_LOADING_RELS = new Set(['canonical', 'alternate', 'author', 'me', 'license', 'help', 'next', 'prev', 'search', 'sitemap']);
const TEXT_EXTS = new Set(['html', 'css', 'js', 'mjs', 'json', 'xml', 'txt', 'map', 'svg', 'webmanifest']);

const ABSOLUTE_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/** True when url points at another site. Relative URLs, data:, blob:, mailto:, tel:, # are first-party. */
export function isThirdParty(url) {
  const u = String(url).trim();
  if (!ABSOLUTE_RE.test(u)) return false;
  let parsed;
  try { parsed = new URL(u.startsWith('//') ? `https:${u}` : u); } catch { return true; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return !['data:', 'blob:'].includes(parsed.protocol);
  return !FIRST_PARTY_ORIGINS.includes(parsed.origin);
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const srcsetUrls = (v) => v.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** CSS url(...) and @import targets. */
export function cssUrls(css) {
  const out = [];
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  for (const m of css.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) out.push(m[1]);
  return out;
}

/** Third-party hosts named in JavaScript text that are not on the reviewed list. */
export function jsThirdPartyHosts(code) {
  const hosts = new Set();
  for (const m of code.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = m[1].toLowerCase();
    if (!isThirdParty(`https://${host}/`)) continue;
    if (!JS_ALLOWED_HOSTS.includes(host)) hosts.add(host);
  }
  return [...hosts];
}

/** Problems in one HTML document: third-party resources and /_image URLs. */
export function checkHtml(html, file) {
  const problems = [];
  const bad = (what, url) => problems.push(`${file}: third-party ${what}: ${url}`);
  for (const [tag, name] of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const t = name.toLowerCase();
    if (t === 'a') continue; // navigation links may point anywhere (WhatsApp, Instagram)
    if (t === 'link') {
      const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const href = attr(tag, 'href');
      if (href && !rel.every((r) => NON_LOADING_RELS.has(r)) && isThirdParty(decode(href))) bad(`<link rel="${rel.join(' ')}">`, href);
      continue;
    }
    if (t === 'meta') {
      const equiv = (attr(tag, 'http-equiv') ?? '').toLowerCase();
      const content = attr(tag, 'content') ?? '';
      if (equiv === 'refresh' && /url=/i.test(content) && isThirdParty(content.split(/url=/i)[1])) bad('<meta refresh>', content);
      continue;
    }
    for (const a of ['src', 'poster', 'data', 'action', 'formaction', 'background']) {
      const v = attr(tag, a);
      if (v && isThirdParty(decode(v))) bad(`<${t} ${a}>`, v);
    }
    for (const a of ['srcset', 'imagesrcset']) {
      const v = attr(tag, a);
      if (v) for (const u of srcsetUrls(decode(v))) if (isThirdParty(u)) bad(`<${t} ${a}>`, u);
    }
    const style = attr(tag, 'style');
    if (style) for (const u of cssUrls(decode(style))) if (isThirdParty(u)) bad('style url()', u);
  }
  for (const [, css] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const u of cssUrls(css)) if (isThirdParty(u)) bad('<style> url()', u);
  }
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const type = (attr(`<x ${attrs}>`, 'type') ?? '').toLowerCase();
    if (type && type !== 'module' && type !== 'text/javascript') continue; // JSON data and JSON-LD are not run
    for (const host of jsThirdPartyHosts(body)) bad('URL in inline <script>', host);
  }
  if (html.includes('/_image')) problems.push(`${file}: contains an /_image URL (runtime image transform)`);
  return problems;
}

/** Values from a dotenv file that must never be shipped (only long enough values, never printed). */
export function secretValues(dotenvText) {
  const values = [];
  for (const line of dotenvText.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || m[1] === 'PUBLIC_HOSTS') continue; // host names, not a secret (local runs add localhost here)
    const raw = m[2].replace(/^(['"`])(.*)\1$/, '$2').trim();
    const parts = m[1] === 'ADMIN_EMAILS' ? raw.split(',').map((s) => s.trim())
      : m[1] === 'ADMIN_ALIASES' ? raw.split(/[,;=]/).map((s) => s.trim()) // alias=target pairs: each address on its own
        : [raw];
    for (const p of parts) if (p.length >= 8 && !/@example\.test$/i.test(p)) values.push(p);
  }
  return values;
}

export function checkDist({ dist = path.join(root, 'dist'), baseline, mode = 'production', devVarsPath = path.join(root, '.dev.vars') } = {}) {
  const errors = [];
  const notes = [];
  const client = path.join(dist, 'client');
  const server = path.join(dist, 'server');
  if (!existsSync(client)) return { errors: [`${client} does not exist (run astro build first)`], notes, pages: [] };

  const clientFiles = listFiles(client);
  const serverFiles = existsSync(server) ? listFiles(server) : [];

  // 3. nothing prerendered where the Worker must answer
  for (const dir of ['admin', 'api', 'media']) {
    const hits = clientFiles.filter((f) => f === dir || f.startsWith(`${dir}/`));
    if (hits.length) errors.push(`dist/client/${dir}/ must not exist (static files there are served before the Worker): ${hits.slice(0, 5).join(', ')}`);
  }
  if (clientFiles.includes('.dev.vars')) errors.push('dist/client/.dev.vars exists: local secrets would be published');

  // 1 + 2. /_image and third-party resources
  for (const f of clientFiles) {
    const ext = extOf(f);
    if (!TEXT_EXTS.has(ext)) continue;
    const text = readFileSync(path.join(client, f), 'utf8');
    if (ext === 'html') errors.push(...checkHtml(text, f));
    else {
      if (text.includes('/_image')) errors.push(`${f}: contains an /_image URL (runtime image transform)`);
      if (ext === 'css') for (const u of cssUrls(text)) if (isThirdParty(u)) errors.push(`${f}: third-party url() ${u}`);
      if (ext === 'js' || ext === 'mjs') for (const host of jsThirdPartyHosts(text)) errors.push(`${f}: third-party URL in JavaScript: ${host} (review it; if it is only a link, add it to JS_ALLOWED_HOSTS)`);
    }
  }

  // 4. WebP count
  const webp = clientFiles.filter((f) => extOf(f) === 'webp').length;
  if (baseline?.webpCount) {
    const min = Math.ceil(baseline.webpCount * WEBP_MIN_SHARE);
    if (webp < min) errors.push(`WebP count ${webp} is below ${Math.round(WEBP_MIN_SHARE * 100)}% of the baseline ${baseline.webpCount} (minimum ${min})`);
    notes.push(`WebP: ${webp} (baseline ${baseline.webpCount}, minimum ${min})`);
  } else notes.push(`WebP: ${webp} (no baseline given, not checked)`);

  // 5. JavaScript per page
  const basePages = baseline?.pages ?? {};
  const maxBase = Math.max(0, ...Object.values(basePages));
  const pages = [];
  for (const f of clientFiles.filter((x) => extOf(x) === 'html')) {
    const url = pageUrl(f);
    const s = pageScripts(client, f);
    const base = basePages[url];
    const budget = (base ?? maxBase) + JS_BUDGET_EXTRA_GZIP;
    const total = s.totalGzipBytes + (s.onDemandGzipBytes ?? 0);
    const over = baseline ? total > budget : false;
    pages.push({ url, gzip: total, load: s.totalGzipBytes, onDemand: s.onDemandGzipBytes ?? 0, raw: s.totalBytes, base: base ?? null, budget, over });
    if (over) errors.push(`${url}: JavaScript ${total} B gzip is over its budget ${budget} B (baseline ${base ?? `new page, max ${maxBase}`} + ${JS_BUDGET_EXTRA_GZIP})`);
    for (const ext of s.files.filter((x) => x.startsWith('EXTERNAL:'))) errors.push(`${url}: loads an external script ${ext.slice(9)}`);
  }

  // 6. production Worker bundle and secrets
  if (!serverFiles.length) notes.push('dist/server is empty or missing (static build?)');
  const forbidden = mode === 'e2e' ? FORBIDDEN_SERVER_STRINGS.filter((s) => s !== 'BEEZY_E2E_HOOK') : FORBIDDEN_SERVER_STRINGS;
  for (const f of serverFiles) {
    if (f === '.dev.vars') continue; // local copy for `astro preview` written by the Vite plugin; never deployed
    // Source maps carry the original sources (sourcesContent), which are public in the repo anyway and never run;
    // the check is about code that runs in production.
    if (extOf(f) === 'map') continue;
    if (!TEXT_EXTS.has(extOf(f))) continue;
    const text = readFileSync(path.join(server, f), 'utf8');
    for (const s of forbidden) if (text.includes(s)) errors.push(`dist/server/${f} contains "${s}" (must be compiled out of production builds)`);
  }
  if (serverFiles.includes('.dev.vars')) notes.push('dist/server/.dev.vars is the local preview copy of .dev.vars (gitignored, never uploaded)');
  if (existsSync(devVarsPath)) {
    const secrets = secretValues(readFileSync(devVarsPath, 'utf8'));
    const all = [...clientFiles.map((f) => ['client', f]), ...serverFiles.filter((f) => f !== '.dev.vars').map((f) => ['server', f])];
    for (const [side, f] of all) {
      if (!TEXT_EXTS.has(extOf(f))) continue;
      const text = readFileSync(path.join(dist, side, f), 'utf8');
      if (secrets.some((v) => text.includes(v))) errors.push(`dist/${side}/${f} contains a value from .dev.vars (secret or owner email)`);
    }
    notes.push(`checked ${secrets.length} local secret value(s) from .dev.vars: none may appear in dist`);
  }
  return { errors, notes, pages, webp };
}

/** Compact budget file (committed) from a full scripts/dist-stats.mjs baseline. */
export function budgetFromStats(stats, meta = {}) {
  return {
    note: 'Budget for scripts/check-dist.mjs, made from the Phase 0 baseline build (dist-stats). Regenerate with --write-baseline.',
    ...meta,
    webpCount: stats.webpCount,
    pages: Object.fromEntries(Object.entries(stats.pages).map(([url, p]) => [url, p.totalGzipBytes])),
  };
}

function main(argv) {
  const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const defaultBaseline = path.join(root, 'scripts/dist-baseline.json');
  if (argv.includes('--write-baseline')) {
    const src = opt('--write-baseline');
    const stats = JSON.parse(readFileSync(src, 'utf8'));
    const out = opt('--out', defaultBaseline);
    writeFileSync(out, JSON.stringify(budgetFromStats(stats, { gitCommit: stats.gitCommit, createdAt: stats.createdAt }), null, 2) + '\n');
    console.log(`check-dist: wrote ${path.relative(root, out)} (${stats.webpCount} WebP, ${Object.keys(stats.pages).length} pages)`);
    return 0;
  }
  const dist = path.resolve(opt('--dist', path.join(root, 'dist')));
  const baselinePath = opt('--baseline', process.env.BEEZY_DIST_BASELINE || defaultBaseline);
  const mode = opt('--mode', 'production');
  let baseline;
  if (existsSync(baselinePath)) {
    const raw = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline = raw.pages && typeof Object.values(raw.pages)[0] === 'object' ? budgetFromStats(raw) : raw;
  } else console.warn(`check-dist: no baseline at ${baselinePath}; WebP and JS budgets are not checked`);

  const { errors, notes, pages } = checkDist({ dist, baseline, mode });
  console.log(`check-dist: ${path.relative(root, dist) || dist} (mode ${mode})`);
  console.log('  page                                   JS gzip (at load + on demand)   baseline    budget');
  for (const p of pages.sort((a, b) => a.url.localeCompare(b.url))) {
    console.log(`  ${p.over ? '!' : ' '} ${p.url.padEnd(36)} ${String(p.gzip).padStart(8)} (${String(p.load).padStart(6)} + ${String(p.onDemand).padStart(5)}) ${String(p.base ?? 'new').padStart(10)} ${String(p.budget).padStart(9)}`);
  }
  for (const n of notes) console.log(`  - ${n}`);
  if (errors.length) {
    console.error(`check-dist: FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
    for (const e of errors.slice(0, 100)) console.error(`  ✗ ${e}`);
    if (errors.length > 100) console.error(`  … and ${errors.length - 100} more`);
    return 1;
  }
  console.log(`check-dist: OK (${pages.length} pages, JS budget = baseline + ${JS_BUDGET_EXTRA_GZIP} B gzip)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
