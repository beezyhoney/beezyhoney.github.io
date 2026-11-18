// Login aliases (secret ADMIN_ALIASES): the owner types their own-domain address, the code goes to the target in
// ADMIN_EMAILS, and from there the login is exactly the target's (limits, code, session, audit). Only example.test
// addresses here: the real aliases and Gmails live in .dev.vars / the Worker secrets, never in the repository.
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addHelper } from '../../../src/admin/ops/people';
import {
  aliasesFor, authConfig, createRecoveryCodes, e2eLastCode, LIMITS, LOGIN_COOKIE, LOGIN_ERRORS, LOGIN_NOTES, loginGet, loginPost,
  maskEmail, parseAdminAliases, requestLoginCode, resolveLoginEmail, SESSION_COOKIE, sessionUser, verifyRecoveryCode,
  type AuthEnv,
} from '../../../src/server/auth';
import { addTime } from '../../../src/server/time';
import { row, rows, seedDb, sql } from '../api/_seed';

const ADMIN = 'https://admin.beezyhoney.in';
const OWNER = 'owner@example.test'; // in ADMIN_EMAILS (vitest.config.mjs)
const OWNER2 = 'second-owner@example.test';
const ALIAS = 'boss@shop.example.test'; // → OWNER
const HELPER = 'helper@example.test';
const OLD_HELPER = 'old-helper@example.test';
const ALIASES = [
  ` Boss@Shop.example.test = ${OWNER.toUpperCase()} `,
  'stranger-alias@shop.example.test=stranger@example.test', // target may not log in: ignored
  `helper-alias@shop.example.test=${HELPER}`, // active helper: works
  `off-alias@shop.example.test=${OLD_HELPER}`, // switched-off helper: ignored
  'broken-pair', `a@shop.example.test=b@shop.example.test=${OWNER}`, '=nobody@example.test', // malformed
  `${OWNER2}=${OWNER}`, // an owner's own address is never an alias
  `boss@shop.example.test=${OWNER2}`, // repeated alias: the first pair wins
].join(',');
const T0 = '2026-11-15T04:30:00Z';
const at = (minutes: number) => addTime(T0, { minutes });

interface Sent { to: string }
function testEnv(aliases: string = ALIASES): { e: AuthEnv; sent: Sent[] } {
  const sent: Sent[] = [];
  const e: AuthEnv = {
    DB: env.DB as never,
    ADMIN_EMAILS: env.ADMIN_EMAILS,
    ADMIN_ALIASES: aliases,
    LOGIN_SECRET: env.LOGIN_SECRET,
    IP_HASH_KEY: env.IP_HASH_KEY,
    LOGIN_MAIL: { send: async (m: unknown) => { sent.push({ to: (m as Sent).to }); return {}; } },
  };
  return { e, sent };
}
const cfgOf = (e: AuthEnv) => authConfig(e)!;

