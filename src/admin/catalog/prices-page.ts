// Prices screen touches: "Price on WhatsApp" empties and locks the row's boxes, ₹ per 100 g follows typing,
// and risky prices ask first (risk.ts). The page works the same without this script.
import { $, $$ } from '../client/dom';
import { parsePaiseText } from '../parse';
import { formatINR, perHundredGrams } from '../../lib/money';
import { initRiskCheck } from './risk';

function whatsapp(): void {
  const sync = (box: HTMLInputElement) => {
    for (const input of $$<HTMLInputElement>(`input[data-wa-target="${box.dataset.wa}"]`)) {
      if (box.checked && input.value) { input.dataset.kept = input.value; input.value = ''; }
      if (!box.checked && !input.value && input.dataset.kept) input.value = input.dataset.kept;
    }
  };
  for (const box of $$<HTMLInputElement>('input[data-wa]')) sync(box);
  document.addEventListener('change', (e) => {
    const box = e.target;
    if (box instanceof HTMLInputElement && box.dataset.wa) sync(box);
  });
  document.addEventListener('input', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.waTarget || !input.value.trim()) return;
    const box = $<HTMLInputElement>(`input[data-wa="${input.dataset.waTarget}"]`);
    if (box?.checked) box.checked = false;
  });
}

function per100(): void {
  document.addEventListener('input', (e) => {
    const row = (e.target as Element).closest?.('[data-pack-row]');
    const out = row && $('[data-per100]', row);
    const price = row && $<HTMLInputElement>('[data-price-input]', row);
    if (!out || !price) return;
    const g = Number(out.dataset.grams || '');
    const v = perHundredGrams(parsePaiseText(price.value.trim()), g > 0 ? g : null);
    out.textContent = v === null ? '—' : formatINR(v);
  });
}

function start(): void {
  whatsapp();
  per100();
  initRiskCheck();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
