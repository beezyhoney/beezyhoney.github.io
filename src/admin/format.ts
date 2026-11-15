// Display helpers for admin screens: money, weights, counts, Indian Standard Time dates and ages.
// Pure functions (no DOM, no Node APIs) so the Worker, the build, the browser scripts and the unit tests share them.
// Money text comes from the shared src/lib/money.ts, so the admin prints ₹ exactly like the website.

import { formatINR, groupIndian } from '../lib/money';

export const IST = 'Asia/Kolkata';
const IST_OFFSET_MIN = 330;

/** '₹1,05,000' for paise; '—' (or `empty`) for null/undefined. */
export function inr(paise: number | null | undefined, empty = '—'): string {
  if (paise === null || paise === undefined) return empty;
  return formatINR(paise);
}

/** Rupee text for an input's value (no ₹): 105000 → '1,050', 105050 → '1,050.50', null → ''. */
export function inrInput(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isSafeInteger(paise)) return '';
  return formatINR(paise).replace('₹', '');
}

/** Whole number with Indian grouping: 105000 → '1,05,000', -2 → '-2'. */
export function int(n: number | null | undefined, empty = '—'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return empty;
  const r = Math.round(n);
  return r < 0 ? `-${groupIndian(-r)}` : groupIndian(r);
}

/** Percent text: 0.125 → '12.5%', 0.1 → '10%', -0.4 → '-40%'. */
export function pct(fraction: number | null | undefined, empty = '—'): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return empty;
  const v = Math.round(fraction * 1000) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
}

/**
 * Kilograms for people, one decimal by default: 99500 → '99.5 kg', -2000 → '-2.0 kg', 250 → '0.3 kg'.
 * Use for display only; for an editable input use kgInput(), which never loses grams.
 */
export function kg(grams: number | null | undefined, decimals = 1, empty = '—'): string {
  if (grams === null || grams === undefined || !Number.isFinite(grams)) return empty;
  const v = grams / 1000;
  const fixed = Math.abs(v).toFixed(decimals);
  const [whole, frac] = fixed.split('.');
  const text = `${groupIndian(Number(whole))}${frac ? `.${frac}` : ''}`;
  return `${v < 0 && Number(fixed) !== 0 ? '-' : ''}${text} kg`;
}

/**
 * The value to put in a kg input: one decimal when that is exact, otherwise every gram (up to 3 decimals), so saving
 * an untouched form never changes the stored grams: 99500 → '99.5', 99550 → '99.55', 100000 → '100.0', null → ''.
 */
export function kgInput(grams: number | null | undefined): string {
  if (grams === null || grams === undefined || !Number.isSafeInteger(grams)) return '';
  const sign = grams < 0 ? '-' : '';
  const abs = Math.abs(grams);
  const whole = Math.floor(abs / 1000);
  const rest = abs % 1000;
  if (rest % 100 === 0) return `${sign}${whole}.${rest / 100}`;
  return `${sign}${whole}.${String(rest).padStart(3, '0').replace(/0+$/, '')}`;
}

/** A pack size in grams for people: 250 → '250 g', 1000 → '1 kg', 1500 → '1.5 kg'. */
export function packGrams(grams: number): string {
  if (grams >= 1000 && grams % 100 === 0) return `${grams / 1000} kg`;
  return `${groupIndian(grams)} g`;
}

/**
 * Rough jar equivalent of a honey pool (amendment A3): 99000 g with packs [250, 100] → '≈ 396 × 250 g or 990 × 100 g'.
 * Packs that do not fit even once are left out; '' when nothing fits.
 */
export function jarEquivalents(grams: number | null | undefined, packs: readonly number[], or = 'or'): string {
  if (grams === null || grams === undefined || grams <= 0) return '';
  const parts = [...new Set(packs)].filter((p) => p > 0).sort((a, b) => b - a)
    .map((p) => ({ p, n: Math.floor(grams / p) })).filter((x) => x.n > 0)
    .map((x) => `${groupIndian(x.n)} × ${packGrams(x.p)}`);
  return parts.length ? `≈ ${parts.join(` ${or} `)}` : '';
}

/** Pieces for candles and sticks: 1 → '1 piece', 12 → '12 pieces'. */
export function pieces(n: number | null | undefined, empty = '—'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return empty;
  return `${int(n)} ${Math.abs(n) === 1 ? 'piece' : 'pieces'}`;
}

