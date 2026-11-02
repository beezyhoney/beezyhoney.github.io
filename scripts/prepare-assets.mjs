// One-off asset preparation: copies catalogue photos into src/assets, cuts hero crops
// from the full-resolution originals, and makes transparent logo files.
// Usage: node scripts/prepare-assets.mjs <full-res photo folder>
import sharp from 'sharp';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const catalogueImg = path.resolve(root, '../catalogue/img');
const fullDir = process.argv[2];
const out = path.join(root, 'src/assets/img');
const pub = path.join(root, 'public');
await mkdir(out, { recursive: true });
await mkdir(pub, { recursive: true });

// 1. Product and band photos straight from the catalogue
const skip = new Set(['logo-wordmark.png', 'logo-wordmark-plain.png', 'logo-seal.png', 'instagram-qr.png', 'honey-sticks.jpg', 'coriander-seeds.jpg']);
for (const f of await readdir(catalogueImg)) {
  if (!skip.has(f)) await copyFile(path.join(catalogueImg, f), path.join(out, f));
}
await copyFile(path.join(catalogueImg, 'instagram-qr.png'), path.join(out, 'instagram-qr.png'));

// 2. Landscape hero crops from the full-resolution originals
const heroes = [
  ['hero-shop.jpg', 'IMG_1114.jpg', { left: 0, top: 1150, width: 2268, height: 1512 }],
  ['hero-harvest.jpg', 'IMG_1473.jpg', { left: 0, top: 820, width: 2268, height: 1512 }],
  ['hero-about.jpg', 'IMG_1332.jpg', { left: 0, top: 1150, width: 3024, height: 2016 }],
  ['hero-sunflower.jpg', 'IMG_1190.jpg', { left: 0, top: 1000, width: 2268, height: 1512 }],
];
for (const [name, src, box] of heroes) {
  await sharp(path.join(fullDir, src)).extract(box).resize({ width: 2400, withoutEnlargement: true })
    .jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(out, name));
}

// 3. Logos with the white background removed
async function knockOutWhite(src, dest, { tint } = {}) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const min = Math.min(r, g, b);
    // near-white becomes transparent; soft edge between 215 and 250
    const a = min >= 250 ? 0 : min <= 215 ? 255 : Math.round(255 * (250 - min) / 35);
    if (tint) {
      // single-colour mark: alpha from darkness, colour fixed
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      data[i] = tint[0]; data[i + 1] = tint[1]; data[i + 2] = tint[2];
      data[i + 3] = Math.max(0, Math.min(255, Math.round(255 - lum)));
    } else {
      data[i + 3] = Math.min(data[i + 3], a);
    }
  }
  await sharp(data, { raw: info }).png().toFile(dest);
}
await knockOutWhite(path.join(catalogueImg, 'logo-wordmark-plain.png'), path.join(out, 'logo-wordmark.png'), { tint: [0, 0, 0] });
await knockOutWhite(path.join(catalogueImg, 'logo-seal.png'), path.join(out, 'logo-seal.png'));

// 4. Favicons from the seal
await sharp(path.join(out, 'logo-seal.png')).resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(pub, 'favicon.png'));
await sharp(path.join(out, 'logo-seal.png')).resize(180, 180, { fit: 'contain', background: '#FBF3E6' }).flatten({ background: '#FBF3E6' }).png().toFile(path.join(pub, 'apple-touch-icon.png'));

// 5. Social share image
await sharp(path.join(out, 'hero-shop.jpg')).resize(1200, 630, { fit: 'cover' }).jpeg({ quality: 82 }).toFile(path.join(pub, 'og-image.jpg'));

console.log('assets ready:', (await readdir(out)).length, 'images');
