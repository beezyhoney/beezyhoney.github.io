// GET /api/live.json — current prices and pack availability for the public pages (contract 2).
// Edge cache 60 s (Cache API), then Cache-Control: public, max-age=30. See src/server/live.ts.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { liveJsonResponse, methodNotAllowed } from '../../server/live';

export const prerender = false;

export const GET: APIRoute = ({ request, locals }) =>
  liveJsonResponse(env, request, { ctx: (locals as { cfContext?: ExecutionContext }).cfContext });

export const POST: APIRoute = () => methodNotAllowed('GET');
