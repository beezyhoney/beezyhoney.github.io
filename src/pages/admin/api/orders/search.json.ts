// GET /admin/api/orders/search.json?q=7K3QD — the find box as JSON (full or partial order code, customer name or
// phone; codes are not unique, so several orders may come back, newest first). Owner and helper.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { denied, json } from '../../../../admin/ops/api';
import { searchOrders } from '../../../../server/orders';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const stop = denied(locals.admin);
  if (stop) return stop;
  const q = (url.searchParams.get('q') ?? '').slice(0, 80);
  const rows = await searchOrders(env.DB, q, { limit: 20 });
  return json({
    q,
    results: rows.map((r) => ({
      id: r.id, ref: r.ref, status: r.status, source: r.source, createdAt: r.createdAt, totalPaise: r.totalPaise, paidPaise: r.paidPaise,
      items: r.items, isTest: r.isTest, href: `/admin/orders/${r.id}/`,
    })),
  });
};
