// Photo upload in the browser (design §8, amendment A2). Turns the PhotoPicker upload tiles on:
//   1. decode with createImageBitmap(file, { imageOrientation: 'from-image' }) (phone photos stand the right way up);
//   2. draw on a canvas with the long edge at most 2400 px (never below 800 px on the short edge) and export JPEG at
//      quality 0.86, plus a 480 px JPEG thumbnail. Re-encoding drops EXIF and GPS;
//   3. warn when the short edge is under 1200 px; a HEIC the browser cannot decode gets a friendly message;
//   4. POST both to /admin/api/media.json, which checks and strips everything again;
//   5. add the new photo to every picker on the page and choose it in the picker whose tile was tapped.
// Words come from <script type="application/json" id="catalog-strings"> on the page. No third-party code.
import { askConfirm } from '../client/confirm';
import { $, $$ } from '../client/dom';

export const LONG_EDGE = 2400;
export const THUMB_EDGE = 480;
export const QUALITY = 0.86;
export const THUMB_QUALITY = 0.8;
export const MIN_SHORT_EDGE = 800;
export const WARN_SHORT_EDGE = 1200;

let words: Record<string, string> | null = null;
export function w(key: string, vars?: Record<string, string | number>): string {
  if (!words) {
    try { words = JSON.parse($('#catalog-strings')?.textContent || '{}') as Record<string, string>; } catch { words = {}; }
  }
  const text = words[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m)) : text;
}

export class UploadError extends Error {
  constructor(readonly kind: 'heic' | 'unreadable' | 'tooSmall' | 'cancelled' | 'failed' | 'offline' | 'login', message: string) {
    super(message);
  }
}

export const isHeic = (f: { name?: string; type?: string }) => /^image\/hei[cf]/i.test(f.type ?? '') || /\.hei[cf]$/i.test(f.name ?? '');

/** Size to draw at: long edge ≤ 2400, but never shrink the short edge below 800 (panoramas) */
export function fitSize(width: number, height: number, longEdge = LONG_EDGE, minShort = MIN_SHORT_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const scale = Math.min(1, Math.max(longEdge / long, short > 0 ? Math.min(1, minShort / short) : 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function toJpeg(src: ImageBitmap, width: number, height: number, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new UploadError('unreadable', w('up.unreadable')));
  ctx.fillStyle = '#ffffff'; // transparent PNG areas become white, not black
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new UploadError('unreadable', w('up.unreadable')))), 'image/jpeg', quality));
}

/** Decodes, checks and re-encodes a chosen file. Throws UploadError. */
export async function preparePhoto(file: File): Promise<{ photo: Blob; thumb: Blob; width: number; height: number }> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new UploadError(isHeic(file) ? 'heic' : 'unreadable', w(isHeic(file) ? 'up.heic' : 'up.unreadable'));
  }
  try {
    const short = Math.min(bmp.width, bmp.height);
    if (short < MIN_SHORT_EDGE) throw new UploadError('tooSmall', w('up.tooSmall', { w: bmp.width, h: bmp.height }));
    if (short < WARN_SHORT_EDGE) {
      const ok = await askConfirm({ message: w('up.small', { w: bmp.width, h: bmp.height }), ok: w('up.smallOk') });
      if (!ok) throw new UploadError('cancelled', '');
    }
    const size = fitSize(bmp.width, bmp.height);
    const thumbSize = fitSize(bmp.width, bmp.height, THUMB_EDGE, 1);
    const photo = await toJpeg(bmp, size.width, size.height, QUALITY);
    const thumb = await toJpeg(bmp, thumbSize.width, thumbSize.height, THUMB_QUALITY);
    return { photo, thumb, width: size.width, height: size.height };
  } finally {
    bmp.close();
  }
}

export interface Uploaded { path: string; thumbPath: string; width: number; height: number; url: string; thumbUrl: string }

