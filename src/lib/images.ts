import type { ImageMetadata } from 'astro';

// Every photo under src/assets/img, including sub-folders (e.g. uploads/ from the admin portal later).
const files = import.meta.glob<{ default: ImageMetadata }>('../assets/img/**/*.{jpg,jpeg,png}', { eager: true });

/** Look up a photo in src/assets/img by its path relative to that folder, e.g. img('murungai.jpg') or img('uploads/01JD….jpg') */
export function img(name: string): ImageMetadata {
  const file = files[`../assets/img/${name}`];
  if (!file) throw new Error(`Missing image: src/assets/img/${name}`);
  return file.default;
}
