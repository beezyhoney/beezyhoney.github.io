// GET /admin/api/backups/<YYYY-MM-DD>.json — one saved daily backup from KV BACKUPS (amendment A2) as a single
// downloadable file { format, manifest, chunks }. Owner only. scripts/restore-backup.mjs turns it into restore SQL.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { attachment, denied, json } from '../../../../admin/ops/api';
import { readBackup } from '../../../../server/backup';
import { isDate } from '../../../../server/time';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const stop = denied(locals.admin, 'owner');
  if (stop) return stop;
  const date = params.date ?? '';
  if (!isDate(date)) return json({ error: 'not_found' }, 404);
  let bundle;
  try {
    bundle = await readBackup({ DB: env.DB, BACKUPS: env.BACKUPS }, date);
  } catch (e) {
    return json({ error: 'incomplete', message: String((e as Error)?.message ?? e) }, 409);
  }
  if (!bundle) return json({ error: 'not_found' }, 404);
  return attachment(JSON.stringify(bundle), `beezy-backup-${date}.json`, 'application/json; charset=utf-8');
};
