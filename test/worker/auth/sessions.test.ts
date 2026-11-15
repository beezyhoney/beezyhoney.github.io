// Admin sessions and the admin gate (amendment A1): requireAdmin(), logout, removal from ADMIN_EMAILS, helpers,
// the DEV bypass rules and the middleware in front of it (public host never reaches /admin*).
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../../src/middleware';
import {
  authConfig, authHash, clearCookie, currentUser, endSessions, LOGIN_COOKIE, logoutPost, requestLoginCode, requireAdmin,
  SESSION_COOKIE, sessionUser, verifyLoginCode, type AuthEnv,
} from '../../../src/server/auth';
import { resetLazyJobsThrottle } from '../../../src/server/jobs';
import { addTime, nowIso } from '../../../src/server/time';
import { row, rows, seedDb, sql } from '../api/_seed';

const ADMIN = 'https://admin.beezyhoney.in';
const OWNER = 'owner@example.test';
const OWNER2 = 'second-owner@example.test';
const cfg = authConfig(env)!;
const e: AuthEnv = {
  DB: env.DB as never, ADMIN_EMAILS: env.ADMIN_EMAILS, LOGIN_SECRET: env.LOGIN_SECRET, IP_HASH_KEY: env.IP_HASH_KEY,
  LOGIN_MAIL: { send: async () => ({ messageId: '<x@y>' }) },
};
const hook = () => globalThis as { BEEZY_E2E_HOOK?: { email: string; code: string }[] };

/** Logs `email` in through the real code flow (now), returns the session token. */
async function login(email: string, ip = '203.0.113.50'): Promise<string> {
  const at = nowIso();
  expect(await requestLoginCode(e, cfg, { email, ip, at })).toEqual({ ok: true });
  const code = [...(hook().BEEZY_E2E_HOOK ?? [])].reverse().find((x) => x.email === email)!.code;
  const r = await verifyLoginCode(e, cfg, { email, code, ip, at });
  if (!r.ok) throw new Error(`login failed: ${r.reason}`);
  return r.token;
}

const cookie = (token: string) => `${SESSION_COOKIE}=${token}`;
const ctxFor = (path: string, init: RequestInit = {}, host = ADMIN) => {
  const url = new URL(`${host}${path}`);
  return { url, request: new Request(url, init) };
};

beforeAll(async () => {
  await seedDb();
});

beforeEach(async () => {
  vi.stubEnv('MODE', 'e2e');
  vi.stubEnv('DEV', false);
  hook().BEEZY_E2E_HOOK = [];
  await sql('DELETE FROM rate_limits').run();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetLazyJobsThrottle();
});

