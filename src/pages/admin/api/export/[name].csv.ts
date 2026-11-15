// GET /admin/api/export/<orders|order_lines|monthly_by_product|stock_moves>.csv?from=YYYY-MM-DD&to=YYYY-MM-DD&personal=1
// CSV downloads for the owner (design §4, §7: customer name, phone, address and note only with personal=1).
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { attachment, denied, json } from '../../../../admin/ops/api';
import { exportCsv, isExportName } from '../../../../server/sales';

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
  const stop = denied(locals.admin, 'owner');
  if (stop) return stop;
  const name = params.name;
  if (!isExportName(name)) return json({ error: 'not_found' }, 404);
  const q = url.searchParams;
  const file = await exportCsv(env.DB, name, { from: q.get('from'), to: q.get('to'), personal: q.get('personal') === '1' });
  return attachment(file.csv, file.filename, 'text/csv; charset=utf-8');
};
