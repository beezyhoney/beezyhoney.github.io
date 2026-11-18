// The admin login (amendment A1) in workerd with the real D1: email step, code step, limits, recovery codes,
// cookies, fail-closed config and the e2e hook. Secrets are the fixed test values from vitest.config.mjs
// (owners owner@example.test and second-owner@example.test), never the real ones.
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as e2eGET } from '../../../src/pages/api/e2e/login-code.json';
import {
  authConfig, authHash, clearCookie, createRecoveryCodes, currentUser, e2eLastCode, LIMITS, LOGIN_COOKIE, LOGIN_ERRORS,
  loginGet, loginPost, logoutPost, makeRecoveryCodes, newLoginCode, newRecoveryCode, newSessionToken, normaliseEmail, normaliseRecoveryCode,
  recoveryStatus, requestLoginCode, safeEqual, safeNext, SESSION_COOKIE, sessionCookie, verifyLoginCode, verifyRecoveryCode,
  type AuthEnv,
} from '../../../src/server/auth';
import { buildLoginCodeEmail, sendLoginCodeEmail } from '../../../src/server/mail';
import { addTime } from '../../../src/server/time';
import { row, rows, seedDb, sql } from '../api/_seed';

const ADMIN = 'https://admin.beezyhoney.in';
const OWNER = 'owner@example.test';
const OWNER2 = 'second-owner@example.test';
const T0 = '2026-11-15T04:30:00Z'; // 10:00 IST
const at = (minutes: number) => addTime(T0, { minutes });
const cfg = authConfig(env)!;

interface Sent { from: string; to: string }
function testEnv(): { e: AuthEnv; sent: Sent[] } {
  const sent: Sent[] = [];
  const e: AuthEnv = {
    DB: env.DB as never,
    ADMIN_EMAILS: env.ADMIN_EMAILS,
    LOGIN_SECRET: env.LOGIN_SECRET,
    IP_HASH_KEY: env.IP_HASH_KEY,
    LOGIN_MAIL: { send: async (m: unknown) => { sent.push({ from: (m as Sent).from, to: (m as Sent).to }); return { messageId: '<x@y>' }; } },
  };
  return { e, sent };
}

