// GET /admin/media/uploads/thumbs/<ULID>.jpg — the 480 px thumbnail of an uploaded photo, for the admin pickers
// (drafts included). Same rules as the full-size preview next door.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { serveMedia } from '../../../../../server/media';

export const prerender = false;

export const GET: APIRoute = ({ params, request }) =>
  serveMedia(env as unknown as Env, request, `uploads/thumbs/${String(params.file ?? '')}.jpg`, { requirePublic: false });
