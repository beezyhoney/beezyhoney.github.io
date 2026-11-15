// The last gate before `wrangler deploy` (design §2.5 and §12). Workers Builds runs the deploy command
// `npm run deploy` (= this script, then `wrangler deploy`) after `npm run build`, in the same folder.
//
// It refuses to deploy (exit 1) when:
//   1. dist is missing or incomplete (dist/client/build.json, dist/client/index.html, dist/server/entry.mjs,
//      dist/server/wrangler.json);
//   2. dist/server holds code that must never go live: the e2e login hook or the local dev login bypass (an
//      `astro build --mode e2e` or a dev build); *.map files (the public sources) and the local .dev.vars copy
//      (never uploaded) are skipped;
//   3. dist/client has .dev.vars, or anything under admin/, api/ or media/ (it would shadow the Worker routes);
//   4. the build did not use the live catalog (build.json source is 'snapshot' or 'file'), unless
//      ALLOW_SNAPSHOT_DEPLOY=1 (first deploy before D1 is seeded, or an emergency; design §10 Phase 7);
//   5. the Worker config still has placeholder resource ids (the all-zero D1 / KV ids in wrangler.jsonc), or its
//      PUBLIC_HOSTS lists localhost / 127.0.0.1 (those are for .dev.vars only: deployed, they would act as admin host);
//   6. it is a downgrade: the site that is live now (/build.json on LIVE_ORIGIN, else the CATALOG_URL origin, else
//      PUBLIC_ORIGIN from the Worker config) already shows a higher siteVersion, unless ALLOW_DOWNGRADE=1.
//      When the live /build.json cannot be read (the first deploy, GitHub Pages, offline) it says so and goes on.
//
// Usage: node scripts/predeploy-check.mjs [--dist dist] [--live <origin> | --no-live]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

/** Strings that only exist in e2e or dev builds (the same list scripts/check-dist.mjs uses). */
export const FORBIDDEN_SERVER_STRINGS = ['BEEZY_E2E_HOOK', 'DEV_ADMIN_EMAIL'];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** JSON with // and /* comments (wrangler.jsonc), comments outside strings only. */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** A resource id that is still the committed placeholder (almost all zeros). */
export const isPlaceholderId = (id) => typeof id !== 'string' || !id.trim() || id.replace(/[-0]/g, '').length <= 4;

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Every check that needs no network. Returns { problems: string[], notes: string[], build, config }.
 * `env` supplies ALLOW_SNAPSHOT_DEPLOY.
 */
export function localChecks(distDir, env = process.env) {
  const problems = [];
  const notes = [];
  const client = path.join(distDir, 'client');
  const server = path.join(distDir, 'server');
  for (const f of ['client/build.json', 'client/index.html', 'server/entry.mjs', 'server/wrangler.json']) {
    if (!existsSync(path.join(distDir, f))) problems.push(`missing ${path.join(path.basename(distDir), f)}: run npm run build first`);
  }
  const build = readJsonFile(path.join(client, 'build.json'));
  if (existsSync(path.join(client, 'build.json')) && (!build || !Number.isInteger(build.siteVersion))) problems.push('dist/client/build.json is not a valid build file');

  // *.map files carry the public sources; .dev.vars is the local preview copy (never uploaded by wrangler deploy)
  for (const file of walk(server).filter((f) => !f.endsWith('.map') && !path.basename(f).startsWith('.dev.vars'))) {
    const text = readFileSync(file, 'latin1');
    for (const s of FORBIDDEN_SERVER_STRINGS) {
      if (text.includes(s)) problems.push(`${path.relative(distDir, file)} contains ${s}: this is an e2e or dev build, never deploy it (run npm run build)`);
    }
  }
  if (existsSync(path.join(client, '.dev.vars'))) problems.push('dist/client/.dev.vars exists: local secrets would be published');
  for (const d of ['admin', 'api', 'media']) {
    if (walk(path.join(client, d)).length) problems.push(`dist/client/${d}/ has files: they would shadow the Worker routes`);
  }

  if (build && build.source !== 'remote') {
    if (env.ALLOW_SNAPSHOT_DEPLOY === '1') notes.push(`build source is "${build.source}" (allowed by ALLOW_SNAPSHOT_DEPLOY=1)`);
    else problems.push(`this build used the ${build.source === 'file' ? 'catalog file' : 'committed snapshot'}, not the live catalog (CATALOG_URL). `
      + 'Set ALLOW_SNAPSHOT_DEPLOY=1 only for the first deploy or an emergency.');
  }

  const config = readJsonFile(path.join(server, 'wrangler.json'));
  if (existsSync(path.join(server, 'wrangler.json')) && !config) problems.push('dist/server/wrangler.json is not valid JSON');
  if (config) {
    for (const d of config.d1_databases ?? []) if (isPlaceholderId(d.database_id)) problems.push(`D1 binding ${d.binding} still has the placeholder database_id (fill in the real id in wrangler.jsonc)`);
    for (const k of config.kv_namespaces ?? []) if (isPlaceholderId(k.id)) problems.push(`KV binding ${k.binding} still has a placeholder id (fill in the real id in wrangler.jsonc)`);
    if (!(config.d1_databases ?? []).length) problems.push('the Worker config has no D1 database');
    const local = String(config.vars?.PUBLIC_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => ['localhost', '127.0.0.1'].includes(h));
    if (local.length) problems.push(`PUBLIC_HOSTS in the Worker config lists ${local.join(' and ')}: local names belong in .dev.vars only`);
  }
  return { problems, notes, build, config };
}

