// Safe reading of admin form posts (plain HTML forms, see README "Form pattern").
//
//   const form = await readForm(Astro.request);           // null when the body is not a readable form
//   if (!form) return redirectWithFlash(Astro, Astro.url.pathname, { key: 'form.unreadable', tone: 'error' });
//   const action = form.action(['save', 'confirm']);       // from <button name="_action" value="save">
//   const name = form.text('name', { required: true, max: 60 });
//   const price = form.paise('price', { min: 100 });        // '₹1,050.50' → 105050, '' → null
//   const left = form.grams('on_hand');                     // '99.5' → 99500 (kg input; '500 g' also works)
//   if (!form.ok) { errors = form.messages(); /* render the page again with the typed values, status 422 */ }
//
// Every reader returns a clean value or null and records a message key (from strings.ts) per field on problems.
// Nothing here throws on bad input. CSRF is handled by the middleware (Origin / Sec-Fetch-Site) and SameSite cookies,
// so there are no tokens. Pure web APIs only (works in workerd, Node and the browser).

import { dateIST, inr, int, kg } from './format';
import { cleanText, isIsoDay, parseGramsText, parseIntText, parsePaiseText, textLength } from './parse';
import { t, type StringKey, type Vars } from './strings';

export interface FieldError {
  key: StringKey;
  vars?: Vars;
  /** ready words (e.g. a src/server Failure message); used instead of `key` when set */
  text?: string;
}

/** The failure half of a src/server Result (src/server/db.ts `Failure`), as far as forms need it. */
export interface ServerFailure {
  ok: false;
  error: string;
  message: string;
  field?: string;
}

export interface TextOptions {
  required?: boolean;
  /** most characters allowed (counted as Unicode code points) */
  max?: number;
  min?: number;
  /** keep line breaks (textarea); otherwise they become spaces */
  multiline?: boolean;
  /** extra check on the cleaned text; failure records 'form.badFormat' (or `patternError`) */
  pattern?: RegExp;
  patternError?: StringKey;
}

export interface NumberOptions {
  required?: boolean;
  min?: number;
  max?: number;
}

export interface MoneyOptions {
  required?: boolean;
  /** smallest allowed, in paise (default 0) */
  min?: number;
  /** largest allowed, in paise (default ₹1,00,00,000) */
  max?: number;
  /** allow amounts below zero (refunds) */
  allowNegative?: boolean;
  /** refuse exactly ₹0 */
  nonZero?: boolean;
}

export interface GramsOptions {
  required?: boolean;
  /** smallest allowed, in grams (default 0) */
  min?: number;
  /** largest allowed, in grams (default 1,000,000 g = 1 tonne) */
  max?: number;
  allowNegative?: boolean;
  nonZero?: boolean;
  /** unit when the person types a bare number: 'kg' (default) or 'g' */
  unit?: 'kg' | 'g';
}

export interface DateOptions {
  required?: boolean;
  /** earliest allowed 'YYYY-MM-DD' */
  min?: string;
  /** latest allowed 'YYYY-MM-DD' */
  max?: string;
}

