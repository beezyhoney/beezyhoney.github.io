import { describe, expect, it } from 'vitest';
import {
  FLASH_COOKIE, decodeFlashCookie, encodeFlashCookie, failureFlash, flashFromUrl, isUrlFlashKey, redirectWithFlash, resolveFlash,
  takeFlash, toneForKey, withFlashParam, type FlashContext,
} from '../../../src/admin/flash';

function fakeContext(url: string, cookies: Record<string, string> = {}) {
  const jar = new Map(Object.entries(cookies));
  const sets: { name: string; value: string; opts?: Record<string, unknown> }[] = [];
  const deletes: { name: string; opts?: Record<string, unknown> }[] = [];
  const ctx: FlashContext = {
    url: new URL(url),
    cookies: {
      get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
      set: (name, value, opts) => { sets.push({ name, value, opts }); jar.set(name, value); },
      delete: (name, opts) => { deletes.push({ name, opts }); jar.delete(name); },
    },
    redirect: (path, status = 302) => new Response(null, { status, headers: { location: path } }),
  };
  return { ctx, sets, deletes };
}

describe('flash keys in the URL', () => {
  it('only core flash./form. keys without placeholders are allowed', () => {
    expect(isUrlFlashKey('flash.saved')).toBe(true);
    expect(isUrlFlashKey('form.fixErrors')).toBe(true);
    expect(isUrlFlashKey('form.tooLong')).toBe(false); // has {max}
    expect(isUrlFlashKey('flash.tone.ok')).toBe(false);
    expect(isUrlFlashKey('nav.today')).toBe(false);
    expect(isUrlFlashKey('flash.made-up')).toBe(false);
    expect(isUrlFlashKey('Your account is locked')).toBe(false);
  });

  it('flashFromUrl shows the words for a known key and ignores anything else', () => {
    expect(flashFromUrl(new URL('http://x/admin/?flash=flash.saved'))).toEqual({ tone: 'ok', text: 'Saved.' });
    expect(flashFromUrl(new URL('http://x/admin/?flash=flash.conflict'))?.tone).toBe('warn');
    expect(flashFromUrl(new URL('http://x/admin/?flash=Call+999+now'))).toBeNull();
    expect(flashFromUrl(new URL('http://x/admin/'))).toBeNull();
  });

  it('withFlashParam keeps other parameters and the hash', () => {
    expect(withFlashParam('/admin/orders/?f=new#list', 'flash.saved')).toBe('/admin/orders/?f=new&flash=flash.saved#list');
    expect(withFlashParam('/admin/?flash=flash.error', 'flash.saved')).toBe('/admin/?flash=flash.saved');
  });

  it('tones by key', () => {
    expect(toneForKey('flash.saved')).toBe('ok');
    expect(toneForKey('flash.error')).toBe('error');
    expect(toneForKey('flash.publishQueued')).toBe('info');
    expect(toneForKey('flash.conflict')).toBe('warn');
    expect(toneForKey('form.fixErrors')).toBe('error');
  });
});

describe('flash cookie', () => {
  it('round-trips any text (Tamil, ₹, quotes) and refuses junk', () => {
    const f = { tone: 'warn' as const, text: 'Stock is now −2 for Murungai 250 g "recount" தேன் ₹310' };
    const v = encodeFlashCookie(f);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFlashCookie(v)).toEqual(f);
    expect(decodeFlashCookie('not base64 !!')).toBeNull();
    expect(decodeFlashCookie(encodeFlashCookie({ tone: 'ok', text: '' }))).toBeNull();
    expect(decodeFlashCookie(btoa(JSON.stringify({ o: 'evil', x: 'hi' })))).toBeNull();
    expect(decodeFlashCookie(undefined)).toBeNull();
  });

  it('long text is cut to 400 characters', () => {
    expect(decodeFlashCookie(encodeFlashCookie({ tone: 'ok', text: 'a'.repeat(1000) }))?.text).toHaveLength(400);
  });
});

