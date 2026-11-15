// The daily backup format and its restore SQL. Plain JavaScript on purpose: src/server/backup.ts (Worker) writes
// backups in this format, and scripts/restore-backup.mjs (Node) turns one back into SQL for `wrangler d1 execute`.
//
// A backup of IST day D lives in the KV namespace BACKUPS:
//   daily/D/chunk-001.json, chunk-002.json, …   { format, date, chunk, tables: [{ name, columns, rows }] }
//   daily/D/manifest.json (written last)          { format, date, startedAt, finishedAt, migrations, tables, chunks, bytes }
// A table may continue over several chunks (rows in rowid order). Rows are arrays in `columns` order.
// A downloaded backup ("bundle") is one JSON file: { format, manifest, chunks: [chunk, …] }.

export const BACKUP_FORMAT = 1;

/**
 * Tables in a backup, parents before children (the restore inserts in this order and deletes in reverse).
 * Not backed up: login_codes, admin_sessions and recovery_codes (secrets, re-made by logging in),
 * rate_limits (short-lived counters) and job_runs (the backup's own bookkeeping).
 */
export const BACKUP_TABLES = Object.freeze([
  'settings', 'admin_users', 'images', 'categories', 'products', 'product_images', 'stock_pools', 'variants',
  'price_history', 'harvests', 'batches', 'batch_items', 'orders', 'order_lines', 'stock_moves', 'payments', 'counters',
  'audit_log', 'publishes',
]);

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** SQL literal for a JSON value from a backup */
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`bad number in backup: ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`unexpected value in backup: ${JSON.stringify(v)}`);
}

/**
 * Checks a bundle ({ format, manifest, chunks }) and returns per-table { columns, rows } in BACKUP_TABLES order.
 * Throws on anything inconsistent (wrong format, missing chunk, row count different from the manifest).
 */
export function readBundle(bundle) {
  if (!bundle || bundle.format !== BACKUP_FORMAT) throw new Error('not a Beezy backup (format 1)');
  const m = bundle.manifest;
  if (!m || m.format !== BACKUP_FORMAT || !Array.isArray(m.chunks) || typeof m.tables !== 'object') throw new Error('the backup has no valid manifest');
  if (!Array.isArray(bundle.chunks) || bundle.chunks.length !== m.chunks.length) throw new Error(`the backup should have ${m.chunks.length} chunks, found ${bundle.chunks?.length ?? 0}`);
  const tables = new Map();
  bundle.chunks.forEach((c, i) => {
    if (!c || c.format !== BACKUP_FORMAT || c.chunk !== i + 1 || c.date !== m.date) throw new Error(`chunk ${i + 1} does not belong to this backup`);
    for (const t of c.tables) {
      if (!BACKUP_TABLES.includes(t.name)) throw new Error(`unknown table in backup: ${t.name}`);
      if (!Array.isArray(t.columns) || !t.columns.every((col) => IDENT.test(col))) throw new Error(`bad columns for ${t.name}`);
      const cur = tables.get(t.name);
      if (cur && cur.columns.join(',') !== t.columns.join(',')) throw new Error(`columns of ${t.name} differ between chunks`);
      const entry = cur ?? { columns: t.columns, rows: [] };
      for (const r of t.rows) {
        if (!Array.isArray(r) || r.length !== t.columns.length) throw new Error(`bad row in ${t.name}`);
        entry.rows.push(r);
      }
      tables.set(t.name, entry);
    }
  });
  for (const [name, count] of Object.entries(m.tables)) {
    const got = tables.get(name)?.rows.length ?? 0;
    if (got !== count) throw new Error(`${name}: the manifest says ${count} rows, the chunks hold ${got}`);
  }
  return BACKUP_TABLES.filter((n) => n in m.tables).map((name) => ({ name, columns: tables.get(name)?.columns ?? [], rows: tables.get(name)?.rows ?? [] }));
}

/**
 * SQL that replaces the contents of the backed-up tables with the backup: deletes in reverse order, inserts in
 * order, at most `rowsPerInsert` rows and about 90 KB per INSERT (D1 statement limit 100 KB).
 * Apply to a database migrated to the same schema: wrangler d1 execute beezy --local --file restore.sql
 * @param {{format:number, manifest:object, chunks:object[]}} bundle
 * @param {{ tables?: string[], rowsPerInsert?: number }} [opts]
 */
export function backupToSql(bundle, opts = {}) {
  const tables = readBundle(bundle).filter((t) => !opts.tables || opts.tables.includes(t.name));
  const per = opts.rowsPerInsert ?? 200;
  const out = [
    `-- Beezy Honey backup of ${bundle.manifest.date} (made ${bundle.manifest.finishedAt ?? '?'}), restore SQL.`,
    `-- Replaces every row of: ${tables.map((t) => t.name).join(', ')}.`,
    'PRAGMA defer_foreign_keys = on;',
  ];
  for (const t of [...tables].reverse()) out.push(`DELETE FROM ${t.name};`);
  for (const t of tables) {
    if (!t.rows.length) continue;
    const head = `INSERT INTO ${t.name} (${t.columns.join(', ')}) VALUES\n`;
    let batch = [];
    let size = 0;
    const flush = () => { if (batch.length) out.push(`${head}${batch.join(',\n')};`); batch = []; size = 0; };
    for (const r of t.rows) {
      const text = `(${r.map(lit).join(', ')})`;
      if (batch.length >= per || size + text.length > 90_000) flush();
      batch.push(text);
      size += text.length;
    }
    flush();
  }
  return `${out.join('\n')}\n`;
}
