// Numbers on the stat tiles count up once, when the tile comes into view (about one second). The text the server wrote is
// put back exactly at the end, so nothing depends on this script: with it off, or with "reduce motion" on, the
// numbers are simply there. Only the digits move; a ₹ before or "kg" / "days" / "%" after stay as written.
import { $$ } from './dom';

const PARTS = /^([^\d]*)(\d[\d,]*)(\.\d+)?(.*)$/s;
const DURATION = 1000;

function countUp(el: HTMLElement, delay: number): void {
  const original = el.textContent ?? '';
  const m = PARTS.exec(original.trim());
  if (!m) return;
  const target = Number((m[2] + (m[3] ?? '')).replace(/,/g, ''));
  if (!Number.isFinite(target) || target <= 0 || target > 1e9) return;
  const decimals = m[3] ? m[3].length - 1 : 0;
  const show = (n: number) => `${m[1]}${n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${m[4]}`;
  el.textContent = show(0);
  const start = performance.now() + delay;
  const step = (now: number) => {
    const t = Math.min(1, Math.max(0, (now - start) / DURATION));
    if (t >= 1) {
      el.textContent = original;
      return;
    }
    el.textContent = show(target * (1 - (1 - t) ** 3)); // ease out
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function initMotion(): void {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const tiles = $$('.stat-value');
  if (tiles.length === 0) return;
  const run = (el: HTMLElement, i: number) => countUp(el, 140 + Math.min(i, 5) * 60);
  if (!('IntersectionObserver' in window)) {
    tiles.forEach(run);
    return;
  }
  const seen = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      seen.unobserve(entry.target);
      run(entry.target as HTMLElement, tiles.indexOf(entry.target as HTMLElement));
    });
  }, { threshold: 0.4 });
  tiles.forEach((el) => seen.observe(el));
}