function form(fields: Record<string, string>, opts: { cookie?: string; ip?: string; url?: string } = {}) {
  return new Request(opts.url ?? `${ADMIN}/admin/login/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': opts.ip ?? '203.0.113.1',
      'user-agent': 'TestPhone/1.0',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: new URLSearchParams(fields),
  });
}

async function postLogin(e: AuthEnv, fields: Record<string, string>, opts: { cookie?: string; ip?: string; at?: string } = {}) {
  const req = form(fields, opts);
  return loginPost(e, req, new URL(req.url), { at: opts.at ?? T0 });
}

const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieValue = (res: Response, name: string) => {
  const c = setCookies(res).find((x) => x.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1, c.indexOf(';')) : null;
};
const loginCookieFor = (email: string) => `${LOGIN_COOKIE}=${encodeURIComponent(email)}`;
const hook = () => globalThis as { BEEZY_E2E_HOOK?: unknown[] };

beforeAll(async () => {
  await seedDb();
});

beforeEach(async () => {
  vi.stubEnv('MODE', 'e2e'); // lets the tests read the codes they asked for (e2eLastCode)
  hook().BEEZY_E2E_HOOK = [];
  await sql('DELETE FROM rate_limits').run();
  await sql('DELETE FROM login_codes').run();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('configuration (fail closed)', () => {
  it('needs ADMIN_EMAILS and a LOGIN_SECRET of at least 32 characters', () => {
    expect(cfg.adminEmails).toEqual([OWNER, OWNER2]);
    expect(authConfig({ ADMIN_EMAILS: ' A@Example.test ; b@example.test,,bad', LOGIN_SECRET: 'x'.repeat(32) })!.adminEmails).toEqual(['a@example.test', 'b@example.test']);
    expect(authConfig({ ADMIN_EMAILS: '', LOGIN_SECRET: 'x'.repeat(64) })).toBeNull();
    expect(authConfig({ ADMIN_EMAILS: 'not-an-email', LOGIN_SECRET: 'x'.repeat(64) })).toBeNull();
    expect(authConfig({ ADMIN_EMAILS: OWNER, LOGIN_SECRET: '' })).toBeNull();
    expect(authConfig({ ADMIN_EMAILS: OWNER, LOGIN_SECRET: 'replace-with-64-hex-characters' })).toBeNull(); // the .dev.vars.example placeholder
    expect(authConfig({ ADMIN_EMAILS: OWNER })).toBeNull();
  });

  it('every login page answers "not set up" (503) without them', async () => {
    const e = { DB: env.DB as never, ADMIN_EMAILS: OWNER } as AuthEnv;
    const req = form({ _action: 'send', email: OWNER });
    expect((await loginGet(e, new Request(`${ADMIN}/admin/login/`), new URL(`${ADMIN}/admin/login/`))).kind).toBe('unavailable');
    expect((await loginPost(e, req, new URL(req.url))).kind).toBe('unavailable');
    expect((await logoutPost(e, form({}, { url: `${ADMIN}/admin/logout/` }))).status).toBe(503);
    expect(await currentUser(e, new Request(`${ADMIN}/admin/logout/`))).toBe('unavailable');
    expect(await row('SELECT * FROM login_codes')).toBeNull();
  });
});

describe('random values and hashing', () => {
  it('codes, tokens and recovery codes have the right form', () => {
    const codes = new Set(Array.from({ length: 300 }, () => newLoginCode()));
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(290);
    expect(newSessionToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newRecoveryCode()).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(normaliseRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(normaliseRecoveryCode('ABCDE-FGHJ0')).toBeNull(); // 0 is not in the alphabet
    expect(normaliseRecoveryCode('short')).toBeNull();
    expect(normaliseEmail('  Owner@Example.TEST ')).toBe(OWNER);
    expect(normaliseEmail('a@b.c\r\nBcc: x@y.z')).toBeNull();
  });

  it('hashes are keyed HMACs and compared in constant time', async () => {
    const h = await authHash(cfg.secret, 'code', `${OWNER}|123456`);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await authHash('another-secret-another-secret-123', 'code', `${OWNER}|123456`)).not.toBe(h);
    expect(await authHash(cfg.secret, 'session', `${OWNER}|123456`)).not.toBe(h);
    expect(safeEqual(h, h)).toBe(true);
    expect(safeEqual(h, `${h.slice(0, -1)}0`)).toBe(h.endsWith('0'));
    expect(safeEqual(h, h.slice(1))).toBe(false);
  });

  it('the cookie strings carry every A1 flag', () => {
    const c = sessionCookie('t'.repeat(43));
    expect(c).toBe(`${SESSION_COOKIE}=${'t'.repeat(43)}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Strict`);
    expect(SESSION_COOKIE).toBe('__Host-bz_admin');
    expect(clearCookie(SESSION_COOKIE)).toBe('__Host-bz_admin=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict');
  });

  it('safeNext keeps only same-site admin paths (never the login pages)', () => {
    expect(safeNext('/admin/orders/12/?tab=new')).toBe('/admin/orders/12/?tab=new');
    expect(safeNext('/admin/login/recovery/')).toBe('/admin/login/recovery/');
    for (const bad of ['//evil.example/admin/', 'https://evil.example/admin/', '/admin/../shop/', '/admin/login/', '/admin/login/?step=code', '/admin/login/x/', '/admin/logout/', '/\\evil', '/shop/', '', null, '/admin/\nx']) {
      expect(safeNext(bad), String(bad)).toBe('/admin/');
    }
  });
});

describe('step 1: asking for a code', () => {
  it('an allowed email gets a code by email and goes to the code step', async () => {
    const { e, sent } = testEnv();
    const a = await postLogin(e, { _action: 'send', email: ' Owner@Example.test ', next: '/admin/orders/' });
    expect(a.kind).toBe('redirect');
    const res = (a as { response: Response }).response;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login/?step=code&note=sent&next=%2Fadmin%2Forders%2F');
    expect(setCookies(res)).toEqual([`${LOGIN_COOKIE}=${encodeURIComponent(OWNER)}; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Strict`]);
    expect(sent).toEqual([{ from: 'login@beezyhoney.in', to: OWNER }]);
    const codes = await rows<{ email: string; code_hash: string; expires_at: string; attempts: number; ip_hash: string }>('SELECT * FROM login_codes');
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ email: OWNER, expires_at: at(10), attempts: 0 });
    const code = e2eLastCode(OWNER)!.code;
    expect(codes[0].code_hash).toBe(await authHash(cfg.secret, 'code', `${OWNER}|${code}`));
    expect(codes[0].code_hash).not.toContain(code);
    expect(codes[0].ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(e2eLastCode('stranger@example.test')).toBeNull();
  });

  it('an email that may not log in is told so: no code, no mail, no code step, no cookie', async () => {
    const { e, sent } = testEnv();
    for (const action of ['send', 'use_recovery']) {
      const r = await postLogin(e, { _action: action, email: 'Stranger@Example.test', next: '/admin/orders/' }, { ip: '203.0.113.2' });
      expect(r).toEqual({ kind: 'view', view: expect.objectContaining({ step: 'email', status: 403, error: LOGIN_ERRORS.noAccess, typedEmail: 'Stranger@Example.test' }) });
    }
    expect(sent).toEqual([]);
    expect(await rows('SELECT * FROM login_codes')).toEqual([]);
    expect(e2eLastCode('stranger@example.test')).toBeNull();
    // a switched-off helper is refused the same way
    await sql(`INSERT INTO admin_users (email, role, active, added_at, added_by, updated_at, updated_by)
      VALUES ('off@example.test', 'helper', 0, ?1, ?2, ?1, ?2)`, T0, OWNER).run();
    const off = await postLogin(e, { _action: 'send', email: 'off@example.test' }, { ip: '203.0.113.3' });
    expect(off).toEqual({ kind: 'view', view: expect.objectContaining({ status: 403, error: LOGIN_ERRORS.noAccess }) });
    expect(sent).toEqual([]);
  });

  it('refused emails still count against the connection: one IP cannot try emails without end', async () => {
    const { e } = testEnv();
    let last: unknown;
    for (let i = 0; i <= LIMITS.attemptsPerIpHour; i++) last = await postLogin(e, { _action: 'send', email: `guess${i}@example.test` }, { ip: '203.0.113.9' });
    expect(last).toEqual({ kind: 'view', view: expect.objectContaining({ step: 'email', status: 429, error: LOGIN_ERRORS.ipLimit }) });
  });

  it('an active helper may log in; a switched-off helper may not', async () => {
    const { e, sent } = testEnv();
    await sql(`INSERT INTO admin_users (email, role, active, added_at, added_by, updated_at, updated_by)
      VALUES ('helper@example.test', 'helper', 1, ?1, ?2, ?1, ?2), ('old-helper@example.test', 'helper', 0, ?1, ?2, ?1, ?2)`, T0, OWNER).run();
    await requestLoginCode(e, cfg, { email: 'helper@example.test', ip: '1.1.1.1', at: T0 });
    await requestLoginCode(e, cfg, { email: 'old-helper@example.test', ip: '1.1.1.1', at: T0 });
    expect(sent.map((s) => s.to)).toEqual(['helper@example.test']);
  });

  it('a typing mistake shows the email step again (422) with what was typed', async () => {
    const { e } = testEnv();
    const r = await postLogin(e, { _action: 'send', email: 'owner at example' });
    expect(r).toEqual({ kind: 'view', view: expect.objectContaining({ step: 'email', status: 422, error: LOGIN_ERRORS.email, typedEmail: 'owner at example' }) });
  });

  it('the real send_email binding (Miniflare simulation) accepts our MIME message', async () => {
    const log = vi.spyOn(console, 'error');
    expect(await sendLoginCodeEmail(env.LOGIN_MAIL as never, OWNER, '123456')).toBe(true);
    expect(log).not.toHaveBeenCalled();
    // a refused message (or a missing binding) is logged without the address and reported, never thrown
    log.mockImplementation(() => {});
    const refusing = { send: async () => { throw new Error(`email to ${OWNER} not allowed`); } };
    expect(await sendLoginCodeEmail(refusing, OWNER, '123456')).toBe(false);
    expect(await sendLoginCodeEmail(undefined, OWNER, '123456')).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain(OWNER);
    expect(buildLoginCodeEmail(OWNER, '123456').raw).toMatch(/^Message-ID: <[0-9a-f]{32}\.[0-9a-z]+@beezyhoney\.in>\r$/m);
    const e ={ ...testEnv().e, LOGIN_MAIL: env.LOGIN_MAIL as never };
    expect(await requestLoginCode(e, cfg, { email: OWNER, ip: '1.2.3.4', at: T0 })).toEqual({ ok: true });
  });

  it('"I have a recovery code" stores the email but sends nothing', async () => {
    const { e, sent } = testEnv();
    const r = await postLogin(e, { _action: 'use_recovery', email: OWNER });
    const res = (r as { response: Response }).response;
    expect(res.headers.get('location')).toBe('/admin/login/?step=recovery');
    expect(cookieValue(res, LOGIN_COOKIE)).toBe(encodeURIComponent(OWNER));
    expect(sent).toEqual([]);
    expect(await row('SELECT * FROM login_codes')).toBeNull();
  });
});

describe('step 2: the code', () => {
  async function codeFor(e: AuthEnv, email = OWNER, when = T0, ip = '203.0.113.1') {
    expect(await requestLoginCode(e, cfg, { email, ip, at: when })).toEqual({ ok: true });
    return e2eLastCode(email)!.code;
  }
  const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  it('the right code logs in once; the session is stored hashed', async () => {
    const { e } = testEnv();
    const code = await codeFor(e);
    const r = await verifyLoginCode(e, cfg, { email: OWNER, code: `${code.slice(0, 3)} ${code.slice(3)}`, ip: '203.0.113.1', userAgent: 'TestPhone/1.0', at: at(2) });
    expect(r).toMatchObject({ ok: true, email: OWNER, role: 'owner', firstLogin: true });
    const token = (r as { token: string }).token;
    const s = await row<Record<string, unknown>>('SELECT * FROM admin_sessions WHERE email = ?', OWNER);
    expect(s).toMatchObject({ token_hash: await authHash(cfg.secret, 'session', token), created_at: at(2), expires_at: addTime(at(2), { days: 7 }), user_agent: 'TestPhone/1.0' });
    expect(JSON.stringify(s)).not.toContain(token);
    expect(await row("SELECT action, actor FROM audit_log WHERE action = 'auth.login'")).toEqual({ action: 'auth.login', actor: OWNER });
    // single use
    expect(await verifyLoginCode(e, cfg, { email: OWNER, code, ip: '203.0.113.1', at: at(3) })).toEqual({ ok: false, reason: 'wrong' });
    await sql('DELETE FROM admin_sessions').run();
  });

  it('5 wrong tries kill the code', async () => {
    const { e } = testEnv();
    const code = await codeFor(e);
    for (let i = 0; i < LIMITS.codeTries; i++) {
      expect(await verifyLoginCode(e, cfg, { email: OWNER, code: wrongOf(code), ip: '203.0.113.1', at: at(1) })).toEqual({ ok: false, reason: 'wrong' });
    }
    expect((await row<{ attempts: number }>('SELECT attempts FROM login_codes'))!.attempts).toBe(5);
    expect(await verifyLoginCode(e, cfg, { email: OWNER, code, ip: '203.0.113.1', at: at(1) })).toEqual({ ok: false, reason: 'wrong' });
  });

  it('parallel guesses cannot pass the 5-try limit; the right code still works on the 5th try (review: security 2)', async () => {
    const { e } = testEnv();
    const code = await codeFor(e);
    // 20 wrong guesses at the same moment from 20 addresses: each try is counted before its compare, so the code dies after 5
    const guesses = Array.from({ length: 20 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0'));
    const results = await Promise.all(guesses.map((g, i) => verifyLoginCode(e, cfg, { email: OWNER, code: g, ip: `198.51.100.${i + 1}`, at: at(1) })));
    expect(results.every((r) => !r.ok)).toBe(true);
    expect((await row<{ attempts: number }>('SELECT attempts FROM login_codes'))!.attempts).toBe(LIMITS.codeTries);
    expect(await verifyLoginCode(e, cfg, { email: OWNER, code, ip: '203.0.113.9', at: at(1) })).toEqual({ ok: false, reason: 'wrong' });
    // 4 wrong, then the right one (the 5th try) logs in
    const code2 = await codeFor(e, OWNER, at(2));
    for (let i = 0; i < LIMITS.codeTries - 1; i++) expect((await verifyLoginCode(e, cfg, { email: OWNER, code: wrongOf(code2), ip: '203.0.113.9', at: at(3) })).ok).toBe(false);
    expect((await verifyLoginCode(e, cfg, { email: OWNER, code: code2, ip: '203.0.113.9', at: at(3) })).ok).toBe(true);
    await sql('DELETE FROM admin_sessions').run();
  });

  it('a code expires after 10 minutes', async () => {
    const { e } = testEnv();
    const code = await codeFor(e);
    expect(await verifyLoginCode(e, cfg, { email: OWNER, code, ip: '203.0.113.1', at: addTime(at(10), { minutes: 0 }) })).toEqual({ ok: false, reason: 'wrong' });
    const code2 = await codeFor(e, OWNER, at(1));
    expect((await verifyLoginCode(e, cfg, { email: OWNER, code: code2, ip: '203.0.113.1', at: at(10) })).ok).toBe(true);
    await sql('DELETE FROM admin_sessions').run();
  });

  it('only the newest code works', async () => {
    const { e } = testEnv();
    const first = await codeFor(e);
    const second = await codeFor(e, OWNER, at(1));
    if (first !== second) expect(await verifyLoginCode(e, cfg, { email: OWNER, code: first, ip: '203.0.113.1', at: at(2) })).toEqual({ ok: false, reason: 'wrong' });
    expect((await verifyLoginCode(e, cfg, { email: OWNER, code: second, ip: '203.0.113.1', at: at(2) })).ok).toBe(true);
    await sql('DELETE FROM admin_sessions').run();
  });

  it('a wrong code looks the same for an allowed and an unknown email', async () => {
    const { e } = testEnv();
    const code = await codeFor(e);
    await requestLoginCode(e, cfg, { email: 'stranger@example.test', ip: '203.0.113.1', at: T0 });
    const a = await postLogin(e, { _action: 'verify', code: wrongOf(code) }, { cookie: loginCookieFor(OWNER), at: at(1) });
    const b = await postLogin(e, { _action: 'verify', code: wrongOf(code) }, { cookie: loginCookieFor('stranger@example.test'), at: at(1) });
    const strip = (o: unknown) => ({ ...(o as { view: object }).view, email: null });
    expect(strip(a)).toEqual(strip(b));
    expect(strip(a)).toMatchObject({ step: 'code', status: 422, error: LOGIN_ERRORS.wrong });
  });

  it('through the form: first login goes to the recovery codes, later logins to ?next=; cookies are set and cleared', async () => {
    const { e } = testEnv();
    const code = await codeFor(e, OWNER2);
    const r = await postLogin(e, { _action: 'verify', code, next: '/admin/stock/' }, { cookie: loginCookieFor(OWNER2), at: at(1) });
    const res = (r as { response: Response }).response;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login/recovery/?first=1&next=%2Fadmin%2Fstock%2F');
    const cookies = setCookies(res);
    expect(cookies[0]).toMatch(/^__Host-bz_admin=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    expect(cookies[1]).toBe(clearCookie(LOGIN_COOKIE));
    await createRecoveryCodes(env.DB as never, cfg, { email: OWNER2, role: 'owner' }, at(2));
    const code2 = await codeFor(e, OWNER2, at(3));
    const r2 = await postLogin(e, { _action: 'verify', code: code2, next: '/admin/stock/' }, { cookie: loginCookieFor(OWNER2), at: at(4) });
    expect((r2 as { response: Response }).response.headers.get('location')).toBe('/admin/stock/');
  });

  it('without the email cookie the visitor is sent back to the email step', async () => {
    const { e } = testEnv();
    const r = await postLogin(e, { _action: 'verify', code: '123456' });
    expect((r as { response: Response }).response.headers.get('location')).toBe('/admin/login/?step=email&note=again');
  });
});

describe('limits', () => {
  it('3 codes per email per 15 minutes', async () => {
    const { e, sent } = testEnv();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await requestLoginCode(e, cfg, { email: OWNER, ip: `10.0.0.${i}`, at: at(i) }));
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: false, reason: 'email_limit' }]);
    expect(sent).toHaveLength(3);
    expect(await rows('SELECT id FROM login_codes')).toHaveLength(3);
    // the form says so (and still goes to the code step)
    const r = await postLogin(e, { _action: 'send', email: OWNER }, { ip: '10.0.1.1', at: at(5) });
    expect((r as { response: Response }).response.headers.get('location')).toBe('/admin/login/?step=code&note=limit15');
    // a new 15-minute window allows codes again
    expect(await requestLoginCode(e, cfg, { email: OWNER, ip: '10.0.0.9', at: at(16) })).toEqual({ ok: true });
  });

  it('10 codes per email per IST day', async () => {
    const { e, sent } = testEnv();
    const out = [];
    for (let i = 0; i < 11; i++) out.push(await requestLoginCode(e, cfg, { email: OWNER, ip: `10.1.0.${i}`, at: at(i * 16) }));
    expect(out.slice(0, 10).every((x) => x.ok)).toBe(true);
    expect(out[10]).toEqual({ ok: false, reason: 'day_limit' });
    expect(sent).toHaveLength(10);
    const r = await postLogin(e, { _action: 'resend' }, { cookie: loginCookieFor(OWNER), ip: '10.1.1.1', at: at(11 * 16) });
    expect((r as { response: Response }).response.headers.get('location')).toBe('/admin/login/?step=code&note=limitday');
  });

  it('20 login attempts per IP hash per hour, whatever the step', async () => {
    const { e, sent } = testEnv();
    for (let i = 0; i < 10; i++) await postLogin(e, { _action: 'send', email: `x${i}@example.test` }, { ip: '198.51.100.1', at: at(1) });
    for (let i = 0; i < 10; i++) await postLogin(e, { _action: 'verify', code: '000000' }, { cookie: loginCookieFor(OWNER), ip: '198.51.100.1', at: at(2) });
    const blocked = await postLogin(e, { _action: 'send', email: OWNER }, { ip: '198.51.100.1', at: at(3) });
    expect(blocked).toEqual({ kind: 'view', view: expect.objectContaining({ step: 'email', status: 429, error: LOGIN_ERRORS.ipLimit }) });
    expect(sent).toEqual([]);
    expect(await row('SELECT * FROM login_codes')).toBeNull();
    // the blocked try did not use up the owner's email allowance
    const ownerKey = (await authHash(cfg.secret, 'email', OWNER)).slice(0, 32);
    expect(await row('SELECT * FROM rate_limits WHERE instr(bucket, ?) > 0', ownerKey)).toBeNull();
    // another connection is fine; the next hour is fine
    expect(await requestLoginCode(e, cfg, { email: OWNER, ip: '198.51.100.2', at: at(3) })).toEqual({ ok: true });
    expect(await requestLoginCode(e, cfg, { email: OWNER, ip: '198.51.100.1', at: at(61) })).toEqual({ ok: true });
    // no IP is stored in clear
    expect(JSON.stringify(await rows('SELECT bucket FROM rate_limits'))).not.toContain('198.51.100');
  });

  it('10 recovery-code tries per email per IST day', async () => {
    const { e } = testEnv();
    for (let i = 0; i < 10; i++) {
      expect(await verifyRecoveryCode(e, cfg, { email: OWNER, code: 'AAAAA-AAAAA', ip: `10.2.0.${i}`, at: at(i * 7) })).toEqual({ ok: false, reason: 'wrong' });
    }
    expect(await verifyRecoveryCode(e, cfg, { email: OWNER, code: 'AAAAA-AAAAA', ip: '10.2.1.1', at: at(80) })).toEqual({ ok: false, reason: 'recovery_limit' });
  });
});

describe('recovery codes', () => {
  it('8 one-time codes, stored hashed; each works once; new ones replace the old', async () => {
    const { e } = testEnv();
    const owner = { email: OWNER, role: 'owner' as const };
    const codes = await createRecoveryCodes(env.DB as never, cfg, owner, T0);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    const stored = JSON.stringify(await rows('SELECT * FROM recovery_codes'));
    for (const c of codes) expect(stored).not.toContain(c.replace('-', ''));
    expect(await recoveryStatus(env.DB as never, OWNER)).toEqual({ total: 8, unused: 8, createdAt: T0 });

    const typed = ` ${codes[3].toLowerCase().replace('-', ' ')} `;
    const r = await verifyRecoveryCode(e, cfg, { email: OWNER, code: typed, ip: '10.3.0.1', at: at(1) });
    expect(r).toMatchObject({ ok: true, email: OWNER, role: 'owner', firstLogin: false });
    expect(await verifyRecoveryCode(e, cfg, { email: OWNER, code: codes[3], ip: '10.3.0.1', at: at(2) })).toEqual({ ok: false, reason: 'wrong' });
    expect(await verifyRecoveryCode(e, cfg, { email: OWNER2, code: codes[4], ip: '10.3.0.1', at: at(2) })).toEqual({ ok: false, reason: 'wrong' });
    expect(await recoveryStatus(env.DB as never, OWNER)).toMatchObject({ total: 8, unused: 7 });
    expect(await row("SELECT action FROM audit_log WHERE action = 'auth.login_recovery'")).toBeTruthy();

    const fresh = await createRecoveryCodes(env.DB as never, cfg, owner, at(3));
    expect(fresh.some((c) => codes.includes(c))).toBe(false);
    expect(await verifyRecoveryCode(e, cfg, { email: OWNER, code: codes[5], ip: '10.3.0.1', at: at(4) })).toEqual({ ok: false, reason: 'wrong' });
    expect(await recoveryStatus(env.DB as never, OWNER)).toEqual({ total: 8, unused: 8, createdAt: at(3) });
    expect((await verifyRecoveryCode(e, cfg, { email: OWNER, code: fresh[0], ip: '10.3.0.1', at: at(4) })).ok).toBe(true);
  });

  it('through the form: "I have a recovery code" then the code logs in', async () => {
    const { e, sent } = testEnv();
    const codes = await createRecoveryCodes(env.DB as never, cfg, { email: OWNER2, role: 'owner' }, T0);
    const r = await postLogin(e, { _action: 'recover', recovery: codes[0], next: '/admin/orders/' }, { cookie: loginCookieFor(OWNER2), at: at(1) });
    const res = (r as { response: Response }).response;
    expect(res.headers.get('location')).toBe('/admin/orders/');
    expect(cookieValue(res, SESSION_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const wrong = await postLogin(e, { _action: 'recover', recovery: codes[0] }, { cookie: loginCookieFor(OWNER2), at: at(2) });
    expect(wrong).toEqual({ kind: 'view', view: expect.objectContaining({ step: 'recovery', status: 422, error: LOGIN_ERRORS.wrongRecovery }) });
    expect(sent).toEqual([]);
  });
});

describe('making recovery codes needs a fresh login or an email code (review: security 1)', () => {
  async function sessionAt(e: AuthEnv, email: string, when: string): Promise<string> {
    expect(await requestLoginCode(e, cfg, { email, ip: '10.5.0.1', at: when })).toEqual({ ok: true });
    const r = await verifyLoginCode(e, cfg, { email, code: e2eLastCode(email)!.code, ip: '10.5.0.1', at: when });
    if (!r.ok) throw new Error(r.reason);
    return r.token;
  }

  it('within 10 minutes of the login: made at once, and a notice is emailed', async () => {
    const { e, sent } = testEnv();
    const token = await sessionAt(e, OWNER, T0);
    sent.length = 0;
    const r = await makeRecoveryCodes(e, cfg, { email: OWNER, role: 'owner' }, { token, ip: '10.5.0.1', at: at(10) });
    expect(r).toMatchObject({ ok: true, codes: expect.arrayContaining([expect.stringMatching(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/)]) });
    expect(sent).toEqual([{ from: 'login@beezyhoney.in', to: OWNER }]); // the "new recovery codes were made" notice
    await sql('DELETE FROM admin_sessions').run();
  });

  it('an older session needs a fresh email code; a wrong or missing code makes nothing', async () => {
    const { e, sent } = testEnv();
    const token = await sessionAt(e, OWNER2, T0);
    const before = await createRecoveryCodes(env.DB as never, cfg, { email: OWNER2, role: 'owner' }, T0);
    const actor = { email: OWNER2, role: 'owner' as const };
    sent.length = 0;
    expect(await makeRecoveryCodes(e, cfg, actor, { token, ip: '10.5.0.2', at: at(11) })).toEqual({ ok: false, reason: 'needs_code' });
    expect(await makeRecoveryCodes(e, cfg, actor, { token: null, ip: '10.5.0.2', at: at(11) })).toEqual({ ok: false, reason: 'needs_code' });
    expect(await makeRecoveryCodes(e, cfg, actor, { token, code: '000000', ip: '10.5.0.2', at: at(11) })).toEqual({ ok: false, reason: 'wrong' });
    expect(sent).toEqual([]);
    // the old codes still work: nothing was replaced
    expect((await verifyRecoveryCode(e, cfg, { email: OWNER2, code: before[0], ip: '10.5.0.2', at: at(11) })).ok).toBe(true);
    // "Email me a code", then the code makes new ones (and the code is used up)
    expect(await requestLoginCode(e, cfg, { email: OWNER2, ip: '10.5.0.2', at: at(12), purpose: 'recovery' })).toEqual({ ok: true });
    const code = e2eLastCode(OWNER2)!.code;
    const r = await makeRecoveryCodes(e, cfg, actor, { token, code, ip: '10.5.0.2', at: at(13) });
    expect(r.ok).toBe(true);
    expect(sent.map((m) => m.to)).toEqual([OWNER2, OWNER2]); // the code, then the notice
    expect(await verifyRecoveryCode(e, cfg, { email: OWNER2, code: before[1], ip: '10.5.0.2', at: at(14) })).toEqual({ ok: false, reason: 'wrong' });
    expect(await makeRecoveryCodes(e, cfg, actor, { token, code, ip: '10.5.0.2', at: at(14) })).toEqual({ ok: false, reason: 'wrong' });
    await sql('DELETE FROM admin_sessions').run();
  });
});

describe('the login page (GET)', () => {
  const get = (e: AuthEnv, path: string, cookie?: string) =>
    loginGet(e, new Request(`${ADMIN}${path}`, { headers: cookie ? { cookie } : {} }), new URL(`${ADMIN}${path}`), T0);

  it('shows the email step, the code step only with the email cookie, and only known notes', async () => {
    const { e } = testEnv();
    expect(await get(e, '/admin/login/')).toEqual({ kind: 'view', view: { step: 'email', email: null, next: '/admin/', status: 200, note: null, error: null, typedEmail: '' } });
    expect(await get(e, '/admin/login/?step=code')).toMatchObject({ view: { step: 'email', note: 'again' } });
    expect(await get(e, '/admin/login/?step=code&next=/admin/sales/', loginCookieFor(OWNER))).toMatchObject({ view: { step: 'code', email: OWNER, note: 'sent', next: '/admin/sales/' } });
    expect(await get(e, '/admin/login/?step=recovery&note=evil', loginCookieFor(OWNER))).toMatchObject({ view: { step: 'recovery', note: null } });
    expect(await get(e, '/admin/login/?note=out_all')).toMatchObject({ view: { step: 'email', note: 'out_all' } });
  });
});

describe('the e2e hook', () => {
  it('exists only in e2e mode and only on local hosts', async () => {
    const { e } = testEnv();
    await requestLoginCode(e, cfg, { email: OWNER, ip: '10.4.0.1', at: T0 });
    const ask = (host: string) => e2eGET({ url: new URL(`http://${host}/api/e2e/login-code.json?email=${encodeURIComponent(OWNER)}`) } as never);
    const res = await ask('127.0.0.1:4421');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: OWNER, code: expect.stringMatching(/^\d{6}$/), at: T0 });
    expect((await ask('beezyhoney.in')).status).toBe(404);
    // review security 3: the host name alone is not trusted; the Worker's PUBLIC_HOSTS must list it (as .dev.vars does)
    const vars = env as unknown as Record<string, unknown>;
    const saved = vars.PUBLIC_HOSTS;
    vars.PUBLIC_HOSTS = 'beezyhoney.in,next.beezyhoney.in';
    try {
      expect((await ask('127.0.0.1:4421')).status).toBe(404);
      expect((await ask('localhost:4421')).status).toBe(404);
    } finally {
      vars.PUBLIC_HOSTS = saved;
    }
    vi.stubEnv('MODE', 'production');
    expect(e2eLastCode(OWNER)).toBeNull();
    expect((await ask('127.0.0.1:4421')).status).toBe(404);
    hook().BEEZY_E2E_HOOK = [];
    await requestLoginCode(e, cfg, { email: OWNER, ip: '10.4.0.2', at: at(20) });
    expect(hook().BEEZY_E2E_HOOK).toEqual([]); // nothing is recorded outside e2e builds
  });
});
