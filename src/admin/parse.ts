// Pure parsers for what people type into admin forms. Shared by forms.ts (server) and the browser scripts
// (live hints), so both read "99.5", "500 g" or "₹1,050.50" the same way. No imports besides the shared money rules.

import { parseRupees } from '../lib/money';

/** Cleans typed text: NFC, CRLF → LF, no control characters, no line breaks unless multiline, trimmed. */
export function cleanText(value: string, multiline = false): string {
  let s = value.normalize('NFC').replace(/\r\n?/g, '\n');
  // control characters other than tab and newline, plus zero-width/bidi marks that only confuse people
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​‎‏‪-‮⁦-⁩﻿]/g, '');
  s = multiline ? s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n') : s.replace(/\s*\n\s*/g, ' ').replace(/\t/g, ' ');
  return s.trim();
}

/** Characters as people count them (code points, so ₹ and Tamil letters count once per code point). */
export function textLength(s: string): number {
  return [...s].length;
}

/** Normalises a typed number: drops spaces and Indian/Western grouping commas, maps Unicode dashes to '-'. */
function compactNumber(raw: string): string {
  return raw.trim().replace(/[\s  ,]/g, '').replace(/[−‒–—]/g, '-');
}

/** '12' → 12, '1,200' → 1200, '−3' → -3; null for anything else (decimals, exponents, words, unsafe sizes). */
export function parseIntText(raw: string): number | null {
  const s = compactNumber(raw);
  if (!/^-?\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? (Object.is(n, -0) ? 0 : n) : null;
}

/**
 * A typed weight to grams. Bare numbers are kg by default: '99.5' → 99500, '0.25' → 250, '2' → 2000.
 * With a unit: '500 g' / '500gm' / '500 grams' → 500, '1.5 kg' / '1.5kgs' → 1500. At most 3 decimals for kg,
 * whole grams only. null when it is not a clear weight.
 */
export function parseGramsText(raw: string, unit: 'kg' | 'g' = 'kg'): number | null {
  let s = compactNumber(raw).toLowerCase();
  let u: 'kg' | 'g' = unit;
  const m = /^(.*?)(kgs?|kilos?|kilograms?|g|gms?|grams?)$/.exec(s);
  if (m) {
    s = m[1];
    u = m[2].startsWith('k') ? 'kg' : 'g';
  }
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let grams: number;
  if (u === 'g') {
    if (!/^\d{1,9}$/.test(s)) return null;
    grams = Number(s);
  } else {
    const k = /^(\d{1,7})(?:\.(\d{0,3}))?$/.exec(s) ?? /^()\.(\d{1,3})$/.exec(s);
    if (!k) return null;
    grams = Number(k[1] || '0') * 1000 + Number((k[2] ?? '').padEnd(3, '0'));
  }
  if (!Number.isSafeInteger(grams)) return null;
  return neg && grams !== 0 ? -grams : grams;
}

/** A typed rupee amount to paise (shared rules from src/lib/money.ts): '₹1,050.50' → 105050; null if unclear. */
export function parsePaiseText(raw: string): number | null {
  return parseRupees(raw.replace(/[  ]/g, ' '));
}

/** True for a real calendar day 'YYYY-MM-DD'. */
export function isIsoDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
