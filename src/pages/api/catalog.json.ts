// GET /api/catalog.json — the public catalog the website is built from (src/data/catalog.types.ts). Live, paused and
// retired products only; never stock amounts, customer data or private notes. See src/server/live.ts.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { catalogJsonResponse, methodNotAllowed } from '../../server/live';

export const prerender = false;

export const GET: APIRoute = ({ request, locals }) =>
  catalogJsonResponse(env, request, { ctx: (locals as { cfContext?: ExecutionContext }).cfContext });

export const POST: APIRoute = () => methodNotAllowed('GET');
