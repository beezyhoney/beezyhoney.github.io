// POST /admin/api/media.json — photo upload for the admin (design §8, amendment A2). Owner and helper.
// The browser (src/admin/catalog/upload.ts) has already resized the photo (long edge ≤ 2400 px), re-encoded it as
// JPEG (which drops EXIF and GPS) and made a 480 px thumbnail. This endpoint checks everything again:
//   multipart/form-data with `file` (the photo) and `thumb` (the thumbnail), at most 8 MB for the photo;
//   JPEG magic bytes, frame size from the SOF marker, short edge ≥ 800 px;
//   metadata stripped again on the server (APP1 Exif/XMP, APP13 IPTC, COM);
//   random ULID keys uploads/<ULID>.jpg + uploads/thumbs/<ULID>.jpg in KV MEDIA, an `images` row (not public until a
//   product on the website uses it) and an audit row — all in src/server/media.ts saveUpload().
// Answers JSON, never cached: 200 { ok: true, path, thumbPath, width, height, url, thumbUrl } or
// 4xx { ok: false, error, message, field }.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { MAX_THUMB_BYTES, MAX_UPLOAD_BYTES, saveUpload } from '../../../server/media';
import type { Actor } from '../../../server/db';

export const prerender = false;

/** Largest request body accepted: the photo, the thumbnail and the multipart framing */
export const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + MAX_THUMB_BYTES + 64 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

const problem = (status: number, message: string, field = 'file', error = 'invalid') => json(status, { ok: false, error, message, field });

async function bytesOf(part: FormDataEntryValue | null): Promise<Uint8Array | null> {
  if (!part || typeof part === 'string') return null;
  return new Uint8Array(await part.arrayBuffer());
}

/** The upload handler, with its bindings passed in (worker tests call it directly) */
export async function handleUpload(request: Request, admin: Actor | undefined, bindings: Pick<Env, 'DB' | 'MEDIA'>): Promise<Response> {
  if (!admin) return problem(401, 'Please sign in again.', 'file', 'forbidden');
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('multipart/form-data')) return problem(415, 'Send the photo as a form upload.');
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return problem(413, 'The photo is too big (8 MB at most).');
  let form: FormData;
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return problem(413, 'The photo is too big (8 MB at most).');
    form = await new Response(body, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
  } catch {
    return problem(400, 'The upload could not be read. Please try again.');
  }
  const bytes = await bytesOf(form.get('file'));
  const thumbBytes = await bytesOf(form.get('thumb'));
  if (!bytes) return problem(400, 'Choose a photo.');
  if (!thumbBytes) return problem(400, 'The preview image is missing. Try again.', 'thumb');
  const r = await saveUpload({ DB: bindings.DB, MEDIA: bindings.MEDIA }, admin, { bytes, thumbBytes });
  if (!r.ok) return problem(r.error === 'invalid' ? 422 : 409, r.message, r.field ?? 'file', r.error);
  const v = r.value;
  return json(200, { ok: true, path: v.path, thumbPath: v.thumbPath, width: v.width, height: v.height, bytes: v.bytes, url: `/admin/media/${v.path}`, thumbUrl: `/admin/media/${v.thumbPath}` });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const admin = (locals as { admin?: Actor }).admin;
  return handleUpload(request, admin, env as unknown as Env);
};

export const GET: APIRoute = () => problem(405, 'Use POST to upload a photo.', 'file', 'not_allowed');
