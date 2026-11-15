// Add harvest touches: the suggested batch code follows the chosen honey, and "Best before" follows the harvest
// date (24 months after its month) until the owner changes it. Without JavaScript the server fills both in.
import { $ } from '../client/dom';

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function start(): void {
  const pool = $<HTMLSelectElement>('select[name="pool"]');
  const code = $<HTMLInputElement>('input[name="code"]');
  const date = $<HTMLInputElement>('input[name="harvested_on"]');
  const bb = $<HTMLInputElement>('input[name="best_before"]');
  let map: Record<string, string | null> = {};
  try { map = JSON.parse($('#batch-suggestions')?.textContent || '{}'); } catch { /* none */ }
  const today = date?.max?.slice(0, 7) ?? '';
  pool?.addEventListener('change', () => {
    if (!code) return;
    const s = map[pool.value];
    // the suggestion is for this month; another month gets its own number when saved
    code.placeholder = s && date?.value.slice(0, 7) === today ? s : '';
  });
  let bbTouched = false;
  bb?.addEventListener('input', () => { bbTouched = true; });
  date?.addEventListener('change', () => {
    if (date.value && bb && !bbTouched) bb.value = addMonths(date.value.slice(0, 7), 24);
    if (code && date.value.slice(0, 7) !== today) code.placeholder = '';
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