/** Where the live site is: --live, LIVE_ORIGIN, the CATALOG_URL origin, PUBLIC_ORIGIN from the Worker config. */
export function liveOrigin(args, env, config) {
  if (args.includes('--no-live')) return null;
  const i = args.indexOf('--live');
  const candidates = [i >= 0 ? args[i + 1] : '', env.LIVE_ORIGIN, env.CATALOG_URL, config?.vars?.PUBLIC_ORIGIN];
  for (const c of candidates) {
    if (!c || !String(c).trim()) continue;
    try {
      const u = new URL(String(c).trim());
      if (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return u.origin;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** The siteVersion live now, or null with the reason. */
export async function liveSiteVersion(origin, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${origin}/build.json`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' }, cache: 'no-store' });
    if (res.status !== 200) return { version: null, reason: `HTTP ${res.status}` };
    const j = await res.json();
    return Number.isInteger(j?.siteVersion) ? { version: j.siteVersion, reason: null } : { version: null, reason: 'no siteVersion in it' };
  } catch (e) {
    return { version: null, reason: e?.message ?? String(e) };
  }
}

export async function predeployCheck(args = process.argv.slice(2), env = process.env, { fetchImpl = fetch, log = console.log } = {}) {
  const i = args.indexOf('--dist');
  const distDir = path.resolve(i >= 0 ? args[i + 1] : path.join(root, 'dist'));
  const { problems, notes, build, config } = localChecks(distDir, env);
  const origin = liveOrigin(args, env, config);
  if (build && origin) {
    const live = await liveSiteVersion(origin, fetchImpl);
    if (live.version === null) notes.push(`could not read ${origin}/build.json (${live.reason}); no downgrade check`);
    else if (live.version > build.siteVersion) {
      if (env.ALLOW_DOWNGRADE === '1') notes.push(`downgrade allowed by ALLOW_DOWNGRADE=1: live ${live.version} → this build ${build.siteVersion}`);
      else problems.push(`downgrade: ${origin} already shows site version ${live.version}, this build has ${build.siteVersion}. `
        + 'Run the build again (it fetches the newest catalog), or set ALLOW_DOWNGRADE=1 if this is really wanted.');
    } else notes.push(`live site version ${live.version}, this build ${build.siteVersion}`);
  } else if (build) notes.push('no live origin known; no downgrade check');
  for (const n of notes) log(`predeploy-check: ${n}`);
  return { ok: problems.length === 0, problems, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = await predeployCheck();
  if (!r.ok) {
    console.error(`predeploy-check: NOT deploying (${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}):\n  ${r.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('predeploy-check: OK');
}
