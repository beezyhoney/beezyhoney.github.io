// Flash messages: the one-line notice shown at the top of a page after a form post and its 303 redirect.
//
// Two ways to carry one across the redirect:
// 1. URL key (simple, no cookie): '/admin/orders/12/?flash=flash.saved'. Only core string keys starting with
//    'flash.' or 'form.' are accepted, so a crafted link can never show made-up text. The browser script removes
//    the parameter from the address bar after showing it, so a reload does not repeat it.
// 2. Cookie (any text, e.g. "Stock is now −2 for Murungai 250 g, recount soon"): set by the server only,
//    HttpOnly + SameSite=Strict, 2 minutes. The page must call takeFlash(Astro) in its frontmatter (before any
//    HTML is sent) so the cookie is cleared; the layout can no longer change cookies once streaming starts.
//
// redirectWithFlash() picks the right way: { key } → URL, { text } → cookie.

import { isStringKey, t, type StringKey, type Vars } from './strings';

export type FlashTone = 'ok' | 'info' | 'warn' | 'error';

export interface Flash {
  tone: FlashTone;
  text: string;
}

/** What a page asks for: a core key (tone guessed from the key unless given) or ready text. */
export type FlashInput = { key: StringKey; vars?: Vars; tone?: FlashTone } | { text: string; tone: FlashTone };

export const FLASH_PARAM = 'flash';
export const FLASH_COOKIE = 'bz_flash';
const COOKIE_PATH = '/admin/';
const MAX_TEXT = 400;
const TONES: readonly FlashTone[] = ['ok', 'info', 'warn', 'error'];

/** Default tone for a core key. */
export function toneForKey(key: string): FlashTone {
  if (key.startsWith('form.')) return 'error';
  switch (key) {
    case 'flash.conflict':
    case 'flash.nothingChanged':
      return 'warn';
    case 'flash.notFound':
    case 'flash.forbidden':
    case 'flash.invalid':
    case 'flash.error':
      return 'error';
    case 'flash.publishQueued':
    case 'flash.publishOff':
    case 'flash.notReady':
    case 'flash.signedOut':
      return 'info';
    default:
      return 'ok';
  }
}

/** Keys allowed in ?flash= (no placeholders, so nothing in the URL can change the words). */
export function isUrlFlashKey(key: string): key is StringKey {
  return (key.startsWith('flash.') || key.startsWith('form.')) && !key.startsWith('flash.tone.') && isStringKey(key)
    && !/\{\w+\}/.test(t(key));
}

/** Reads ?flash=<key> without changing anything (the layout uses this when the page passed no flash). */
export function flashFromUrl(url: URL): Flash | null {
  const key = url.searchParams.get(FLASH_PARAM);
  if (!key || !isUrlFlashKey(key)) return null;
  return { tone: toneForKey(key), text: t(key) };
}

/** Adds ?flash=<key> to a same-site path, keeping its other parameters. Unknown keys are dropped. */
export function withFlashParam(location: string, key: StringKey): string {
  const u = new URL(location, 'http://x');
  u.searchParams.delete(FLASH_PARAM);
  if (isUrlFlashKey(key)) u.searchParams.set(FLASH_PARAM, key);
  return `${u.pathname}${u.search}${u.hash}`;
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Cookie value for a flash (base64url JSON, cookie-safe). */
export function encodeFlashCookie(flash: Flash): string {
  return toBase64Url(JSON.stringify({ o: flash.tone, x: flash.text.slice(0, MAX_TEXT) }));
}

/** Reads a flash cookie value; null when it is missing or not ours. */
export function decodeFlashCookie(value: string | undefined | null): Flash | null {
  if (!value || value.length > 2000) return null;
  const json = fromBase64Url(value);
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { o?: unknown; x?: unknown };
    if (typeof v.x !== 'string' || !v.x.trim() || !TONES.includes(v.o as FlashTone)) return null;
    return { tone: v.o as FlashTone, text: v.x.slice(0, MAX_TEXT) };
  } catch {
    return null;
  }
}

/** The parts of Astro / APIContext these helpers use. */
export interface FlashContext {
  url: URL;
  cookies: {
    get(name: string): { value: string } | undefined;
    set(name: string, value: string, opts?: Record<string, unknown>): void;
    delete(name: string, opts?: Record<string, unknown>): void;
  };
  redirect(path: string, status?: 301 | 302 | 303 | 307 | 308 | 300 | 304): Response;
}

function cookieOptions(url: URL) {
  return { path: COOKIE_PATH, httpOnly: true, sameSite: 'strict' as const, secure: url.protocol === 'https:' };
}

/**
 * The flash for this request: the cookie (cleared here) or ?flash=<key>. Call it in the page frontmatter and pass
 * the result to <AdminLayout flash={...}>.
 */
export function takeFlash(ctx: Pick<FlashContext, 'url' | 'cookies'>): Flash | null {
  const cookie = ctx.cookies.get(FLASH_COOKIE)?.value;
  if (cookie !== undefined) {
    ctx.cookies.delete(FLASH_COOKIE, { path: COOKIE_PATH });
    const f = decodeFlashCookie(cookie);
    if (f) return f;
  }
  return flashFromUrl(ctx.url);
}

/**
 * The flash for a src/server failure ({ ok: false, error, message }): the server's own words; "check" (warn) for
 * conflicts and state problems, "problem" (error) for everything else.
 *   if (!r.ok) return redirectWithFlash(Astro, SELF, failureFlash(r));
 */
export function failureFlash(failure: { error: string; message: string }): FlashInput {
  const warn = ['conflict', 'not_allowed', 'needs_price', 'needs_restock_answer'].includes(failure.error);
  const text = failure.message.trim();
  return text ? { text, tone: warn ? 'warn' : 'error' } : { key: warn ? 'flash.conflict' : 'flash.error' };
}

/** Turns a FlashInput into the shown flash. */
export function resolveFlash(input: FlashInput): Flash {
  if ('key' in input) return { tone: input.tone ?? toneForKey(input.key), text: t(input.key, input.vars) };
  return { tone: input.tone, text: input.text };
}

/**
 * 303 See Other to `location` (same site, e.g. Astro.url.pathname) carrying a flash.
 * A core key without values travels in the URL; anything else (text, values, a changed tone) goes in the cookie.
 */
export function redirectWithFlash(ctx: FlashContext, location: string, input?: FlashInput): Response {
  const safe = location.startsWith('/') && !location.startsWith('//') ? location : '/admin/';
  if (!input) return ctx.redirect(safe, 303);
  if ('key' in input && !input.vars && (!input.tone || input.tone === toneForKey(input.key)) && isUrlFlashKey(input.key)) {
    return ctx.redirect(withFlashParam(safe, input.key), 303);
  }
  ctx.cookies.set(FLASH_COOKIE, encodeFlashCookie(resolveFlash(input)), { ...cookieOptions(ctx.url), maxAge: 120 });
  const clean = new URL(safe, 'http://x');
  clean.searchParams.delete(FLASH_PARAM);
  return ctx.redirect(`${clean.pathname}${clean.search}${clean.hash}`, 303);
}
