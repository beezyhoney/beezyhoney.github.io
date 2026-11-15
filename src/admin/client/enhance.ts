// Small touches on top of plain HTML (everything still works without them):
// rupee re-grouping, live kg hints, quantity steppers, character counters, flash dismiss, auto-submitting filters,
// and a fallback for the "More" sheet on browsers without the popover attribute.
import { formatINR } from '../../lib/money';
import { int, jarEquivalents } from '../format';
import { parseGramsText, parseIntText, parsePaiseText } from '../parse';
import { $, $$, fire } from './dom';
import { s } from './strings';

function money(): void {
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !el.hasAttribute('data-money')) return;
    const raw = el.value.trim();
    if (!raw) return;
    const paise = parsePaiseText(raw);
    if (paise === null) return; // leave odd text alone; the server explains what is wrong
    const text = formatINR(paise).replace('₹', '');
    if (text !== el.value) {
      el.value = text;
      fire(el);
    }
  });
}

export function gramsHint(raw: string, packs: number[]): string {
  const g = parseGramsText(raw);
  if (g === null) return '';
  return [s('weight.equals', { grams: int(g) }), jarEquivalents(g, packs, s('weight.or'))].filter(Boolean).join(' · ');
}

function grams(): void {
  const update = (el: HTMLInputElement) => {
    const out = document.getElementById(el.dataset.grams || '');
    if (!out) return;
    const packs = (el.dataset.packs || '').split(',').map(Number).filter((n) => n > 0);
    out.textContent = gramsHint(el.value, packs);
  };
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.dataset.grams) update(el);
  });
}

function steppers(): void {
  const sync = (box: Element) => {
    const input = $<HTMLInputElement>('input', box);
    if (!input) return;
    const min = Number(input.dataset.min ?? '0');
    const max = Number(input.dataset.max ?? '999');
    const n = parseIntText(input.value);
    for (const b of $$<HTMLButtonElement>('[data-step]', box)) {
      const step = Number(b.dataset.step);
      b.disabled = input.disabled || (n !== null && ((step < 0 && n <= min) || (step > 0 && n >= max)));
    }
  };
  document.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.('[data-stepper] [data-step]') as HTMLButtonElement | null;
    if (!b) return;
    const box = b.closest('[data-stepper]');
    const input = box && $<HTMLInputElement>('input', box);
    if (!box || !input || input.disabled) return;
    const min = Number(input.dataset.min ?? '0');
    const max = Number(input.dataset.max ?? '999');
    const cur = parseIntText(input.value) ?? min;
    const next = Math.min(max, Math.max(min, cur + Number(b.dataset.step)));
    if (String(next) !== input.value) {
      input.value = String(next);
      fire(input);
    }
    sync(box);
  });
  document.addEventListener('input', (e) => {
    const box = (e.target as Element | null)?.closest?.('[data-stepper]');
    if (box) sync(box);
  });
  for (const box of $$('[data-stepper]')) sync(box);
}

function counters(): void {
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !el.dataset.counter) return;
    const out = document.getElementById(el.dataset.counter);
    if (!out) return;
    const max = Number(out.dataset.max || '0');
    const n = [...el.value].length;
    out.textContent = `${n} / ${max}`;
    out.classList.toggle('is-over', max > 0 && n > max);
  });
}

function flashes(): void {
  document.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.('[data-flash-close]');
    if (b) b.closest('.flash')?.remove();
  });
  // a reload must not show "Saved." again
  const url = new URL(window.location.href);
  if (url.searchParams.has('flash')) {
    url.searchParams.delete('flash');
    try {
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* ignore */
    }
  }
}

function autosubmit(): void {
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLSelectElement) || !el.hasAttribute('data-autosubmit') || !el.form) return;
    if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
    else el.form.submit();
  });
}

function moreFallback(): void {
  const sheet = $('#admin-more');
  if (!sheet || 'popover' in HTMLElement.prototype) return;
  const close = () => sheet.classList.remove('is-open');
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (target?.closest?.('[data-more-toggle]')) {
      sheet.classList.toggle('is-open');
      return;
    }
    if (target?.closest?.('[data-more-close]')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

export function initEnhance(): void {
  money();
  grams();
  steppers();
  counters();
  flashes();
  autosubmit();
  moreFallback();
}
