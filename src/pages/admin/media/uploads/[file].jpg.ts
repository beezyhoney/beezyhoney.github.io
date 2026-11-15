// GET /admin/media/uploads/<ULID>.jpg — preview of an uploaded photo in the admin, drafts included (design §4).
// Private, short cache, nosniff and a sandboxing CSP (src/server/media.ts serveMedia). Unknown names → 404.
// The route has a file extension, so Astro never adds a trailing slash to it.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { serveMedia } from '../../../../server/media';

export const prerender = false;

export const GET: APIRoute = ({ params, request }) =>
  serveMedia(env as unknown as Env, request, `uploads/${String(params.file ?? '')}.jpg`, { requirePublic: false });