describe('requireAdmin', () => {
  it('a valid session cookie gives the admin (owner from ADMIN_EMAILS) and refreshes last_seen_at', async () => {
    const token = await login(OWNER);
    const hash = await authHash(cfg.secret, 'session', token);
    await sql('UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?', addTime(nowIso(), { minutes: -30 }), hash).run();
    const user = await requireAdmin(ctxFor('/admin/orders/', { headers: { cookie: `other=1; ${cookie(token)}` } }));
    expect(user).toEqual({ email: OWNER, role: 'owner' });
    const s = await row<{ last_seen_at: string }>('SELECT last_seen_at FROM admin_sessions WHERE token_hash = ?', hash);
    expect(s!.last_seen_at >= addTime(nowIso(), { minutes: -1 })).toBe(true);
  });

  it('no session: pages get a 303 to the login page with ?next=, JSON gets 401; a bad cookie is cleared', async () => {
    const page = await requireAdmin(ctxFor('/admin/orders/12/?tab=lines'));
    expect(page).toBeInstanceOf(Response);
    expect((page as Response).status).toBe(303);
    expect((page as Response).headers.get('location')).toBe('/admin/login/?next=%2Fadmin%2Forders%2F12%2F%3Ftab%3Dlines');
    expect((page as Response).headers.get('cache-control')).toBe('no-store');
    const today = (await requireAdmin(ctxFor('/admin/'))) as Response;
    expect(today.headers.get('location')).toBe('/admin/login/');
    const api = (await requireAdmin(ctxFor('/admin/api/status.json'))) as Response;
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'login_required', login: '/admin/login/' });
    const accept = (await requireAdmin(ctxFor('/admin/orders/search/', { headers: { accept: 'application/json' } }))) as Response;
    expect(accept.status).toBe(401);
    const bad = (await requireAdmin(ctxFor('/admin/', { headers: { cookie: cookie('x'.repeat(43)) } }))) as Response;
    expect(bad.status).toBe(303);
    expect(bad.headers.getSetCookie()).toEqual([clearCookie(SESSION_COOKIE)]);
  });

  it('a session expires after 7 days (absolute)', async () => {
    const token = await login(OWNER);
    const hash = await authHash(cfg.secret, 'session', token);
    const s = await row<{ created_at: string; expires_at: string }>('SELECT created_at, expires_at FROM admin_sessions WHERE token_hash = ?', hash);
    expect(s!.expires_at).toBe(addTime(s!.created_at, { days: 7 }));
    expect(await sessionUser(env.DB as never, cfg, token, addTime(s!.expires_at, { minutes: -1 }))).toEqual({ email: OWNER, role: 'owner' });
    expect(await sessionUser(env.DB as never, cfg, token, s!.expires_at)).toBeNull();
    await sql('UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?', addTime(nowIso(), { minutes: -1 }), hash).run();
    expect((await requireAdmin(ctxFor('/admin/', { headers: { cookie: cookie(token) } }))) as Response).toBeInstanceOf(Response);
  });

  it('removing an email from ADMIN_EMAILS logs it out at once (the session row goes)', async () => {
    const token = await login(OWNER2);
    const shorter = authConfig({ ADMIN_EMAILS: OWNER, LOGIN_SECRET: env.LOGIN_SECRET, IP_HASH_KEY: env.IP_HASH_KEY })!;
    expect(await sessionUser(env.DB as never, shorter, token)).toBeNull();
    expect(await row('SELECT * FROM admin_sessions WHERE email = ?', OWNER2)).toBeNull();
    expect(await sessionUser(env.DB as never, cfg, token)).toBeNull();
  });

  it('a helper is a helper while active; switching the helper off ends the session', async () => {
    const t = nowIso();
    await sql(`INSERT INTO admin_users (email, role, active, added_at, added_by, updated_at, updated_by)
      VALUES ('helper@example.test', 'helper', 1, ?1, ?2, ?1, ?2)`, t, OWNER).run();
    const token = await login('helper@example.test');
    expect(await requireAdmin(ctxFor('/admin/', { headers: { cookie: cookie(token) } }))).toEqual({ email: 'helper@example.test', role: 'helper' });
    await sql("UPDATE admin_users SET active = 0 WHERE email = 'helper@example.test'").run();
    expect(await requireAdmin(ctxFor('/admin/', { headers: { cookie: cookie(token) } }))).toBeInstanceOf(Response);
    expect(await row("SELECT * FROM admin_sessions WHERE email = 'helper@example.test'")).toBeNull();
  });

  it('fails closed with 503 when ADMIN_EMAILS, LOGIN_SECRET or (outside dev) IP_HASH_KEY is missing', async () => {
    const token = await login(OWNER);
    const vars = env as unknown as Record<string, unknown>;
    for (const name of ['LOGIN_SECRET', 'ADMIN_EMAILS', 'IP_HASH_KEY']) {
      const saved = vars[name];
      vars[name] = '';
      try {
        const res = await requireAdmin(ctxFor('/admin/', { headers: { cookie: cookie(token) } }));
        expect(res).toBeInstanceOf(Response);
        expect((res as Response).status).toBe(503);
        expect(await (res as Response).text()).toBe('Admin login is not set up yet.\n');
      } finally {
        vars[name] = saved;
      }
    }
    expect(await requireAdmin(ctxFor('/admin/', { headers: { cookie: cookie(token) } }))).toEqual({ email: OWNER, role: 'owner' });
    // review security 4: only local development (astro dev) may run without IP_HASH_KEY
    expect(authConfig({ ADMIN_EMAILS: OWNER, LOGIN_SECRET: env.LOGIN_SECRET })).toBeNull();
    vi.stubEnv('DEV', true);
    expect(authConfig({ ADMIN_EMAILS: OWNER, LOGIN_SECRET: env.LOGIN_SECRET })).not.toBeNull();
  });
});

describe('the DEV bypass', () => {
  it('works only in DEV and only on localhost / 127.0.0.1', async () => {
    vi.stubEnv('DEV', true);
    expect(await requireAdmin(ctxFor('/admin/', {}, 'http://127.0.0.1:4421'))).toEqual({ email: 'dev@example.test', role: 'owner' });
    expect(await requireAdmin(ctxFor('/admin/', {}, 'http://localhost:4421'))).toEqual({ email: 'dev@example.test', role: 'owner' });
    expect(await requireAdmin(ctxFor('/admin/', {}, ADMIN))).toBeInstanceOf(Response);
    vi.stubEnv('DEV', false);
    expect(await requireAdmin(ctxFor('/admin/', {}, 'http://127.0.0.1:4421'))).toBeInstanceOf(Response);
  });
});

