// Owner-uploaded photos in Workers KV (amendment A2: KV namespace MEDIA, no R2).
//   uploads/<ULID>.jpg         the photo (long edge ≤ 2400 px, re-encoded in the browser)
//   uploads/thumbs/<ULID>.jpg  its 480 px thumbnail
// value = JPEG bytes, metadata = { contentType, width, height, bytes }. The D1 `images` row (path = KV key) says
// whether the photo is public. /media/uploads/… serves public photos through the Cache API first, so KV reads stay
// low; /admin/media/uploads/… previews drafts. The MediaStore interface keeps R2 swappable later.
import { type Actor, type D1, type Result, auditInsert, fail, first, ok, stmt, tryBatch, all } from './db';
import { nowIso } from './time';

// ───────────────────────────── KV and Cache shapes ─────────────────────────────

/** The subset of a Workers KV namespace this code uses (env.MEDIA, env.BACKUPS) */
export interface KVLike {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream'; cacheTtl?: number } | 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<unknown>;
  getWithMetadata<M = unknown>(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream'; cacheTtl?: number } | 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<{ value: unknown; metadata: M | null }>;
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: { metadata?: unknown; expirationTtl?: number; expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string; expiration?: number; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
}

/** The subset of the Cache API used (caches.default in Workers) */
export interface CacheLike {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}

export interface MediaMeta { contentType: string; width: number; height: number; bytes: number }

/** Storage for uploaded photos (KV today, R2 possible later) */
export interface MediaStore {
  put(key: string, bytes: Uint8Array, meta: MediaMeta): Promise<void>;
  get(key: string): Promise<{ body: ArrayBuffer; meta: MediaMeta } | null>;
  delete(key: string): Promise<void>;
}

/** MediaStore on a KV namespace */
export function kvMediaStore(kv: KVLike): MediaStore {
  return {
    async put(key, bytes, meta) {
      await kv.put(key, bytes, { metadata: meta });
    },
    async get(key) {
      const r = await kv.getWithMetadata<MediaMeta>(key, { type: 'arrayBuffer' });
      if (r.value === null || r.value === undefined) return null;
      const body = r.value as ArrayBuffer;
      return { body, meta: r.metadata ?? { contentType: 'image/jpeg', width: 0, height: 0, bytes: body.byteLength } };
    },
    async delete(key) {
      await kv.delete(key);
    },
  };
}

// ───────────────────────────── keys ─────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = '[0-9A-HJKMNP-TV-Z]{26}';
const UPLOAD_KEY_RE = new RegExp(`^uploads/(?:thumbs/)?${ULID_RE}\\.jpg$`);

/** A new ULID (26 characters: 48-bit time + 80 random bits), sortable by upload time */
export function newUlid(atMs: number = Date.now()): string {
  let time = '';
  let t = atMs;
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  return time + Array.from(rnd, (b) => CROCKFORD[b % 32]).join('');
}

/** KV keys (= image paths) for an upload */
export const uploadKeys = (ulid: string) => ({ path: `uploads/${ulid}.jpg`, thumbPath: `uploads/thumbs/${ulid}.jpg` });

/** True for 'uploads/<ULID>.jpg' and 'uploads/thumbs/<ULID>.jpg' */
export const isUploadKey = (key: string): boolean => UPLOAD_KEY_RE.test(key);

// ───────────────────────────── JPEG checks ─────────────────────────────

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_THUMB_BYTES = 1024 * 1024;
export const MIN_SHORT_EDGE = 800;

const isJpeg = (b: Uint8Array) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Width and height from the JPEG frame header (SOFn), or null when it is not a readable JPEG */
export function jpegInfo(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(bytes)) return null;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const m = bytes[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan before any frame header
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return null;
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      if (len < 7) return null;
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Removes metadata segments from the whole file: APP1 (Exif, XMP — GPS lives here), APP13 (IPTC) and COM, also
 * between the scans of a progressive JPEG, and cuts the file at its end-of-image marker (anything appended after
 * it, e.g. a second picture with its own Exif, is dropped). Keeps APP0 (JFIF), APP2 (ICC colour profile), APP14
 * (Adobe), the tables and the scans. Returns null when the bytes are not a well-formed JPEG (no end-of-image too).
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  if (!isJpeg(bytes)) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  let ended = false;
  while (i + 2 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const m = bytes[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xd9) { parts.push(bytes.subarray(i, i + 2)); ended = true; break; } // end of image: cut here
    if (m === 0xd8) return null; // a second start of image at the top level
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { parts.push(bytes.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > bytes.length) return null;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return null;
    if (m === 0xda) {
      // start of scan: its header, then entropy-coded data up to the next marker (FF00 is a stuffed byte, FFD0–FFD7
      // are restart markers inside the data)
      let j = i + 2 + len;
      while (j < bytes.length && !(bytes[j] === 0xff && j + 1 < bytes.length && bytes[j + 1] !== 0x00 && !(bytes[j + 1] >= 0xd0 && bytes[j + 1] <= 0xd7))) j++;
      parts.push(bytes.subarray(i, j));
      i = j;
      continue;
    }
    const drop = m === 0xe1 || m === 0xed || m === 0xfe;
    if (!drop) parts.push(bytes.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!ended || parts.length < 3) return null;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ───────────────────────────── upload ─────────────────────────────

export interface MediaEnv { DB: D1; MEDIA: KVLike }

export interface Uploaded { path: string; thumbPath: string; width: number; height: number; bytes: number }

/**
 * Stores an upload (POST /admin/api/media.json): checks both files are JPEGs, the photo's short edge is at least
 * 800 px, strips metadata again on the server, writes photo + thumbnail to KV with metadata, then inserts the
 * `images` row (public = 0 until a product on the website uses it) and an audit row.
 * Errors: invalid (field 'file' / 'thumb').
 */
export async function saveUpload(env: MediaEnv, actor: Actor, input: { bytes: Uint8Array; thumbBytes: Uint8Array }, at: string = nowIso()): Promise<Result<Uploaded>> {
  const { bytes, thumbBytes } = input ?? ({} as never);
  if (!(bytes instanceof Uint8Array) || !bytes.length) return fail('invalid', 'Choose a photo.', { field: 'file' });
  if (bytes.length > MAX_UPLOAD_BYTES) return fail('invalid', 'The photo is too big (8 MB at most).', { field: 'file' });
  if (!isJpeg(bytes)) return fail('invalid', 'Please choose a JPG photo.', { field: 'file' });
  const info = jpegInfo(bytes);
  if (!info) return fail('invalid', 'This photo could not be read. Please choose another JPG.', { field: 'file' });
  if (Math.min(info.width, info.height) < MIN_SHORT_EDGE) return fail('invalid', `The photo is too small (at least ${MIN_SHORT_EDGE} px on the short side).`, { field: 'file' });
  if (!(thumbBytes instanceof Uint8Array) || !isJpeg(thumbBytes) || thumbBytes.length > MAX_THUMB_BYTES || !jpegInfo(thumbBytes)) return fail('invalid', 'The preview image is missing or broken. Try again.', { field: 'thumb' });
  const clean = stripJpegMetadata(bytes);
  const cleanThumb = stripJpegMetadata(thumbBytes);
  if (!clean || !cleanThumb) return fail('invalid', 'This photo could not be read. Please choose another JPG.', { field: 'file' });
  const thumbInfo = jpegInfo(cleanThumb)!;

  const { path, thumbPath } = uploadKeys(newUlid(Date.parse(at)));
  const store = kvMediaStore(env.MEDIA);
  await store.put(path, clean, { contentType: 'image/jpeg', width: info.width, height: info.height, bytes: clean.length });
  await store.put(thumbPath, cleanThumb, { contentType: 'image/jpeg', width: thumbInfo.width, height: thumbInfo.height, bytes: cleanThumb.length });
  const res = await tryBatch(env.DB, [
    stmt(env.DB, `INSERT INTO images (path, source, thumb_path, width, height, bytes, public, created_at, created_by)
      VALUES (?, 'upload', ?, ?, ?, ?, 0, ?, ?)`, path, thumbPath, info.width, info.height, clean.length, at, actor.email),
    auditInsert(env.DB, { at, actor, action: 'media.upload', entity: 'image', entityId: path, summary: `Photo uploaded (${info.width} × ${info.height})` }),
  ]);
  if (!res.ok) return res;
  return ok({ path, thumbPath, width: info.width, height: info.height, bytes: clean.length });
}

/** UPDATE that makes photos public (add to the batch that puts a product or category on the website) */
export function setImagesPublicStmt(db: D1, paths: string[]) {
  return stmt(db, 'UPDATE images SET public = 1 WHERE public = 0 AND path IN (SELECT value FROM json_each(?))', JSON.stringify([...new Set(paths)]));
}

/** Uploaded photos no product, gallery or category uses (listed on the Backup screen for manual clean-up) */
export async function orphanUploads(db: D1): Promise<{ path: string; thumbPath: string | null; createdAt: string; bytes: number | null }[]> {
  const rows = await all<{ path: string; thumb_path: string | null; created_at: string; bytes: number | null }>(db, `SELECT i.path, i.thumb_path, i.created_at, i.bytes FROM images i
    WHERE i.source = 'upload'
      AND NOT EXISTS (SELECT 1 FROM products p WHERE p.photo = i.path OR p.card_photo = i.path)
      AND NOT EXISTS (SELECT 1 FROM product_images g WHERE g.image = i.path)
      AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.image = i.path)
    ORDER BY i.created_at`);
  return rows.map((r) => ({ path: r.path, thumbPath: r.thumb_path, createdAt: r.created_at, bytes: r.bytes }));
}

// ───────────────────────────── serving ─────────────────────────────

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/**
 * Serves an uploaded photo by its KV key.
 * - public route (/media/uploads/…, `requirePublic: true`): only photos whose images row is public; answers from
 *   the Cache API when it can and stores the response there (in waitUntil); immutable for a year.
 * - admin route (/admin/media/uploads/…, `requirePublic: false`): any uploaded photo, private, short cache.
 * Always nosniff and a sandboxing CSP. Unknown keys → 404.
 */
export async function serveMedia(env: MediaEnv, request: Request, key: string, opts: { requirePublic: boolean; cache?: CacheLike | null; ctx?: { waitUntil(p: Promise<unknown>): void } }): Promise<Response> {
  if (!isUploadKey(key)) return notFound();
  const cache = opts.requirePublic ? (opts.cache === undefined ? (globalThis as { caches?: { default?: CacheLike } }).caches?.default ?? null : opts.cache) : null;
  const cacheKey = new URL(request.url).origin + new URL(request.url).pathname;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const img = await first<{ public: number }>(env.DB, 'SELECT public FROM images WHERE path = ? OR thumb_path = ? LIMIT 1', key, key);
  if (!img || (opts.requirePublic && img.public !== 1)) return notFound();
  const file = await kvMediaStore(env.MEDIA).get(key);
  if (!file) return notFound();
  const res = new Response(file.body, {
    headers: {
      'content-type': file.meta.contentType || 'image/jpeg',
      'content-length': String(file.body.byteLength),
      'cache-control': opts.requirePublic ? 'public, max-age=31536000, immutable' : 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
  if (cache) {
    const put = cache.put(cacheKey, res.clone());
    if (opts.ctx) opts.ctx.waitUntil(put); else await put;
  }
  return res;
}