/** Sends a prepared photo to the server. Throws UploadError. */
export async function sendPhoto(photo: Blob, thumb: Blob, endpoint = '/admin/api/media.json'): Promise<Uploaded> {
  const fd = new FormData();
  fd.append('file', photo, 'photo.jpg');
  fd.append('thumb', thumb, 'thumb.jpg');
  let res: Response;
  try {
    res = await fetch(endpoint, { method: 'POST', body: fd, credentials: 'same-origin', redirect: 'manual', headers: { accept: 'application/json' } });
  } catch {
    throw new UploadError('offline', w('up.offline'));
  }
  const json = (res.headers.get('content-type') ?? '').includes('application/json');
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403 || !json) throw new UploadError('login', w('up.login'));
  const body = (await res.json().catch(() => null)) as ({ ok: true } & Uploaded) | { ok: false; message: string } | null;
  if (!body) throw new UploadError('failed', w('up.failed', { why: res.status }));
  if (!body.ok) throw new UploadError('failed', w('up.failed', { why: body.message }));
  return body;
}

const CHECK_SVG = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>';

/** Adds an uploaded photo to every picker on the page; chooses it in `chooseIn` (a picker name) */
export function addToPickers(up: Uploaded, chooseIn: string | null): void {
  for (const set of $$<HTMLFieldSetElement>('[data-photo-picker]')) {
    const grid = $('[data-photo-grid]', set);
    if (!grid || $(`input[value="${CSS.escape(up.path)}"]`, grid)) continue;
    const name = set.dataset.photoPicker || '';
    const label = document.createElement('label');
    label.className = 'photo';
    label.title = w('up.uploadedAlt');
    const input = document.createElement('input');
    input.type = set.hasAttribute('data-multiple') ? 'checkbox' : 'radio';
    input.name = name;
    input.value = up.path;
    const img = document.createElement('img');
    img.src = up.thumbUrl;
    img.alt = w('up.uploadedAlt');
    img.width = 240;
    img.height = Math.max(1, Math.round((up.height * 240) / up.width));
    const check = document.createElement('span');
    check.className = 'photo-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = CHECK_SVG;
    label.append(input, img, check);
    const none = $('.photo-none', grid);
    if (none) none.after(label); else grid.prepend(label);
    if (name === chooseIn) {
      input.checked = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
}

function setTile(tile: HTMLButtonElement, text: string, busy: boolean): void {
  const span = tile.querySelector('span:not(.sr-only)');
  if (span) span.textContent = text;
  tile.disabled = busy;
  tile.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function status(text: string, tone: 'info' | 'error' | 'ok'): void {
  let box = $('#upload-status');
  if (!box) {
    box = document.createElement('p');
    box.id = 'upload-status';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  box.className = `upload-status notice notice-${tone === 'error' ? 'bad' : tone}`;
  box.textContent = text;
  box.hidden = !text;
  if (tone !== 'info') window.setTimeout(() => { if (box) box.hidden = true; }, tone === 'error' ? 9000 : 3500);
}

/** Turns on every upload tile on the page (they are disabled without JavaScript) */
export function initPhotoUploads(): void {
  const tiles = $$<HTMLButtonElement>('[data-photo-upload]');
  if (!tiles.length) return;
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.heic,.heif';
  picker.hidden = true;
  picker.setAttribute('data-no-draft', '');
  document.body.append(picker);
  let from: HTMLButtonElement | null = null;
  for (const tile of tiles) {
    tile.disabled = false;
    tile.title = w('up.button');
    tile.querySelector('.sr-only')?.remove();
    setTile(tile, w('up.button'), false);
    tile.addEventListener('click', () => { from = tile; picker.value = ''; picker.click(); });
  }
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    const tile = from;
    if (!file || !tile) return;
    try {
      setTile(tile, w('up.working'), true);
      status(w('up.working'), 'info');
      const prepared = await preparePhoto(file);
      setTile(tile, w('up.sending'), true);
      status(w('up.sending'), 'info');
      const up = await sendPhoto(prepared.photo, prepared.thumb);
      addToPickers(up, tile.dataset.photoUpload ?? null);
      status(w('up.done'), 'ok');
    } catch (e) {
      const err = e instanceof UploadError ? e : new UploadError('failed', w('up.unreadable'));
      if (err.kind !== 'cancelled') status(err.message, 'error');
      else status('', 'info');
    } finally {
      setTile(tile, w('up.button'), false);
    }
  });
}
