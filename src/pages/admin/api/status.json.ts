// GET /admin/api/status.json — the website status chip (src/admin/README.md "Status chip contract") and a tiny
// health flag. `website` is getPublishStatus() as it is; the deployed /build.json (read through the Worker's own
// ASSETS binding) marks finished builds live. Owner and helper; 401 when not signed in (the chip then shows
// "Login expired"). Never cached.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { denied, json } from '../../../admin/ops/api';
import { statusPayload } from '../../../admin/ops/system';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const stop = denied(locals.admin);
  if (stop) return stop;
  const body = await statusPayload(env as unknown as Parameters<typeof statusPayload>[0]);
  return json(body);
};
