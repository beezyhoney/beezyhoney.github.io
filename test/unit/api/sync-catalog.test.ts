// scripts/sync-catalog.mjs remote mode: HTTPS rule, strict validation, upload downloads with JPEG and length checks,
// the upload cache, retired-product redirects. Runs in-process with a fake fetch and temporary folders, so the real
// generated catalog, snapshot and photos are never touched (the repo photo folder is only read).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkRemoteUrl, imagePaths, isCompleteJpeg, REDIRECTS_MARKER, redirectsFor, sync, SyncError,
} from '../../../scripts/sync-catalog.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const REPO_IMG = path.join(root, 'src/assets/img');
const snapshot = JSON.parse(readFileSync(path.join(root, 'src/data/catalog.snapshot.json'), 'utf8'));
const tmp = mkdtempSync(path.join(tmpdir(), 'bz-sync-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const URL_ENV = { CATALOG_URL: 'https://shop.example/api/catalog.json' };
const ULID = '01JD0000000000000000000ABC';
const UPLOAD = `uploads/${ULID}.jpg`;
const photo = (n = 300) => {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  b[n - 2] = 0xff;
  b[n - 1] = 0xd9;
  return b;
};

type Route = { status?: number; type?: string; body: Uint8Array | string; length?: string | null };

/** A fake server: path → answer. Counts requests per path. */
function server(routes: Record<string, Route>) {
  const hits: Record<string, number> = {};
  const fetchImpl = async (url: string) => {
    const u = new URL(url);
    hits[u.pathname] = (hits[u.pathname] ?? 0) + 1;
    const r = routes[u.pathname];
    if (!r) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    const bytes = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body;
    const headers: Record<string, string> = { 'content-type': r.type ?? 'application/json' };
    if (r.length !== null) headers['content-length'] = r.length ?? String(bytes.length);
    return new Response(bytes, { status: r.status ?? 200, headers });
  };
  return { fetchImpl, hits };
}

let n = 0;
/** Temporary output, cache, redirects and snapshot paths; images from `imgDir` (default: an empty temp folder). */
function dirs(imgDir?: string) {
  const d = path.join(tmp, `run-${++n}`);
  mkdirSync(d, { recursive: true });
  const img = imgDir ?? path.join(d, 'img');
  return {
    d,
    img,
    out: path.join(d, 'out/catalog.json'),
    args: ['--out', path.join(d, 'out/catalog.json'), '--img-dir', img, '--cache-dir', path.join(d, 'cache'),
      '--redirects', path.join(d, '_redirects'), '--snapshot', path.join(d, 'snapshot.json')],
  };
}

const quiet = (fetchImpl: unknown) => ({ fetchImpl, log: () => {} });

/** Every photo of the snapshot replaced by one upload, so the temp image folder can start empty. */
function uploadsOnly() {
  const c = structuredClone(snapshot);
  for (const cat of c.categories) cat.image = UPLOAD;
  for (const p of c.products) {
    p.photo = UPLOAD;
    p.card = null;
    for (const g of p.gallery) g.src = UPLOAD;
  }
  return c;
}

describe('remote catalog', () => {
  it('only https (plain http only for localhost), no credentials', () => {
    expect(checkRemoteUrl('https://beezyhoney.in/api/catalog.json').origin).toBe('https://beezyhoney.in');
    expect(checkRemoteUrl('http://127.0.0.1:4421/api/catalog.json').origin).toBe('http://127.0.0.1:4421');
    expect(() => checkRemoteUrl('http://beezyhoney.in/api/catalog.json')).toThrow(/https/);
    expect(() => checkRemoteUrl('https://user:pw@beezyhoney.in/')).toThrow(/user name/);
    expect(() => checkRemoteUrl('ftp://x')).toThrow(SyncError);
  });

  it('fetches, validates and writes the catalog; the snapshot is written only with --save-snapshot', async () => {
    const t = dirs(REPO_IMG);
    const s = server({ '/api/catalog.json': { body: JSON.stringify(snapshot) } });
    const logs: string[] = [];
    await sync(t.args, URL_ENV, { fetchImpl: s.fetchImpl, log: (m: string) => logs.push(m) });
    expect(JSON.parse(readFileSync(t.out, 'utf8'))).toEqual(snapshot);
    expect(existsSync(path.join(t.d, 'snapshot.json'))).toBe(false);
    expect(logs.at(-1)).toMatch(/^sync-catalog: https:\/\/shop\.example\/api\/catalog\.json -> /);
    const t2 = dirs(REPO_IMG);
    await sync([...t2.args, '--from', 'https://shop.example', '--save-snapshot'], {}, quiet(s.fetchImpl));
    expect(JSON.parse(readFileSync(path.join(t2.d, 'snapshot.json'), 'utf8'))).toEqual(snapshot);
    expect(s.hits['/api/catalog.json']).toBe(2);
  });

  it('refuses a catalog with any field that is not whitelisted (stock counts, private notes), writing nothing', async () => {
    const bad = structuredClone(snapshot);
    bad.pools[0].onHand = 1000;
    const t = dirs(REPO_IMG);
    await expect(sync(t.args, URL_ENV, quiet(server({ '/api/catalog.json': { body: JSON.stringify(bad) } }).fetchImpl))).rejects.toThrow(/unknown field "onHand"/);
    const bad2 = structuredClone(snapshot);
    bad2.batches.push({ code: 'MUR-2611-01', productSlug: 'murungai-honey', harvested: 'November 2026', packed: '2026-11-15', bestBefore: '2028-11', note: null, privateNote: 'x' });
    await expect(sync(t.args, URL_ENV, quiet(server({ '/api/catalog.json': { body: JSON.stringify(bad2) } }).fetchImpl))).rejects.toThrow(/privateNote/);
    expect(existsSync(t.out)).toBe(false);
  });

  it('refuses errors, non-JSON and oversized answers; retries 5xx three times', async () => {
    const t = dirs(REPO_IMG);
    const tryWith = (r: Route) => sync(t.args, URL_ENV, quiet(server({ '/api/catalog.json': r }).fetchImpl));
    await expect(tryWith({ status: 404, body: 'x' })).rejects.toThrow(/HTTP 404/);
    await expect(tryWith({ type: 'text/html', body: '<p>' })).rejects.toThrow(/not JSON/);
    await expect(tryWith({ body: '{"a":' })).rejects.toThrow(/not valid JSON/);
    await expect(tryWith({ body: '{}', length: String(6 * 1024 * 1024) })).rejects.toThrow(/too big/);
    const flaky = server({ '/api/catalog.json': { status: 503, body: 'down' } });
    await expect(sync(t.args, URL_ENV, quiet(flaky.fetchImpl))).rejects.toThrow(/after 3 tries/);
    expect(flaky.hits['/api/catalog.json']).toBe(3);
    expect(existsSync(t.out)).toBe(false);
  }, 20_000);

  it('CATALOG_SOURCE=snapshot wins over CATALOG_URL (no network at all)', async () => {
    const t = dirs(REPO_IMG);
    writeFileSync(path.join(t.d, 'snapshot.json'), JSON.stringify(snapshot));
    const s = server({});
    await sync(t.args, { ...URL_ENV, CATALOG_SOURCE: 'snapshot' }, quiet(s.fetchImpl));
    expect(s.hits).toEqual({});
    expect(JSON.parse(readFileSync(t.out, 'utf8'))).toEqual(snapshot);
  });
});

describe('uploaded photos', () => {
  it('downloads each upload once, checks it, caches it and copies it into the image folder', async () => {
    const c = uploadsOnly();
    expect(imagePaths(c)).toEqual([UPLOAD]);
    const t = dirs();
    const s = server({ '/api/catalog.json': { body: JSON.stringify(c) }, [`/media/${UPLOAD}`]: { type: 'image/jpeg', body: photo() } });
    const r = await sync(t.args, URL_ENV, quiet(s.fetchImpl));
    expect(r.uploads).toEqual({ present: 0, cached: 0, downloaded: 1 });
    expect(new Uint8Array(readFileSync(path.join(t.img, UPLOAD)))).toEqual(photo());
    expect(existsSync(path.join(t.d, `cache/${ULID}.jpg`))).toBe(true);
    // the next build: already in place
    expect((await sync(t.args, URL_ENV, quiet(s.fetchImpl))).uploads).toEqual({ present: 1, cached: 0, downloaded: 0 });
    // a fresh checkout that kept the build cache: copied from the cache
    rmSync(path.join(t.img, 'uploads'), { recursive: true });
    expect((await sync(t.args, URL_ENV, quiet(s.fetchImpl))).uploads).toEqual({ present: 0, cached: 1, downloaded: 0 });
    expect(s.hits[`/media/${UPLOAD}`]).toBe(1);
  });

  it('refuses a download that is not a JPEG, is cut off, has a wrong or no length, or is missing', async () => {
    const c = uploadsOnly();
    const cases: [string, Route, RegExp][] = [
      ['png', { type: 'image/png', body: photo() }, /not a JPEG/],
      ['magic', { type: 'image/jpeg', body: new Uint8Array(300).fill(1) }, /not a complete JPEG/],
      ['cut off', { type: 'image/jpeg', body: photo().slice(0, 200) }, /not a complete JPEG/],
      ['length', { type: 'image/jpeg', body: photo(), length: '299' }, /cut off/],
      ['no length', { type: 'image/jpeg', body: photo(), length: null }, /cut off/],
      ['tiny', { type: 'image/jpeg', body: photo(50) }, /not a complete JPEG/],
      ['404', { status: 404, type: 'text/plain', body: 'x' }, /HTTP 404/],
    ];
    for (const [name, route, err] of cases) {
      const t = dirs();
      const s = server({ '/api/catalog.json': { body: JSON.stringify(c) }, [`/media/${UPLOAD}`]: route });
      await expect(sync(t.args, URL_ENV, quiet(s.fetchImpl)), name).rejects.toThrow(err);
      expect(existsSync(t.out), name).toBe(false);
      expect(existsSync(path.join(t.img, UPLOAD)), name).toBe(false);
    }
  });

  it('a snapshot naming missing uploads says how to get them; MEDIA_ORIGIN fetches them', async () => {
    const t = dirs();
    writeFileSync(path.join(t.d, 'snapshot.json'), JSON.stringify(uploadsOnly()));
    const s = server({ [`/media/${UPLOAD}`]: { type: 'image/jpeg', body: photo() } });
    await expect(sync(t.args, {}, quiet(s.fetchImpl))).rejects.toThrow(/photos missing.*MEDIA_ORIGIN/);
    await expect(sync(t.args, { MEDIA_ORIGIN: 'http://media.example' }, quiet(s.fetchImpl))).rejects.toThrow(/https/);
    expect((await sync(t.args, { MEDIA_ORIGIN: 'https://media.example' }, quiet(s.fetchImpl))).uploads.downloaded).toBe(1);
  });

  it('a non-upload name that is missing is never downloaded', async () => {
    const c = structuredClone(snapshot);
    c.products[0].photo = 'uploads/missing.jpg';
    const t = dirs(REPO_IMG);
    const s = server({ '/api/catalog.json': { body: JSON.stringify(c) } });
    await expect(sync(t.args, URL_ENV, quiet(s.fetchImpl))).rejects.toThrow(/photos missing.*uploads\/missing\.jpg/);
    expect(s.hits['/media/uploads/missing.jpg']).toBeUndefined();
  });

  it('isCompleteJpeg', () => {
    expect(isCompleteJpeg(photo())).toBe(true);
    expect(isCompleteJpeg(photo(99))).toBe(false);
    expect(isCompleteJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });
});

describe('retired products', () => {
  it('get /shop/<slug>/ → /shop/ redirects; the file goes again when none is retired; a hand-written file is kept', async () => {
    const c = structuredClone(snapshot);
    c.products[2].status = 'retired';
    const slug = c.products[2].slug;
    expect(redirectsFor(c)).toBe(`${REDIRECTS_MARKER}\n/shop/${slug}/ /shop/ 301\n`);
    expect(redirectsFor(snapshot)).toBeNull();
    const t = dirs(REPO_IMG);
    const retired = server({ '/api/catalog.json': { body: JSON.stringify(c) } }).fetchImpl;
    const none = server({ '/api/catalog.json': { body: JSON.stringify(snapshot) } }).fetchImpl;
    const file = path.join(t.d, '_redirects');
    await sync(t.args, URL_ENV, quiet(retired));
    expect(readFileSync(file, 'utf8')).toContain(`/shop/${slug}/ /shop/ 301`);
    await sync(t.args, URL_ENV, quiet(none));
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, '/old /new 301\n');
    await sync(t.args, URL_ENV, quiet(retired));
    expect(readFileSync(file, 'utf8')).toBe('/old /new 301\n');
  });
});

describe('the command line', () => {
  it('stops with exit 1 and a clear message on a plain-http catalog URL, writing nothing', () => {
    const t = dirs();
    const r = spawnSync(process.execPath, ['scripts/sync-catalog.mjs', ...t.args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CATALOG_URL: 'http://example.invalid/api/catalog.json', CATALOG_FILE: '', CATALOG_SOURCE: '' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^sync-catalog: CATALOG_URL must use https:\/\//);
    expect(existsSync(t.out)).toBe(false);
  });
});
