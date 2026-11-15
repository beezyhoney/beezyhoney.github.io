// GET /media/uploads/<ULID>.jpg in workerd with the real KV (MEDIA), D1 and Cache API: only public photos, safe
// headers, immutable caching; drafts, unknown keys and tricks are 404.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as mediaGET } from '../../../src/pages/media/uploads/[...path].jpg';
import { serveMedia } from '../../../src/server/media';
import { fakeCtx, MemoryCache, seedDb, sql } from './_seed';

const ORIGIN = 'https://beezyhoney.in';
const PUBLIC_ID = '01JD0000000000000000000001';
const DRAFT_ID = '01JD0000000000000000000002';
// a tiny byte string that starts like a JPEG (serving does not decode it)
const jpeg = (tag: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, tag, 0xff, 0xd9]);

async function addUpload(id: string, isPublic: boolean) {
  for (const key of [`uploads/${id}.jpg`, `uploads/thumbs/${id}.jpg`]) {
    await env.MEDIA.put(key, jpeg(isPublic ? 1 : 2), { metadata: { contentType: 'image/jpeg', width: 1200, height: 900, bytes: 14 } });
  }
  await sql(`INSERT INTO images (path, source, thumb_path, width, height, bytes, public, created_at, created_by)
    VALUES (?, 'upload', ?, 1200, 900, 14, ?, '2026-11-15T10:00:00Z', 'owner@example.test')`,
  `uploads/${id}.jpg`, `uploads/thumbs/${id}.jpg`, isPublic ? 1 : 0).run();
}

const get = (path: string) => {
  const ctx = fakeCtx();
  const url = new URL(`${ORIGIN}/media/uploads/${path}.jpg`);
  return mediaGET({ request: new Request(url), url, params: { path }, locals: { cfContext: ctx } } as never);
};

beforeAll(async () => {
  await seedDb();
  await addUpload(PUBLIC_ID, true);
  await addUpload(DRAFT_ID, false);
});

describe('/media/uploads/…', () => {
  it('serves a public photo with nosniff, a sandboxing CSP and an immutable cache', async () => {
    const res = await get(PUBLIC_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(jpeg(1));
  });

  it('serves the thumbnail of a public photo', async () => {
    const res = await get(`thumbs/${PUBLIC_ID}`);
    expect(res.status).toBe(200);
  });

  it('a draft (not public) photo, an unknown photo and odd paths are 404', async () => {
    for (const p of [DRAFT_ID, `thumbs/${DRAFT_ID}`, '01JD0000000000000000000009', '../uploads/' + PUBLIC_ID, `${PUBLIC_ID}.jpg`, 'x', `thumbs/../${PUBLIC_ID}`]) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      expect(res.headers.get('content-type'), p).toMatch(/^text\/plain/);
    }
  });

  it('reads through the Cache API first, so KV reads stay low', async () => {
    const cache = new MemoryCache();
    const url = `${ORIGIN}/media/uploads/${PUBLIC_ID}.jpg`;
    const a = await serveMedia(env, new Request(url), `uploads/${PUBLIC_ID}.jpg`, { requirePublic: true, cache });
    expect(a.status).toBe(200);
    expect(cache.puts).toEqual([url]);
    // even if the KV value went away, the cached copy answers
    await env.MEDIA.delete(`uploads/${PUBLIC_ID}.jpg`);
    const b = await serveMedia(env, new Request(`${url}?v=2`), `uploads/${PUBLIC_ID}.jpg`, { requirePublic: true, cache });
    expect(b.status).toBe(200);
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(jpeg(1));
    await env.MEDIA.put(`uploads/${PUBLIC_ID}.jpg`, jpeg(1), { metadata: { contentType: 'image/jpeg', width: 1200, height: 900, bytes: 14 } });
  });
});
