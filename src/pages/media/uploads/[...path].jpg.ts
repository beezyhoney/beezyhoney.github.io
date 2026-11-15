// GET /media/uploads/<ULID>.jpg (and /media/uploads/thumbs/<ULID>.jpg) — owner-uploaded photos for the build, from
// Workers KV MEDIA through the Cache API. Only photos used by a product or category on the website (images.public = 1);
// drafts are previewed through the admin. nosniff, a sandboxing CSP, immutable. See serveMedia() in src/server/media.ts.
// The file name ends in .jpg so the route has a file extension and Astro's trailing-slash rule never applies to it.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { serveMedia } from '../../../server/media';

export const prerender = false;

export const GET: APIRoute = ({ params, request, locals }) =>
  serveMedia(env, request, `uploads/${params.path ?? ''}.jpg`, {
    requirePublic: true,
    ctx: (locals as { cfContext?: ExecutionContext }).cfContext,
  });
