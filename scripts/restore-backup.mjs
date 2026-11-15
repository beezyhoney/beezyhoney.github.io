// Turns a downloaded Beezy backup into SQL that replaces the database contents (design §7, amendment A2).
//
//   node scripts/restore-backup.mjs <backup.json | folder> --out <restore.sql> [--tables orders,order_lines,…]
//
// The output must be written OUTSIDE this repository: a backup holds customer details and the repo is public.
//
// Input: the single-file download from the admin Backup screen ({ format, manifest, chunks }), or a folder holding
// manifest.json and the chunk-NNN.json files of one day. The output deletes every row of the backed-up tables and
// inserts the backup's rows, parents first. Apply it to a database migrated to the same schema:
//   node scripts/db-local.mjs exec restore.sql            (local D1, honours --persist-to / BEEZY_STATE_DIR)
//   npx wrangler d1 execute beezy --remote --file restore.sql   (production: only after a Time Travel bookmark!)
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backupToSql, readBundle } from '../src/server/backup-format.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads a bundle file, or a folder with manifest.json + chunk files, into a bundle object */
export function loadBackup(path) {
  const p = resolve(path);
  if (statSync(p).isDirectory()) {
    const manifest = JSON.parse(readFileSync(join(p, 'manifest.json'), 'utf8'));
    const chunks = manifest.chunks.map((key) => JSON.parse(readFileSync(join(p, basename(key)), 'utf8')));
    return { format: manifest.format, manifest, chunks };
  }
  const data = JSON.parse(readFileSync(p, 'utf8'));
  if (data.manifest && Array.isArray(data.chunks)) return data;
  throw new Error(`${path} is not a Beezy backup (expected { format, manifest, chunks } or a folder)`);
}

function main(argv) {
  const args = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (!args[0]) {
    console.error('usage: node scripts/restore-backup.mjs <backup.json | folder> --out <restore.sql> [--tables a,b]');
    process.exit(2);
  }
  const bundle = loadBackup(args[0]);
  const tables = opt('--tables')?.split(',').map((s) => s.trim()).filter(Boolean);
  const counts = readBundle(bundle).filter((t) => !tables || tables.includes(t.name)).map((t) => `${t.name} ${t.rows.length}`);
  const sql = backupToSql(bundle, { tables });
  if (!opt('--out')) throw new Error('give --out <file> outside this repository (a backup holds customer data)');
  const out = resolve(opt('--out'));
  const rel = relative(ROOT, out);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error(`write the SQL outside the repository (it holds customer data), not ${out}`);
  writeFileSync(out, sql);
  console.log(`restore-backup: backup of ${bundle.manifest.date} → ${out}`);
  console.log(`  rows: ${counts.join(', ')}`);
  console.log('  apply: node scripts/db-local.mjs exec <file>   (local)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`restore-backup: ${e.message}`);
    process.exit(1);
  }
}