describe('logout', () => {
  const post = (fields: Record<string, string>, token?: string) => new Request(`${ADMIN}/admin/logout/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(token ? { cookie: cookie(token) } : {}) },
    body: new URLSearchParams(fields),
  });

  it('this device: the session row goes and both cookies are cleared', async () => {
    const a = await login(OWNER);
    const b = await login(OWNER);
    expect(await currentUser(e, new Request(`${ADMIN}/admin/logout/`, { headers: { cookie: cookie(a) } }))).toEqual({ email: OWNER, role: 'owner' });
    const res = await logoutPost(e, post({}, a)); // the layout's logout button sends no _action
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login/?note=out');
    expect(res.headers.getSetCookie()).toEqual([clearCookie(SESSION_COOKIE), clearCookie(LOGIN_COOKIE)]);
    expect(await sessionUser(env.DB as never, cfg, a)).toBeNull();
    expect(await sessionUser(env.DB as never, cfg, b)).toEqual({ email: OWNER, role: 'owner' });
  });

  it('all devices: every session of that email goes, other admins stay; unused login codes die; it is in the activity log', async () => {
    const a = await login(OWNER);
    const b = await login(OWNER);
    const other = await login(OWNER2);
    // a code someone asked for (e.g. on a lost phone) but did not use yet
    expect(await requestLoginCode(e, cfg, { email: OWNER, ip: '203.0.113.60' })).toEqual({ ok: true });
    const pending = [...(hook().BEEZY_E2E_HOOK ?? [])].reverse().find((x) => x.email === OWNER)!.code;
    expect(await requestLoginCode(e, cfg, { email: OWNER2, ip: '203.0.113.60' })).toEqual({ ok: true });
    const res = await logoutPost(e, post({ _action: 'all' }, a));
    expect(res.headers.get('location')).toBe('/admin/login/?note=out_all');
    expect(await sessionUser(env.DB as never, cfg, a)).toBeNull();
    expect(await sessionUser(env.DB as never, cfg, b)).toBeNull();
    expect(await sessionUser(env.DB as never, cfg, other)).toEqual({ email: OWNER2, role: 'owner' });
    expect((await rows('SELECT * FROM admin_sessions WHERE email = ?', OWNER)).length).toBe(0);
    expect(await row("SELECT actor, summary FROM audit_log WHERE action = 'auth.logout_all'")).toEqual({ actor: OWNER, summary: 'Logged out on all devices (unused login codes cancelled)' });
    // review security 1: the pending code no longer logs in; the other admin's code still works
    expect(await verifyLoginCode(e, cfg, { email: OWNER, code: pending, ip: '203.0.113.60', at: nowIso() })).toEqual({ ok: false, reason: 'wrong' });
    expect(await row("SELECT count(*) AS n FROM login_codes WHERE email = ? AND used_at IS NULL AND expires_at > ?", OWNER2, nowIso())).toEqual({ n: 1 });
  });

  it('without a valid session it just clears the cookies', async () => {
    const res = await logoutPost(e, post({ _action: 'all' }, 'y'.repeat(43)));
    expect(res.status).toBe(303);
    expect(await endSessions(env.DB as never, cfg, null)).toEqual({ email: null, ended: 0 });
  });
});

describe('the middleware in front of the login', () => {
  async function run(url: string, routePattern: string, init: RequestInit = {}) {
    const u = new URL(url);
    const locals: Record<string, unknown> = { cfContext: { waitUntil() {}, passThroughOnException() {} } };
    const next = vi.fn(async () => new Response('page', { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = (await onRequest({ isPrerendered: false, routePattern, url: u, request: new Request(u, init), locals } as never, next as never)) as Response;
    return { res, next, locals };
  }

  it('the public host never reaches /admin* (login and logout included)', async () => {
    for (const [path, pattern] of [['/admin/login/', '/admin/login'], ['/admin/logout/', '/admin/logout'], ['/admin/', '/admin'], ['/admin/login/recovery/', '/admin/login/recovery']]) {
      for (const host of ['https://beezyhoney.in', 'https://next.beezyhoney.in']) {
        const { res, next } = await run(`${host}${path}`, pattern);
        expect(res.status, `${host}${path}`).toBe(404);
        expect(next).not.toHaveBeenCalled();
      }
    }
  });

  it('the admin host: login is open, everything else needs a session (303), and a session fills locals.admin', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const open = await run(`${ADMIN}/admin/login/`, '/admin/login');
    expect(open.next).toHaveBeenCalled();
    expect(open.res.headers.get('cache-control')).toBe('no-store');
    expect(open.res.headers.get('x-frame-options')).toBe('DENY');
    const closed = await run(`${ADMIN}/admin/login/recovery/`, '/admin/login/recovery');
    expect(closed.res.status).toBe(303);
    expect(closed.next).not.toHaveBeenCalled();
    const token = await login(OWNER);
    const signedIn = await run(`${ADMIN}/admin/orders/`, '/admin/orders', { headers: { cookie: cookie(token) } });
    expect(signedIn.next).toHaveBeenCalled();
    expect(signedIn.locals.admin).toEqual({ email: OWNER, role: 'owner' });
  });

  it('a cross-site login or logout POST is refused before it reaches the page', async () => {
    for (const [path, pattern] of [['/admin/login/', '/admin/login'], ['/admin/logout/', '/admin/logout']]) {
      const { res, next } = await run(`${ADMIN}${path}`, pattern, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '_action=all' });
      expect(res.status).toBe(403);
      expect(next).not.toHaveBeenCalled();
    }
  });
});
