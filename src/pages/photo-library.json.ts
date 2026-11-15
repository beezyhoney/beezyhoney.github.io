// /photo-library.json — prerendered at build time (a static file, like /build.json). Lists the website's own photos
// (src/assets/img, the ones already published on the public pages) with a 240 px wide WebP thumbnail each, for the
// admin's photo picker (design §4: "Repo photo names with 240 px WebP thumbnails"). Public on purpose: these photos
// are on the website already. Uploaded photos are not listed here (they live in KV and the admin shows them itself).
// robots.txt disallows the file; it is not a page, so it is never in the sitemap.
import type { APIRoute, ImageMetadata } from 'astro';
import { getImage } from 'astro:assets';

export const prerender = true;

export interface LibraryPhoto {
  /** path relative to src/assets/img, e.g. 'murungai-main.jpg' (the value products and categories store) */
  path: string;
  /** original size in px */
  width: number;
  height: number;
  /** same-origin URL of a 240 px wide WebP thumbnail */
  thumb: string;
  thumbWidth: number;
  thumbHeight: number;
}

export interface PhotoLibraryFile {
  format: 1;
  photos: LibraryPhoto[];
}

export const THUMB_WIDTH = 240;

// Top-level photos only: src/assets/img/uploads/ holds owner uploads fetched by the build, which are not repo photos.
const files = import.meta.glob<{ default: ImageMetadata }>('../assets/img/*.{jpg,jpeg,png}', { eager: true });

export const GET: APIRoute = async () => {
  const photos: LibraryPhoto[] = [];
  for (const [key, mod] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const meta = mod.default;
    const path = key.replace('../assets/img/', '');
    const width = Math.min(THUMB_WIDTH, meta.width);
    const thumb = await getImage({ src: meta, width, format: 'webp' });
    photos.push({
      path,
      width: meta.width,
      height: meta.height,
      thumb: thumb.src,
      thumbWidth: width,
      thumbHeight: Math.round((meta.height * width) / meta.width),
    });
  }
  const body: PhotoLibraryFile = { format: 1, photos };
  return new Response(JSON.stringify(body) + '\n', { headers: { 'content-type': 'application/json; charset=utf-8' } });
};
