// POST /api/orders.json — the website's order record (contract 3, design §2.3). Always 204 with no body; the visitor's
// WhatsApp message never waits for it. Checks, limits and storage: src/server/intake.ts.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleIntake } from '../../server/intake';
import { methodNotAllowed } from '../../server/live';

export const prerender = false;

export const POST: APIRoute = ({ request, locals }) =>
  handleIntake(env, request, { ctx: (locals as { cfContext?: ExecutionContext }).cfContext });

export const GET: APIRoute = () => methodNotAllowed('POST');
