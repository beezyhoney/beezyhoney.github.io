// GET /api/batch.json?code=MUR-2611-01 — Know Your Jar live lookup: public batch fields only, 60 s cache.
// Answers { found: false } or { found: true, code, productSlug, productName, harvested, packed, bestBefore, note }.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { batchJsonResponse, methodNotAllowed } from '../../server/live';

export const prerender = false;

export const GET: APIRoute = ({ request, locals }) =>
  batchJsonResponse(env, request, { ctx: (locals as { cfContext?: ExecutionContext }).cfContext });

export const POST: APIRoute = () => methodNotAllowed('GET');
