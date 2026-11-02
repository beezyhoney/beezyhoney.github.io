import type { ImageMetadata } from 'astro';

const files = import.meta.glob<{ default: ImageMetadata }>('../assets/img/*.{jpg,png}', { eager: true });

/** Look up a photo in src/assets/img by file name, e.g. img('murungai.jpg') */
export function img(name: string): ImageMetadata {
  const file = files[`../assets/img/${name}`];
  if (!file) throw new Error(`Missing image: src/assets/img/${name}`);
  return file.default;
}
