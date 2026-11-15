// Photos for the admin pickers (server side). Two sources:
// - the website's own photos, listed with 240 px WebP thumbnails in the prerendered /photo-library.json
//   (static asset; read through the ASSETS binding in production, from the dev server in `astro dev`);
// - owner uploads, from the D1 `images` table, previewed through /admin/media/uploads/thumbs/<ULID>.jpg.
// The library is cached per Worker isolate for 10 minutes (it only changes with a new build).
import type { PhotoOption } from '../components/PhotoPicker.astro';
import type { ImageRow, PhotoLibrary } from '../../server/products-admin';

export interface LibraryPhoto { path: string; width: number; height: number; thumb: string; thumbWidth: number; thumbHeight: number }

let cache: { at: number; photos: LibraryPhoto[] } | null = null;
const TTL_MS = 10 * 60_000;

function isLibrary(v: unknown): v is { format: 1; photos: LibraryPhoto[] } {
  if (!v || typeof v !== 'object') return false;
  const o = v as { format?: unknown; photos?: unknown };
  return o.format === 1 && Array.isArray(o.photos) && o.photos.every((p) => p && typeof p === 'object'
    && typeof (p as LibraryPhoto).path === 'string' && typeof (p as LibraryPhoto).thumb === 'string'
    && (p as LibraryPhoto).thumb.startsWith('/') && !(p as LibraryPhoto).thumb.startsWith('//')
    && Number.isInteger((p as LibraryPhoto).width) && Number.isInteger((p as LibraryPhoto).height));
}

/**
 * The website's photo library, or [] when it cannot be read (the pickers then show names instead of thumbnails).
 * `assets` is the ASSETS binding (production); `dev` allows a same-origin fetch (astro dev renders the file itself).
 */
export async function loadPhotoLibrary(origin: string, opts: { assets?: { fetch(input: Request | string | URL): Promise<Response> } | null; dev?: boolean; fetcher?: typeof fetch } = {}): Promise<LibraryPhoto[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.photos;
  const url = new URL('/photo-library.json', origin);
  const tries: (() => Promise<Response>)[] = [];
  if (opts.assets) tries.push(() => opts.assets!.fetch(new Request(url)));
  if (opts.dev) tries.push(() => (opts.fetcher ?? fetch)(url, { headers: { accept: 'application/json' } }));
  for (const attempt of tries) {
    try {
      const res = await attempt();
      if (!res.ok) continue;
      const body: unknown = await res.json();
      if (!isLibrary(body)) continue;
      cache = { at: Date.now(), photos: body.photos };
      return body.photos;
    } catch {
      /* try the next way */
    }
  }
  return [];
}

/** Forget the cached library (tests) */
export function resetPhotoLibraryCache(): void {
  cache = null;
}

/** path → size, for saveProduct({ library }) so a repo photo without an images row can still be used */
export function libraryMap(photos: LibraryPhoto[]): PhotoLibrary {
  return new Map(photos.map((p) => [p.path, { width: p.width, height: p.height }]));
}

/** A small "no thumbnail" tile with the photo's name (data: URI, allowed by the admin CSP) */
export function placeholderThumb(name: string): string {
  const label = name.replace(/\.(jpe?g|png)$/i, '').slice(0, 22).replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 180"><rect width="240" height="180" fill="#F4E4C8"/><text x="120" y="96" font-family="sans-serif" font-size="16" text-anchor="middle" fill="#4A2814">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Preview URL of an upload in the admin (works for drafts too) */
export const adminMediaUrl = (path: string) => `/admin/media/${path}`;

/** Thumbnail for any known photo path: uploads → their KV thumbnail, repo photos → the library's WebP */
export function thumbFor(path: string | null | undefined, images: Map<string, ImageRow>, library: Map<string, LibraryPhoto>): { src: string; width: number; height: number } | null {
  if (!path) return null;
  const img = images.get(path);
  if (img?.source === 'upload' && img.thumbPath) {
    const w = 240;
    return { src: adminMediaUrl(img.thumbPath), width: w, height: Math.max(1, Math.round((img.height * w) / img.width)) };
  }
  const lib = library.get(path);
  if (lib) return { src: lib.thumb, width: lib.thumbWidth, height: lib.thumbHeight };
  return { src: placeholderThumb(path), width: 240, height: 180 };
}

/**
 * Options for PhotoPicker: uploads first (newest first), then the website's photos. A repo photo the build has but
 * the database does not know yet is offered too (saving adds its row).
 */
export function photoOptions(images: ImageRow[], library: LibraryPhoto[]): PhotoOption[] {
  const byPath = new Map(images.map((i) => [i.path, i]));
  const lib = new Map(library.map((p) => [p.path, p]));
  const out: PhotoOption[] = [];
  for (const i of images) {
    if (i.source !== 'upload') continue;
    const t = thumbFor(i.path, byPath, lib)!;
    out.push({ path: i.path, src: t.src, alt: `Uploaded photo, ${i.width} × ${i.height}`, width: t.width, height: t.height });
  }
  const repo = new Set<string>([...images.filter((i) => i.source === 'repo').map((i) => i.path), ...library.map((p) => p.path)]);
  for (const path of [...repo].sort()) {
    const t = thumbFor(path, byPath, lib)!;
    out.push({ path, src: t.src, alt: path.replace(/\.(jpe?g|png)$/i, '').replace(/[-_]+/g, ' '), width: t.width, height: t.height });
  }
  return out;
}
