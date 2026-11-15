// Browser touches for the product editor (everything works without them):
// - photo upload tiles (upload.ts);
// - the current main / card photo preview follows the picker;
// - gallery: ticking a photo under "Add photos" adds a row with a caption box; ↑ ↓ move rows; place numbers follow;
// - the typed background colour and the swatches stay in step;
// - ₹ per 100 g next to each pack price follows typing.
import { $, $$, fire } from '../client/dom';
import { parsePaiseText } from '../parse';
import { formatINR, perHundredGrams } from '../../lib/money';
import { initPhotoUploads, w } from './upload';
import { initRiskCheck } from './risk';

function currentPhotos(): void {
  document.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'radio') return;
    const set = input.closest<HTMLElement>('[data-photo-picker]');
    const box = set && $(`[data-current-for="${set.dataset.photoPicker}"]`);
    if (!box) return;
    const img = input.closest('label')?.querySelector('img');
    const shown = $<HTMLImageElement>('img', box);
    const empty = $('[data-current-empty]', box);
    if (img && shown) { shown.src = img.src; shown.alt = img.alt; shown.hidden = false; if (empty) empty.hidden = true; }
    else if (!img) { if (shown) shown.hidden = true; if (empty) empty.hidden = false; }
  });
}

function renumber(list: HTMLElement): void {
  $$<HTMLElement>('[data-gallery-row]', list).forEach((row, i) => {
    const order = $<HTMLInputElement>('[data-gallery-order]', row);
    if (order) order.value = String(i + 1);
    const n = $('[data-gallery-n]', row);
    if (n) n.textContent = String(i + 1);
  });
}

function gallery(): void {
  const list = $('[data-gallery-list]');
  const tpl = $<HTMLTemplateElement>('#gallery-row-tpl');
  if (!list || !tpl) return;
  list.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-gallery-move]');
    if (!b) return;
    const row = b.closest<HTMLElement>('[data-gallery-row]');
    if (!row) return;
    if (b.dataset.galleryMove === 'up' && row.previousElementSibling) row.previousElementSibling.before(row);
    if (b.dataset.galleryMove === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
    renumber(list);
    b.focus();
    const any = $<HTMLInputElement>('input[name="g_cap"]', row);
    if (any) fire(any);
  });
  document.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'g_add' || !input.checked) return;
    const src = input.value;
    const existing = $$<HTMLInputElement>('input[name="g_src"]', list).find((i) => i.value === src);
    input.checked = false;
    if (existing) { $<HTMLInputElement>('input[name="g_cap"]', existing.closest('[data-gallery-row]')!)?.focus(); return; }
    const row = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    $<HTMLInputElement>('input[name="g_src"]', row)!.value = src;
    const del = $<HTMLInputElement>('input[name="g_del"]', row);
    if (del) del.value = src;
    const img = $<HTMLImageElement>('img', row);
    const from = input.closest('label')?.querySelector('img');
    if (img && from) { img.src = from.src; img.alt = from.alt; }
    list.append(row);
    $('[data-gallery-empty]')?.setAttribute('hidden', '');
    renumber(list);
    const cap = $<HTMLInputElement>('input[name="g_cap"]', row);
    cap?.focus();
    cap?.setAttribute('placeholder', w('pe.newCaption'));
  });
}

function tone(): void {
  const custom = $<HTMLInputElement>('input[name="tone_custom"]');
  if (!custom) return;
  const sample = $('[data-tone-sample]');
  const show = (v: string) => { if (sample && /^#[0-9a-f]{6}$/i.test(v)) sample.style.background = v; };
  custom.addEventListener('input', () => {
    if (custom.value.trim()) for (const r of $$<HTMLInputElement>('input[name="tone"]')) r.checked = false;
    show(custom.value.trim());
  });
  document.addEventListener('change', (e) => {
    const r = e.target;
    if (r instanceof HTMLInputElement && r.name === 'tone' && r.checked) { custom.value = ''; show(r.value); }
  });
}

function per100(): void {
  const update = (row: Element) => {
    const out = $('[data-per100]', row);
    const price = $<HTMLInputElement>('[data-price-input]', row);
    const grams = $<HTMLInputElement>('[data-grams-input]', row);
    if (!out || !price) return;
    const p = parsePaiseText(price.value.trim());
    const g = Number((grams?.value ?? out.dataset.grams ?? '').trim());
    const v = perHundredGrams(p, Number.isFinite(g) && g > 0 ? g : null);
    out.textContent = v === null ? '—' : formatINR(v);
  };
  document.addEventListener('input', (e) => {
    const row = (e.target as Element).closest?.('[data-pack-row]');
    if (row) update(row);
  });
}

function start(): void {
  initPhotoUploads();
  currentPhotos();
  gallery();
  tone();
  per100();
  initRiskCheck();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