// ---------- dates (stored as UTC 'YYYY-MM-DDTHH:MM:SSZ'; shown in IST) ----------

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

// Formatters are made on first use, so importing this module has no side effects (the browser bundle tree-shakes it).
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(key: 'date' | 'dayMonth' | 'time' | 'month'): Intl.DateTimeFormat {
  let f = fmtCache.get(key);
  if (!f) {
    const opts: Record<typeof key, Intl.DateTimeFormatOptions> = {
      date: { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' },
      dayMonth: { timeZone: IST, day: 'numeric', month: 'short' },
      time: { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true },
      month: { timeZone: 'UTC', month: 'short', year: 'numeric' },
    };
    f = new Intl.DateTimeFormat('en-IN', opts[key]);
    fmtCache.set(key, f);
  }
  return f;
}

/** '15 Nov 2026' (IST). Accepts an ISO timestamp, a 'YYYY-MM-DD' day (taken as that IST day) or a Date. */
export function dateIST(value: string | number | Date | null | undefined, empty = '—'): string {
  if (value === null || value === undefined || value === '') return empty;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fmt('date').format(new Date(`${value}T12:00:00+05:30`));
  }
  const d = toDate(value);
  return Number.isNaN(d.getTime()) ? empty : fmt('date').format(d);
}

/** '15 Nov' (IST), for compact lists. */
export function dayMonthIST(value: string | number | Date | null | undefined, empty = '—'): string {
  if (value === null || value === undefined || value === '') return empty;
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+05:30`) : toDate(value);
  return Number.isNaN(d.getTime()) ? empty : fmt('dayMonth').format(d);
}

/** '10:42 am' (IST). */
export function timeIST(value: string | number | Date | null | undefined, empty = '—'): string {
  if (value === null || value === undefined || value === '') return empty;
  const d = toDate(value);
  return Number.isNaN(d.getTime()) ? empty : fmt('time').format(d).replace(/\s?([ap])\.?m\.?$/i, ' $1m').toLowerCase();
}

/** '15 Nov 2026, 10:42 am' (IST). */
export function dateTimeIST(value: string | number | Date | null | undefined, empty = '—'): string {
  if (value === null || value === undefined || value === '') return empty;
  return `${dateIST(value, empty)}, ${timeIST(value, empty)}`;
}

/** 'Nov 2026' for a 'YYYY-MM' month. */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return fmt('month').format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
}

/** How long ago, short: '40 sec', '5 min', '3 h', '2 days', '5 weeks'. Future times give '0 min'. */
export function ageShort(from: string | number | Date, now: number = Date.now()): string {
  const ms = Math.max(0, now - toDate(from).getTime());
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} days`;
  return `${Math.floor(d / 7)} weeks`;
}

/** The IST calendar day of a moment: 'YYYY-MM-DD'. */
export function dayIST(value: string | number | Date = Date.now()): string {
  const d = toDate(value);
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** Adds whole days to a 'YYYY-MM-DD' day. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True for a real calendar day in 'YYYY-MM-DD' form. */
export function isDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type RangePreset = 'today' | 'last7' | 'thisMonth' | 'lastMonth' | 'thisFy' | 'lastFy' | 'thisYear';

/** Inclusive IST day ranges for the quick picks. The financial year runs 1 April – 31 March. */
export function rangeFor(preset: RangePreset, now: number | Date = Date.now()): { from: string; to: string } {
  const today = dayIST(now);
  const [y, m] = today.split('-').map(Number);
  const monthStart = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const monthEnd = (yy: number, mm: number) => addDays(mm === 12 ? monthStart(yy + 1, 1) : monthStart(yy, mm + 1), -1);
  const fyStartYear = m >= 4 ? y : y - 1;
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'last7': return { from: addDays(today, -6), to: today };
    case 'thisMonth': return { from: monthStart(y, m), to: monthEnd(y, m) };
    case 'lastMonth': {
      const [ly, lm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return { from: monthStart(ly, lm), to: monthEnd(ly, lm) };
    }
    case 'thisFy': return { from: `${fyStartYear}-04-01`, to: `${fyStartYear + 1}-03-31` };
    case 'lastFy': return { from: `${fyStartYear - 1}-04-01`, to: `${fyStartYear}-03-31` };
    case 'thisYear': return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
}