const MAX_RUPEES_PAISE = 10_000_000_00; // ₹1 crore
const MAX_GRAMS = 1_000_000;
const TRUE_WORDS = new Set(['1', 'true', 'on', 'yes']);
const FALSE_WORDS = new Set(['0', 'false', 'off', 'no', '']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The parsers are shared with the browser scripts; re-exported so screens need only this module.
export { cleanText, isIsoDay, parseGramsText, parseIntText, parsePaiseText, textLength };

/** A fresh idempotency key for a form (put it in a hidden input named _key). */
export function newFormKey(): string {
  return crypto.randomUUID();
}

export interface FormReader {
  /** true while no field has an error */
  readonly ok: boolean;
  /** field name → error (message key + values) */
  readonly errors: Readonly<Record<string, FieldError>>;
  /** field name → error text, ready for the components' `error` prop */
  messages(): Record<string, string>;
  /** adds an error for a field yourself (e.g. a cross-field rule); the first error per field wins */
  fail(field: string, key: StringKey, vars?: Vars): void;
  /** adds an error with ready words (e.g. a server message); the first error per field wins */
  failText(field: string, text: string): void;
  /**
   * Puts a src/server failure on its field when that field is one of `fields` (the ones this form shows) and returns
   * true; returns false when it belongs in a flash instead (no field, or a field this form does not have).
   */
  takeFailure(failure: ServerFailure, fields: readonly string[]): boolean;
  /** the raw typed value (last one), for refilling the form after an error; '' when missing */
  raw(name: string): string;
  /** all raw values of a field */
  rawAll(name: string): string[];
  /** true when the field was sent at all (even empty) */
  has(name: string): boolean;
  /** cleaned text; '' when empty */
  text(name: string, opts?: TextOptions): string;
  /** cleaned text, or null when empty */
  optText(name: string, opts?: TextOptions): string | null;
  /** whole number, or null when empty or wrong */
  int(name: string, opts?: NumberOptions): number | null;
  /** every value of a repeated field as whole numbers (wrong ones are reported and left out) */
  ints(name: string, opts?: NumberOptions): number[];
  /** rupees typed by a person → paise, or null when empty or wrong */
  paise(name: string, opts?: MoneyOptions): number | null;
  /** kg typed by a person → grams, or null when empty or wrong */
  grams(name: string, opts?: GramsOptions): number | null;
  /** checkbox / toggle / select of yes-no: the last value decides; missing → false */
  bool(name: string): boolean;
  /** 'YYYY-MM-DD' from <input type="date">, or null */
  date(name: string, opts?: DateOptions): string | null;
  /** 'YYYY-MM' from <input type="month">, or null */
  month(name: string, opts?: { required?: boolean; min?: string; max?: string }): string | null;
  /** one of the allowed values, or null */
  choice<T extends string>(name: string, allowed: readonly T[], opts?: { required?: boolean }): T | null;
  /** every value of a repeated field that is in the allowed list */
  choices<T extends string>(name: string, allowed: readonly T[]): T[];
  /** the pressed button's _action (last _action value), if it is allowed; null otherwise (no error recorded) */
  action<T extends string>(allowed: readonly T[]): T | null;
  /** the record version for optimistic saves (hidden input "version"), a whole number ≥ 1, or null */
  version(name?: string): number | null;
  /** the form's idempotency key (hidden input "_key", a UUID), or null */
  key(name?: string): string | null;
}

/** Reads FormData / URLSearchParams (File values are ignored: uploads go through /admin/api/media.json). */
export function formReader(data: FormData | URLSearchParams): FormReader {
  const errors: Record<string, FieldError> = {};
  const all = (name: string): string[] =>
    (data.getAll(name) as unknown[]).filter((v): v is string => typeof v === 'string');
  const last = (name: string): string => {
    const values = all(name);
    return values.length ? values[values.length - 1] : '';
  };
  const fail = (field: string, key: StringKey, vars?: Vars) => {
    if (!errors[field]) errors[field] = vars ? { key, vars } : { key };
  };

  const readText = (name: string, opts: TextOptions = {}): string => {
    const s = cleanText(last(name), opts.multiline);
    if (!s) {
      if (opts.required) fail(name, 'form.required');
      return '';
    }
    const len = textLength(s);
    if (opts.max !== undefined && len > opts.max) fail(name, 'form.tooLong', { max: opts.max });
    else if (opts.min !== undefined && len < opts.min) fail(name, 'form.tooShort', { min: opts.min });
    else if (opts.pattern && !opts.pattern.test(s)) fail(name, opts.patternError ?? 'form.badFormat');
    return s;
  };

  const intValue = (name: string, raw: string, opts: NumberOptions): number | null => {
    const n = parseIntText(raw);
    if (n === null) { fail(name, 'form.notNumber'); return null; }
    if (opts.min !== undefined && n < opts.min) { fail(name, opts.min === 0 ? 'form.negative' : 'form.tooSmall', { min: int(opts.min) }); return null; }
    if (opts.max !== undefined && n > opts.max) { fail(name, 'form.tooBig', { max: int(opts.max) }); return null; }
    return n;
  };

  const reader: FormReader = {
    get ok() { return Object.keys(errors).length === 0; },
    get errors() { return errors; },
    messages() {
      return Object.fromEntries(Object.entries(errors).map(([f, e]) => [f, e.text ?? t(e.key, e.vars)]));
    },
    fail,
    failText(field, text) {
      const words = cleanText(text);
      if (!errors[field]) errors[field] = words ? { key: 'form.badFormat', text: words } : { key: 'form.badFormat' };
    },
    takeFailure(failure, fields) {
      if (!failure.field || !fields.includes(failure.field)) return false;
      reader.failText(failure.field, failure.message);
      return true;
    },
    raw: last,
    rawAll: all,
    has: (name) => data.has(name),
    text: (name, opts) => readText(name, opts),
    optText: (name, opts) => readText(name, opts) || null,

    int(name, opts = {}) {
      const raw = last(name).trim();
      if (!raw) { if (opts.required) fail(name, 'form.required'); return null; }
      return intValue(name, raw, opts);
    },

    ints(name, opts = {}) {
      const out: number[] = [];
      for (const raw of all(name)) {
        if (!raw.trim()) continue;
        const n = intValue(name, raw, opts);
        if (n !== null) out.push(n);
      }
      if (opts.required && out.length === 0) fail(name, 'form.required');
      return out;
    },

    paise(name, opts = {}) {
      const raw = last(name).trim();
      if (!raw) { if (opts.required) fail(name, 'form.required'); return null; }
      const p = parsePaiseText(raw);
      if (p === null) { fail(name, 'form.notMoney'); return null; }
      const min = opts.min ?? (opts.allowNegative ? -MAX_RUPEES_PAISE : 0);
      const max = opts.max ?? MAX_RUPEES_PAISE;
      if (p < 0 && !opts.allowNegative) { fail(name, 'form.negative'); return null; }
      if (p === 0 && opts.nonZero) { fail(name, 'form.zero'); return null; }
      if (p < min) { fail(name, 'form.tooSmall', { min: inr(min) }); return null; }
      if (p > max) { fail(name, 'form.tooBig', { max: inr(max) }); return null; }
      return p;
    },

    grams(name, opts = {}) {
      const raw = last(name).trim();
      if (!raw) { if (opts.required) fail(name, 'form.required'); return null; }
      const g = parseGramsText(raw, opts.unit);
      if (g === null) { fail(name, 'form.notWeight'); return null; }
      const min = opts.min ?? (opts.allowNegative ? -MAX_GRAMS : 0);
      const max = opts.max ?? MAX_GRAMS;
      if (g < 0 && !opts.allowNegative) { fail(name, 'form.negative'); return null; }
      if (g === 0 && opts.nonZero) { fail(name, 'form.zero'); return null; }
      if (g < min) { fail(name, 'form.tooSmall', { min: kg(min, 3) }); return null; }
      if (g > max) { fail(name, 'form.tooBig', { max: kg(max, 1) }); return null; }
      return g;
    },

    bool(name) {
      const v = last(name).trim().toLowerCase();
      if (TRUE_WORDS.has(v)) return true;
      if (FALSE_WORDS.has(v)) return false;
      return false;
    },

    date(name, opts = {}) {
      const raw = last(name).trim();
      if (!raw) { if (opts.required) fail(name, 'form.required'); return null; }
      if (!isIsoDay(raw)) { fail(name, 'form.notDate'); return null; }
      if (opts.min && raw < opts.min) { fail(name, 'form.dateTooEarly', { min: dateIST(opts.min) }); return null; }
      if (opts.max && raw > opts.max) { fail(name, 'form.dateTooLate', { max: dateIST(opts.max) }); return null; }
      return raw;
    },

    month(name, opts = {}) {
      const raw = last(name).trim();
      if (!raw) { if (opts.required) fail(name, 'form.required'); return null; }
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) { fail(name, 'form.notMonth'); return null; }
      if (opts.min && raw < opts.min) { fail(name, 'form.dateTooEarly', { min: opts.min }); return null; }
      if (opts.max && raw > opts.max) { fail(name, 'form.dateTooLate', { max: opts.max }); return null; }
      return raw;
    },

    choice(name, allowed, opts = {}) {
      const raw = last(name);
      if (!raw) { if (opts.required) fail(name, 'form.required'); return null; }
      if ((allowed as readonly string[]).includes(raw)) return raw as (typeof allowed)[number];
      fail(name, 'form.notChoice');
      return null;
    },

    choices(name, allowed) {
      const set = new Set(allowed as readonly string[]);
      return [...new Set(all(name).filter((v) => set.has(v)))] as (typeof allowed)[number][];
    },

    action(allowed) {
      const values = all('_action');
      for (let i = values.length - 1; i >= 0; i--) {
        if ((allowed as readonly string[]).includes(values[i])) return values[i] as (typeof allowed)[number];
      }
      return null;
    },

    version(name = 'version') {
      const n = parseIntText(last(name));
      return n !== null && n >= 1 ? n : null;
    },

    key(name = '_key') {
      const k = last(name).trim().toLowerCase();
      return UUID.test(k) ? k : null;
    },
  };
  return reader;
}

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data'];

/**
 * Reads a form post safely. Returns null (never throws) when the method is not POST, the content type is not a form,
 * the body is larger than `maxBytes` (default 64 KB) or cannot be parsed.
 */
export async function readForm(request: Request, opts: { maxBytes?: number } = {}): Promise<FormReader | null> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  if (request.method !== 'POST') return null;
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!FORM_TYPES.some((f) => type.startsWith(f))) return null;
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > maxBytes) return null;
    if (type.startsWith('application/x-www-form-urlencoded')) {
      return formReader(new URLSearchParams(new TextDecoder().decode(body)));
    }
    const data = await new Response(body, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
    return formReader(data);
  } catch {
    return null;
  }
}