describe('redirectWithFlash and takeFlash', () => {
  it('a plain core key goes in the URL with a 303 and no cookie', () => {
    const { ctx, sets } = fakeContext('http://127.0.0.1/admin/orders/12/');
    const res = redirectWithFlash(ctx, '/admin/orders/12/', { key: 'flash.saved' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/orders/12/?flash=flash.saved');
    expect(sets).toHaveLength(0);
  });

  it('text, values or a changed tone go in an HttpOnly SameSite=Strict cookie', () => {
    const { ctx, sets } = fakeContext('https://admin.beezyhoney.in/admin/stock/');
    const res = redirectWithFlash(ctx, '/admin/stock/?flash=flash.saved', { tone: 'warn', text: 'Stock is now −2' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/stock/');
    expect(sets[0].name).toBe(FLASH_COOKIE);
    expect(sets[0].opts).toMatchObject({ path: '/admin/', httpOnly: true, sameSite: 'strict', secure: true, maxAge: 120 });
    const { ctx: c2, sets: s2 } = fakeContext('http://127.0.0.1/admin/');
    redirectWithFlash(c2, '/admin/', { key: 'form.tooLong', vars: { max: 60 } });
    expect(decodeFlashCookie(s2[0].value)).toEqual({ tone: 'error', text: 'Please keep it to 60 characters or fewer.' });
    expect(s2[0].opts?.secure).toBe(false);
  });

  it('refuses off-site locations', () => {
    const { ctx } = fakeContext('http://127.0.0.1/admin/');
    expect(redirectWithFlash(ctx, 'https://evil.example/', { key: 'flash.saved' }).headers.get('location')).toBe('/admin/?flash=flash.saved');
    expect(redirectWithFlash(ctx, '//evil.example/x').headers.get('location')).toBe('/admin/');
  });

  it('takeFlash reads and clears the cookie, else falls back to the URL key', () => {
    const value = encodeFlashCookie({ tone: 'info', text: 'Hello' });
    const { ctx, deletes } = fakeContext('http://127.0.0.1/admin/?flash=flash.saved', { [FLASH_COOKIE]: value });
    expect(takeFlash(ctx)).toEqual({ tone: 'info', text: 'Hello' });
    expect(deletes).toEqual([{ name: FLASH_COOKIE, opts: { path: '/admin/' } }]);
    expect(takeFlash(ctx)).toEqual({ tone: 'ok', text: 'Saved.' });
    const { ctx: c3 } = fakeContext('http://127.0.0.1/admin/');
    expect(takeFlash(c3)).toBeNull();
  });

  it('failureFlash: the server words, warn for conflicts and state problems', () => {
    expect(failureFlash({ error: 'conflict', message: 'Someone confirmed this order first.' })).toEqual({ text: 'Someone confirmed this order first.', tone: 'warn' });
    expect(failureFlash({ error: 'needs_price', message: 'Add a price for line 2.' })).toEqual({ text: 'Add a price for line 2.', tone: 'warn' });
    expect(failureFlash({ error: 'not_found', message: 'No such order.' })).toEqual({ text: 'No such order.', tone: 'error' });
    expect(failureFlash({ error: 'conflict', message: ' ' })).toEqual({ key: 'flash.conflict' });
    expect(failureFlash({ error: 'forbidden', message: '' })).toEqual({ key: 'flash.error' });
    // it travels in the cookie (ready text), so it survives the 303
    const { ctx, sets } = fakeContext('http://127.0.0.1/admin/orders/5/');
    const res = redirectWithFlash(ctx, '/admin/orders/5/', failureFlash({ error: 'conflict', message: 'Changed meanwhile.' }));
    expect(res.status).toBe(303);
    expect(decodeFlashCookie(sets[0].value)).toEqual({ tone: 'warn', text: 'Changed meanwhile.' });
  });

  it('resolveFlash', () => {
    expect(resolveFlash({ key: 'flash.saved', tone: 'info' })).toEqual({ tone: 'info', text: 'Saved.' });
  });
});