async function postLogin(e: AuthEnv, fields: Record<string, string>, opts: { cookie?: string; ip?: string; at?: string } = {}) {
  const req = new Request(`${ADMIN}/admin/login/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': opts.ip ?? '203.0.113.1',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: new URLSearchParams(fields),
  });
  return loginPost(e, req, new URL(req.url), { at: opts.at ?? T0 });
}
const response = (r: unknown) => (r as { response: Response }).response;
const loginCookieFor = (email: string) => `${LOGIN_COOKIE}=${encodeURIComponent(email)}`;
const sessionToken = (res: Response) => {
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`${SESSION_COOKIE}=`));
  return c ? c.slice(SESSION_COOKIE.length + 1, c.indexOf(';')) : null;
};
/** What a visitor sees after "Send me a login code": the redirect and its cookies, with the typed email blanked */
const answerOf = (r: unknown, typed: string) => {
  const res = response(r);
  return { status: res.status, location: res.headers.get('location'), cookies: res.headers.getSetCookie().map((c) => c.replace(encodeURIComponent(typed), '<typed>')) };
};

beforeAll(async () => {
  await seedDb();
  await sql(`INSERT INTO admin_users (email, role, active, added_at, added_by, updated_at, updated_by)
    VALUES (?1, 'helper', 1, ?3, ?4, ?3, ?4), (?2, 'helper', 0, ?3, ?4, ?3, ?4)`, HELPER, OLD_HELPER, T0, OWNER).run();
});

beforeEach(async () => {
  vi.stubEnv('MODE', 'e2e'); // lets the tests read the codes they asked for (e2eLastCode)
  (globalThis as { BEEZY_E2E_HOOK?: unknown[] }).BEEZY_E2E_HOOK = [];
  await sql('DELETE FROM rate_limits').run();
  await sql('DELETE FROM login_codes').run();
  await sql('DELETE FROM admin_sessions').run();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('reading ADMIN_ALIASES', () => {
  it('lower-cases and trims; ignores malformed pairs, owner addresses, alias = target and repeats', () => {
    const map = parseAdminAliases(ALIASES, [OWNER, OWNER2]);
    expect([...map]).toEqual([
      [ALIAS, OWNER],
      ['stranger-alias@shop.example.test', 'stranger@example.test'],
      ['helper-alias@shop.example.test', HELPER],
      ['off-alias@shop.example.test', OLD_HELPER],
    ]);
    expect([...parseAdminAliases(`x@shop.example.test=x@shop.example.test; y@shop.example.test=${OWNER}`, [OWNER])]).toEqual([['y@shop.example.test', OWNER]]);
    expect(parseAdminAliases(undefined, [OWNER]).size).toBe(0);
    expect(cfgOf(testEnv().e).aliases.get(ALIAS)).toBe(OWNER);
    // optional: without it the login works as before
    expect(cfgOf(testEnv('').e).aliases.size).toBe(0);
    expect(authConfig({ ADMIN_EMAILS: OWNER, LOGIN_SECRET: env.LOGIN_SECRET, IP_HASH_KEY: 'k' })!.aliases.size).toBe(0);
  });

  it('resolves only to a target that may log in (owner, or active helper)', async () => {
    const { e } = testEnv();
    const cfg = cfgOf(e);
    expect(await resolveLoginEmail(e.DB, cfg, ALIAS)).toBe(OWNER);
    expect(await resolveLoginEmail(e.DB, cfg, 'helper-alias@shop.example.test')).toBe(HELPER);
    expect(await resolveLoginEmail(e.DB, cfg, 'stranger-alias@shop.example.test')).toBe('stranger-alias@shop.example.test');
    expect(await resolveLoginEmail(e.DB, cfg, 'off-alias@shop.example.test')).toBe('off-alias@shop.example.test');
    expect(await resolveLoginEmail(e.DB, cfg, OWNER)).toBe(OWNER); // the Gmail itself keeps working
    expect(await resolveLoginEmail(e.DB, cfg, OWNER2)).toBe(OWNER2);
  });
});

describe('logging in with an alias', () => {
  it('the code is sent to the target; the page keeps the alias; the session, role and audit are the target', async () => {
    const { e, sent } = testEnv();
    const r = await postLogin(e, { _action: 'send', email: ' Boss@Shop.example.test ', next: '/admin/orders/' });
    const res = response(r);
    expect(res.headers.get('location')).toBe('/admin/login/?step=code&note=sent&next=%2Fadmin%2Forders%2F');
    expect(res.headers.getSetCookie()[0]).toMatch(new RegExp(`^${LOGIN_COOKIE}=${encodeURIComponent(ALIAS)};`));
    expect(sent).toEqual([{ to: OWNER }]);
    expect(await rows('SELECT email FROM login_codes')).toEqual([{ email: OWNER }]);

    // the code step shows the alias, never the target, and the note says nothing about the address
    const page = await loginGet(e, new Request(`${ADMIN}/admin/login/?step=code`, { headers: { cookie: loginCookieFor(ALIAS) } }), new URL(`${ADMIN}/admin/login/?step=code`), T0);
    expect(page).toMatchObject({ kind: 'view', view: { step: 'code', email: ALIAS, note: 'sent' } });
    expect(JSON.stringify(page)).not.toContain(OWNER);
    expect(LOGIN_NOTES.sent).not.toContain('@');

    const code = e2eLastCode(OWNER)!.code;
    const done = response(await postLogin(e, { _action: 'verify', code, next: '/admin/orders/' }, { cookie: loginCookieFor(ALIAS), at: at(1) }));
    expect(done.status).toBe(303);
    const token = sessionToken(done)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sessionUser(e.DB, cfgOf(e), token, at(2))).toEqual({ email: OWNER, role: 'owner' });
    expect(await row('SELECT email FROM admin_sessions')).toEqual({ email: OWNER });
    expect(await row("SELECT actor, entity_id FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC LIMIT 1")).toEqual({ actor: OWNER, entity_id: OWNER });
    // removing the target from ADMIN_EMAILS still ends the session at once (and the alias stops working)
    const without = authConfig({ ...e, ADMIN_EMAILS: OWNER2 })!;
    expect(await sessionUser(e.DB, without, token, at(3))).toBeNull();
    expect(await resolveLoginEmail(e.DB, without, ALIAS)).toBe(ALIAS);
  });

  it('a code asked for with the Gmail also works from the alias (one identity)', async () => {
    const { e } = testEnv();
    await requestLoginCode(e, cfgOf(e), { email: OWNER, ip: '203.0.113.5', at: T0 });
    const code = e2eLastCode(OWNER)!.code;
    const done = response(await postLogin(e, { _action: 'verify', code }, { cookie: loginCookieFor(ALIAS), at: at(1) }));
    expect(sessionToken(done)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('a recovery code works with the alias (and its tries count for the target)', async () => {
    const { e } = testEnv();
    const codes = await createRecoveryCodes(e.DB, cfgOf(e), { email: OWNER, role: 'owner' }, T0);
    const use = response(await postLogin(e, { _action: 'use_recovery', email: ALIAS }));
    expect(use.headers.get('location')).toBe('/admin/login/?step=recovery');
    const done = response(await postLogin(e, { _action: 'recover', recovery: codes[0] }, { cookie: loginCookieFor(ALIAS), at: at(1) }));
    expect(await sessionUser(e.DB, cfgOf(e), sessionToken(done)!, at(2))).toEqual({ email: OWNER, role: 'owner' });
    // 9 more wrong tries through the alias + 1 through the Gmail reach the daily recovery limit of the one identity
    for (let i = 0; i < LIMITS.recoveryTriesPerDay - 1; i++) {
      await postLogin(e, { _action: 'recover', recovery: 'AAAAA-AAAAA' }, { cookie: loginCookieFor(ALIAS), ip: `10.9.0.${i}`, at: at(2) });
    }
    expect(await verifyRecoveryCode(e, cfgOf(e), { email: OWNER, code: codes[1], ip: '10.9.1.1', at: at(3) })).toEqual({ ok: false, reason: 'recovery_limit' });
  });

  it('an active helper can have an alias too; the session is the helper', async () => {
    const { e, sent } = testEnv();
    await postLogin(e, { _action: 'send', email: 'helper-alias@shop.example.test' });
    expect(sent).toEqual([{ to: HELPER }]);
    const done = response(await postLogin(e, { _action: 'verify', code: e2eLastCode(HELPER)!.code }, { cookie: loginCookieFor('helper-alias@shop.example.test'), at: at(1) }));
    expect(await sessionUser(e.DB, cfgOf(e), sessionToken(done)!, at(2))).toEqual({ email: HELPER, role: 'helper' });
  });
});

describe('unknown and ignored aliases', () => {
  it('an unknown alias is refused like any unknown email, and no mail goes out', async () => {
    const { e, sent } = testEnv();
    const known = await postLogin(e, { _action: 'send', email: ALIAS });
    expect(response(known).headers.get('location')).toBe('/admin/login/?step=code&note=sent');
    const unknown = await postLogin(e, { _action: 'send', email: 'ghost@shop.example.test' }, { ip: '203.0.113.2' });
    expect(unknown).toEqual({ kind: 'view', view: expect.objectContaining({ step: 'email', status: 403, error: LOGIN_ERRORS.noAccess, typedEmail: 'ghost@shop.example.test' }) });
    expect(sent).toEqual([{ to: OWNER }]);
    expect(await rows('SELECT email FROM login_codes')).toEqual([{ email: OWNER }]);
  });

  it('an alias whose target may not log in is ignored: refused, no mail, no code, no login', async () => {
    const { e, sent } = testEnv();
    await postLogin(e, { _action: 'send', email: ALIAS });
    sent.length = 0;
    await sql('DELETE FROM login_codes').run();
    for (const [i, alias] of ['stranger-alias@shop.example.test', 'off-alias@shop.example.test'].entries()) {
      const r = await postLogin(e, { _action: 'send', email: alias }, { ip: `203.0.113.${10 + i}` });
      expect(r).toEqual({ kind: 'view', view: expect.objectContaining({ step: 'email', status: 403, error: LOGIN_ERRORS.noAccess }) });
      const wrong = await postLogin(e, { _action: 'verify', code: '123456' }, { cookie: loginCookieFor(alias), ip: `203.0.113.${10 + i}`, at: at(1) });
      expect(wrong).toMatchObject({ kind: 'view', view: { step: 'code', status: 422, email: alias } });
    }
    expect(sent).toEqual([]);
    expect(await row('SELECT * FROM login_codes')).toBeNull();
    expect(await row('SELECT * FROM admin_sessions')).toBeNull();
  });
});

describe('limits are shared between the alias and the Gmail', () => {
  it('3 codes per 15 minutes for the one identity, whichever address was typed', async () => {
    const { e, sent } = testEnv();
    const send = (email: string, i: number) => postLogin(e, { _action: 'send', email }, { ip: `10.8.0.${i}`, at: at(i) });
    expect(response(await send(ALIAS, 0)).headers.get('location')).toBe('/admin/login/?step=code&note=sent');
    expect(response(await send(OWNER, 1)).headers.get('location')).toBe('/admin/login/?step=code&note=sent');
    expect(response(await send(ALIAS, 2)).headers.get('location')).toBe('/admin/login/?step=code&note=sent');
    expect(response(await send(OWNER, 3)).headers.get('location')).toBe('/admin/login/?step=code&note=limit15');
    // "Send a new code" from the alias page counts on the same bucket
    const resend = await postLogin(e, { _action: 'resend' }, { cookie: loginCookieFor(ALIAS), ip: '10.8.1.1', at: at(4) });
    expect(response(resend).headers.get('location')).toBe('/admin/login/?step=code&note=limit15');
    expect(sent).toEqual([{ to: OWNER }, { to: OWNER }, { to: OWNER }]);
    // one email bucket only: the alias has none of its own
    expect((await rows<{ bucket: string }>("SELECT bucket FROM rate_limits WHERE bucket LIKE 'login-m15:%'")).length).toBe(1);
  });
});

describe('People: owners shown by their alias', () => {
  it('masks the Gmail behind an alias', () => {
    expect(maskEmail('name@gmail.com')).toBe('n•••••e@gmail.com');
    expect(maskEmail('someone.long@gmail.com')).toBe('s•••••g@gmail.com');
    expect(maskEmail('ab@example.test')).toBe('a•••••@example.test');
    expect(maskEmail('x@example.test')).toBe('x•••••@example.test');
    expect(maskEmail('no-at-sign')).toBe('•••••');
    // the masked form never contains the whole local part
    expect(maskEmail(OWNER)).toBe('o•••••r@example.test');
    expect(maskEmail(OWNER)).not.toContain('owner');
  });

  it('finds the aliases of each owner; an owner without one is shown as is', () => {
    const map = parseAdminAliases(ALIASES, [OWNER, OWNER2]);
    expect(aliasesFor(map, OWNER)).toEqual([ALIAS]);
    expect(aliasesFor(map, OWNER2)).toEqual([]);
  });

  it('an alias address cannot be added as a helper (the page passes owners and aliases)', async () => {
    const owners = [OWNER, OWNER2];
    const r = await addHelper(env.DB as never, { email: OWNER, role: 'owner' }, { email: ALIAS.toUpperCase(), owners: [...owners, ...parseAdminAliases(ALIASES, owners).keys()] }, T0);
    expect(r).toMatchObject({ ok: false, error: 'invalid', field: 'email' });
  });
});
