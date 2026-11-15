// Time helpers. The database stores UTC text 'YYYY-MM-DDTHH:MM:SSZ' (text order = time order); the owner thinks
// in IST (UTC+05:30, no daylight saving), so days, months and financial years are IST.

export const IST_OFFSET_MINUTES = 330;
const IST_MS = IST_OFFSET_MINUTES * 60_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UTC time as the database stores it, to the second: '2026-11-15T04:30:00Z' */
export function nowIso(date: Date = new Date()): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** True for a timestamp in the database format */
export const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

/** True for a real calendar date 'YYYY-MM-DD' */
export function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** True for a month 'YYYY-MM' */
export const isMonth = (v: unknown): v is string => typeof v === 'string' && MONTH_RE.test(v);

/** Adds minutes/hours/days to a database timestamp */
export function addTime(iso: string, d: { minutes?: number; hours?: number; days?: number }): string {
  const ms = Date.parse(iso) + ((d.minutes ?? 0) + (d.hours ?? 0) * 60 + (d.days ?? 0) * 1440) * 60_000;
  return nowIso(new Date(ms));
}

/** IST calendar date of a UTC timestamp: '2026-03-31T18:30:00Z' → '2026-04-01' */
export function istDate(iso: string): string {
  return new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);
}

/** IST month of a UTC timestamp: 'YYYY-MM' */
export const istMonth = (iso: string): string => istDate(iso).slice(0, 7);

/** IST clock time 'HH:MM' of a UTC timestamp */
export function istTime(iso: string): string {
  return new Date(Date.parse(iso) + IST_MS).toISOString().slice(11, 16);
}

/** UTC timestamp of 00:00 IST on an IST date: '2026-04-01' → '2026-03-31T18:30:00Z' */
export function istMidnight(date: string): string {
  if (!isDate(date)) throw new Error(`not a date: ${date}`);
  return nowIso(new Date(Date.parse(`${date}T00:00:00Z`) - IST_MS));
}

/** Adds days to an IST date */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Adds months to a 'YYYY-MM' month */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** 'November 2026' for '2026-11' or '2026-11-15' */
export function monthName(monthOrDate: string): string {
  const [y, m] = monthOrDate.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** '15 Nov 2026' for an IST date */
export function shortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTH_SHORT[m - 1]} ${y}`;
}

/** Year the Indian financial year (April–March) of an IST date starts in: '2027-03-31' → 2026 */
export function fyStartYear(date: string): number {
  const [y, m] = date.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

/** Financial year label: 2026 → '2026-27' */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Whole hours between two timestamps (b − a) */
export function hoursBetween(a: string, b: string): number {
  return Math.floor((Date.parse(b) - Date.parse(a)) / 3_600_000);
}
