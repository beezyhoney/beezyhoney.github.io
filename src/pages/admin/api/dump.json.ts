// GET /admin/api/dump.json            → { format, tables, counts, migrations, date }   (what "Download everything" reads)
// GET /admin/api/dump.json?table=orders&after=0 → { table, columns, rows, next }        (one page of 500 rows, rowid order)
// Owner only. The Backup screen's script reads every table page by page and builds ONE file in the daily backup
// format ({ format, manifest, chunks }), so scripts/restore-backup.mjs can restore it like any backup.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { denied, json } from '../../../admin/ops/api';
import { tableCounts } from '../../../admin/ops/data';
import { dumpPage, migrationNames } from '../../../admin/ops/system';
import { BACKUP_FORMAT, BACKUP_TABLES } from '../../../server/backup';
import { istDate, nowIso } from '../../../server/time';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const stop = denied(locals.admin, 'owner');
  if (stop) return stop;
  const table = url.searchParams.get('table');
  if (!table) {
    const at = nowIso();
    const [counts, migrations] = await Promise.all([tableCounts(env.DB, BACKUP_TABLES), migrationNames(env.DB)]);
    return json({ format: BACKUP_FORMAT, tables: BACKUP_TABLES, counts, migrations, date: istDate(at), at });
  }
  const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10);
  const page = await dumpPage(env.DB, table, Number.isFinite(after) ? after : 0);
  if (!page) return json({ error: 'unknown_table' }, 404);
  return json(page);
};
