// The LOCAL D1 database (Miniflare, no Cloudflare account): create, seed, reset, run SQL.
//
//   node scripts/db-local.mjs migrate            apply db/migrations/*.sql   (npm run db:migrate:local)
//   node scripts/db-local.mjs seed               write db/seed.sql if it changed, then load it once (npm run db:seed:local)
//   node scripts/db-local.mjs reset              drop every table, then migrate + seed           (npm run db:reset:local)
//   node scripts/db-local.mjs exec <file.sql>    run a SQL file, e.g. one from scripts/restore-backup.mjs
//   node scripts/db-local.mjs sql "<SQL>"        run one statement and print the rows as JSON
//   node scripts/db-local.mjs status             applied migrations and row counts
//
// Options: --persist-to <dir>  (default: $BEEZY_STATE_DIR, else .wrangler/state — the folder `npm run dev` uses,
//          see docs/DEV-NOTES.md). Everything runs with `wrangler d1 … beezy --local`; this script never touches a
//          remote database. Stop the dev/preview server that uses the same folder before `reset`.
// Works on Windows: wrangler is started as `node node_modules/wrangler/bin/wrangler.js`, no shell involved.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_OUT as SEED_FILE, buildSeedSql, DEFAULT_SNAPSHOT, writeSeed } from './make-seed.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATABASE = 'beezy';
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** Where local state lives: --persist-to, else BEEZY_STATE_DIR, else .wrangler/state (relative to the repo) */
export function stateDir(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--persist-to');
  const dir = (i >= 0 && argv[i + 1]) || env.BEEZY_STATE_DIR || '.wrangler/state';
  return resolve(ROOT, dir);
}

/** Runs wrangler with arguments; returns { status, stdout } (stdout captured only when asked) */
function wrangler(args, { capture = false } = {}) {
  if (!existsSync(WRANGLER)) {
    throw new Error('wrangler is not installed (node_modules/wrangler). Run npm ci first.');
  }
  if (args.includes('--remote')) throw new Error('db-local never runs against a remote database');
  const r = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    // stdin closed: wrangler takes its non-interactive answer ("yes") to the migrations prompt
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

const d1 = (dir, ...args) => ['d1', ...args, DATABASE, '--local', '--persist-to', dir];

/** Runs one SQL command and returns its rows */
function query(dir, sql) {
  const r = wrangler([...d1(dir, 'execute'), '--command', sql, '--json'], { capture: true });
  if (r.status !== 0) {
    let why = '';
    try { why = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).error?.text ?? ''; } catch { /* not JSON */ }
    throw new Error(`query failed${why ? ` (${why})` : ''}: ${sql}`);
  }
  const start = r.stdout.indexOf('[');
  const parsed = JSON.parse(r.stdout.slice(start));
  return parsed.flatMap((x) => x.results ?? []);
}

function execFile(dir, file) {
  const r = wrangler([...d1(dir, 'execute'), '--file', file, '--yes']);
  if (r.status !== 0) throw new Error(`running ${file} failed`);
}

export function migrate(dir) {
  const r = wrangler(d1(dir, 'migrations', 'apply'));
  if (r.status !== 0) throw new Error('migrations failed');
}

/** Rewrites db/seed.sql only when the snapshot changed (it is a tracked file) */
function refreshSeed() {
  const text = buildSeedSql(JSON.parse(readFileSync(DEFAULT_SNAPSHOT, 'utf8')));
  const current = existsSync(SEED_FILE) ? readFileSync(SEED_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== text) {
    writeSeed(SEED_FILE, text);
    console.log('db-local: db/seed.sql rewritten from the snapshot');
  }
}

export function seed(dir) {
  refreshSeed();
  const n = Number(query(dir, 'SELECT COUNT(*) AS n FROM products')[0]?.n ?? 0);
  if (n > 0) throw new Error(`the local database in ${dir} is already seeded (${n} products). Use: node scripts/db-local.mjs reset`);
  execFile(dir, SEED_FILE);
}

/** Drops every table (children first, foreign keys deferred) so migrate + seed start from nothing */
export function dropAll(dir) {
  const tables = query(dir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid DESC")
    .map((r) => r.name)
    .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  if (!tables.length) return 0;
  const tmp = mkdtempSync(join(tmpdir(), 'beezy-db-local-'));
  try {
    const file = join(tmp, 'drop.sql');
    writeFileSync(file, `PRAGMA defer_foreign_keys = on;\n${tables.map((t) => `DROP TABLE IF EXISTS "${t}";`).join('\n')}\n`);
    execFile(dir, file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return tables.length;
}

export function reset(dir) {
  const n = dropAll(dir);
  console.log(`db-local: dropped ${n} tables`);
  migrate(dir);
  seed(dir);
}

function status(dir) {
  let migrations = [];
  try { migrations = query(dir, 'SELECT name, applied_at FROM d1_migrations ORDER BY id'); } catch { /* none yet */ }
  console.log(`db-local: ${dir}`);
  console.log(`  migrations: ${migrations.length ? migrations.map((m) => m.name).join(', ') : 'none'}`);
  if (!migrations.length) return;
  // one SELECT of sub-queries: D1 limits a compound SELECT (UNION ALL) to a few terms
  const tables = ['products', 'variants', 'stock_pools', 'batches', 'orders', 'stock_moves', 'payments', 'settings'];
  const [counts] = query(dir, `SELECT ${tables.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(', ')}`);
  console.log(`  rows: ${tables.map((t) => `${t} ${counts?.[t] ?? '?'}`).join(', ')}`);
}

function main(argv) {
  const [cmd, arg] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--persist-to');
  const dir = stateDir(argv);
  switch (cmd) {
    case 'migrate': migrate(dir); break;
    case 'seed': seed(dir); break;
    case 'reset': reset(dir); break;
    case 'exec':
      if (!arg || !existsSync(arg)) throw new Error('usage: node scripts/db-local.mjs exec <file.sql>');
      execFile(dir, resolve(arg));
      break;
    case 'sql':
      if (!arg) throw new Error('usage: node scripts/db-local.mjs sql "<SQL>"');
      console.log(JSON.stringify(query(dir, arg), null, 2));
      break;
    case 'status': status(dir); break;
    default:
      console.error('usage: node scripts/db-local.mjs <migrate|seed|reset|exec <file>|sql "<SQL>"|status> [--persist-to <dir>]');
      process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`db-local: ${e.message}`);
    process.exit(1);
  }
}
