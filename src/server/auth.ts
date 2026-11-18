/**
 * Admin login (amendment A1): our own email-code login, sessions in D1, one-time recovery codes.
 *
 * Who may log in: the emails in the secret ADMIN_EMAILS (role owner) and active helpers in `admin_users`
 * (role helper). The addresses never appear in the repository.
 *
 * Login aliases (optional secret ADMIN_ALIASES, "alias=target" pairs, comma-separated): the owners type their
 * @beezyhoney.in address, which Cloudflare Email Routing forwards to their Gmail. send_email can only deliver to the
 * verified Gmail, so an alias is resolved to its target (resolveLoginEmail) at every login step and everything after
 * that (limits, code, mail, session, audit) uses the target, exactly as if the target had been typed. The login
 * cookie and the page keep what was typed, so the Gmail is never shown. A pair counts only while its target may log
 * in (in ADMIN_EMAILS, or an active helper); otherwise the alias is just an unknown email.
 *
 * Flow (/admin/login/):
 *  1. Email step: the visitor types an email. If it may log in (and the limits allow), a 6-digit code (Web Crypto,
 *     no modulo bias) is stored HMAC-hashed in `login_codes` and emailed through LOGIN_MAIL (src/server/mail.ts).
 *     An email that may not log in is told so on the spot ("This email does not have access to the admin"), no code
 *     is made and the visitor does not reach the code step (owner decision 18 Nov 2026: a clear message is worth more
 *     here than hiding which emails are admins; the per-IP limit still caps how many emails one connection can try).
 *  2. Code step: the newest unused code of that email, valid 10 minutes, single use, at most 5 tries (each try is
 *     counted in one atomic UPDATE … RETURNING before the code is compared, so parallel guesses cannot pass the limit).
 *     Or a recovery code instead (8 one-time codes, shown once at first login, made again from the recovery page).
 *     Making recovery codes needs a session younger than 10 minutes or a fresh email code, and emails a notice.
 *     "Log out on all devices" also cancels unused login codes (recovery codes stay; the page says so).
 *  3. Session: 32 random bytes in cookie __Host-bz_admin (HttpOnly, Secure, SameSite=Strict, Path=/), 7 days
 *     absolute, stored HMAC-hashed in `admin_sessions`. Every admin request re-reads the session row AND checks that
 *     the email is still allowed, so removing it from ADMIN_EMAILS (or switching a helper off) logs it out at once.
 *  Limits: 3 codes per email per 15 minutes and 10 per IST day; 20 login attempts (any login POST) per IP hash per
 *  hour; 10 recovery-code tries per email per IST day. Counters live in `rate_limits`; email buckets use an HMAC
 *  of the email, never the address.
 *  Hashes: HMAC-SHA256 keyed with LOGIN_SECRET over '<purpose>\0<value>'; code hashes are compared in constant time.
 *  Fail closed: without ADMIN_EMAILS or a LOGIN_SECRET of at least 32 characters, every admin route answers 503; outside
 *  local development also without IP_HASH_KEY (the per-IP limits need it).
 *
 * Local development: inside `if (import.meta.env.DEV)` only (compiled out of every build), on localhost/127.0.0.1
 * only, the dev admin email from .dev.vars is signed in as owner without a login. Leave that variable empty to try
 * the real login in `astro dev`; the send_email simulation writes the message to a local .eml file.
 * e2e builds (`astro build --mode e2e`) keep the last codes in a global for the browser tests (see e2eLastCode);
 * production builds do not contain it (scripts/check-dist.mjs and scripts/predeploy-check.mjs grep dist/server).
 * Keep those two variable names out of comments in this file: the bundler keeps doc comments and the checks grep.
 *
 * src/middleware.ts calls requireAdmin() for every admin route except ADMIN_OPEN_PATHS (login, logout).
 * The login, logout and recovery-code pages (src/pages/admin/login/**, src/pages/admin/logout/**) call loginGet(),
 * loginPost(), logoutPost(), createRecoveryCodes() and recoveryStatus().
 */
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { type D1, auditInsert, batch, first, stmt } from './db';
import { isMailAddress, sendLoginCodeEmail, sendNoticeEmail, type CodePurpose, type MailBinding } from './mail';
import { hitStmt, ipHash, windowBucket } from './ratelimit';
import { addTime, istDate, istTime, nowIso, shortDate } from './time';

export type AdminRole = 'owner' | 'helper';

export interface AdminUser {
  email: string;
  role: AdminRole;
}

/**
 * Admin paths that must work without a session (the login form and logout). The middleware still applies host
 * routing, the unsafe-method origin check and the admin response headers to them; it only skips requireAdmin().
 * Paths are compared after Astro's trailing-slash handling, so they end with '/'.
 */
export const ADMIN_OPEN_PATHS: readonly string[] = ['/admin/login/', '/admin/logout/'];

export function isOpenAdminPath(pathname: string): boolean {
  return ADMIN_OPEN_PATHS.includes(pathname);
}

/** Hosts on which the local dev bypass may apply. */
export const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1'];

export const SESSION_COOKIE = '__Host-bz_admin';
/** Remembers the typed email between the email step and the code step (15 minutes). */
export const LOGIN_COOKIE = '__Host-bz_login';

export const LIMITS = Object.freeze({
  codeMinutes: 10,
  codeTries: 5,
  codesPer15Min: 3,
  codesPerDay: 10,
  attemptsPerIpHour: 20,
  recoveryTriesPerDay: 10,
  sessionDays: 7,
  recoveryCodes: 8,
  lastSeenMinutes: 5,
  loginCookieMinutes: 15,
  /** making recovery codes without a fresh email code needs a session at most this old */
  freshSessionMinutes: 10,
});

/** What this module needs from the Worker env. */
export interface AuthEnv {
  DB: D1;
  LOGIN_MAIL?: MailBinding;
  ADMIN_EMAILS?: string;
  /** optional: "alias=target" pairs, comma-separated (see parseAdminAliases) */
  ADMIN_ALIASES?: string;
  LOGIN_SECRET?: string;
  IP_HASH_KEY?: string;
}

export interface AuthConfig {
  adminEmails: readonly string[];
  /** alias → target (lower-case). Owner targets are checked here; helper targets when used (resolveLoginEmail). */
  aliases: ReadonlyMap<string, string>;
  secret: string;
}

// ───────────────────────────── config, emails, hashing ─────────────────────────────

/** Lower-case, trimmed email if it looks like a real address, else null. */
export function normaliseEmail(value: unknown): string | null {
  const s = String(value ?? '').trim().toLowerCase();
  return s.length <= 254 && isMailAddress(s) ? s : null;
}

/**
 * The login configuration, or null (fail closed: admin answers 503) when ADMIN_EMAILS or LOGIN_SECRET is missing, and
 * outside local development (`astro dev`) also when IP_HASH_KEY is missing: without it every visitor would share one
 * per-IP login bucket and the IP hashes could be recomputed.
 */
export function authConfig(vars: { ADMIN_EMAILS?: unknown; ADMIN_ALIASES?: unknown; LOGIN_SECRET?: unknown; IP_HASH_KEY?: unknown }): AuthConfig | null {
  const emails = String(vars.ADMIN_EMAILS ?? '')
    .split(/[\s,;]+/)
    .map(normaliseEmail)
    .filter((e): e is string => e !== null);
  const secret = String(vars.LOGIN_SECRET ?? '').trim();
  if (!emails.length || secret.length < 32) return null;
  if (!import.meta.env.DEV && !String(vars.IP_HASH_KEY ?? '').trim()) return null;
  const adminEmails = Object.freeze([...new Set(emails)]);
  return { adminEmails, aliases: parseAdminAliases(vars.ADMIN_ALIASES, adminEmails), secret };
}

/**
 * The ADMIN_ALIASES secret → Map alias → target. Pairs are "alias=target", separated by commas (or semicolons /
 * new lines); both sides are trimmed and lower-cased. Ignored: a malformed pair, an alias equal to its target, an
 * alias that is itself in ADMIN_EMAILS (an owner's own address always logs in as itself), and a second pair for the
 * same alias (the first wins). Targets outside ADMIN_EMAILS are kept here because they may be active helpers;
 * resolveLoginEmail() checks them when they are used.
 */
export function parseAdminAliases(raw: unknown, adminEmails: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const part of String(raw ?? '').split(/[,;\r\n]+/)) {
    const sides = part.split('=');
    if (sides.length !== 2) continue;
    const alias = normaliseEmail(sides[0]);
    const target = normaliseEmail(sides[1]);
    if (!alias || !target || alias === target || adminEmails.includes(alias) || aliases.has(alias)) continue;
    aliases.set(alias, target);
  }
  return aliases;
}

/** The aliases that lead to this target (People page), in the order of the secret. */
export function aliasesFor(aliases: ReadonlyMap<string, string>, target: string): string[] {
  return [...aliases].filter(([, t]) => t === target).map(([a]) => a);
}

/**
 * A Gmail shown without giving it away: first and last letter of the local part, five dots, the domain
 * ('name@gmail.com' → 'n•••••e@gmail.com'). Short local parts keep only the first letter.
 */
export function maskEmail(email: string): string {
  const i = email.lastIndexOf('@');
  if (i < 1) return '•••••';
  const local = email.slice(0, i);
  return `${local[0]}•••••${local.length > 2 ? local[local.length - 1] : ''}${email.slice(i)}`;
}

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, k);
  }
  return k;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256(LOGIN_SECRET, '<purpose>\0<value>') as 64 hex characters. */
export async function authHash(secret: string, purpose: 'code' | 'session' | 'recovery' | 'email', value: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${purpose}\u0000${value}`));
  return toHex(new Uint8Array(sig));
}

/** Constant-time comparison of two strings (length is not secret here: both are 64-hex hashes). */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** A 6-digit code, uniform over 000000–999999 (values ≥ 4,294,000,000 are drawn again, so no modulo bias). */
export function newLoginCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000; // 4,294,000,000
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
}

/** 32 random bytes, base64url (43 characters): the session cookie value. */
export function newSessionToken(): string {
  let s = '';
  for (const b of randomBytes(32)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 letters and digits without look-alikes (no 0, O, 1, I): 256 is a multiple of 32, so b & 31 has no bias. */
export const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** One recovery code, 'XXXXX-XXXXX' (50 random bits). */
export function newRecoveryCode(): string {
  const chars = Array.from(randomBytes(10), (b) => RECOVERY_ALPHABET[b & 31]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** What the owner typed → the 10 code characters, or null. Spaces, dashes and case do not matter. */
export function normaliseRecoveryCode(input: unknown): string | null {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return s.length === 10 && [...s].every((c) => RECOVERY_ALPHABET.includes(c)) ? s : null;
}

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ───────────────────────────── cookies ─────────────────────────────

const COOKIE_FLAGS = 'Path=/; HttpOnly; Secure; SameSite=Strict';

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${LIMITS.sessionDays * 86400}; ${COOKIE_FLAGS}`;
}

export function loginCookie(email: string): string {
  return `${LOGIN_COOKIE}=${encodeURIComponent(email)}; Max-Age=${LIMITS.loginCookieMinutes * 60}; ${COOKIE_FLAGS}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; ${COOKIE_FLAGS}`;
}

/** One cookie value from the request, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function loginCookieEmail(request: Request): string | null {
  const raw = readCookie(request, LOGIN_COOKIE);
  if (!raw) return null;
  try {
    return normaliseEmail(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/** A same-site admin path to go to after login ('/admin/orders/12/?x=1'), never login or logout; default '/admin/'. */
export function safeNext(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s.startsWith('/admin/') || s.startsWith('//') || s.includes('\\') || s.length > 300 || /[\u0000-\u001f\u007f]/.test(s)) return '/admin/';
  let u: URL;
  try {
    u = new URL(s, 'https://admin.invalid');
  } catch {
    return '/admin/';
  }
  if (u.origin !== 'https://admin.invalid' || !u.pathname.startsWith('/admin/')) return '/admin/';
  // never back to the login or logout pages (the recovery-codes page under /admin/login/ is a normal admin page)
  if (u.pathname.startsWith('/admin/logout/') || (u.pathname.startsWith('/admin/login/') && u.pathname !== '/admin/login/recovery/')) return '/admin/';
  return u.pathname + u.search;
}

/** '/admin/login/' plus ?next= when it is not the Today page. */
export function loginUrl(next?: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  const n = safeNext(next);
  if (n !== '/admin/') params.set('next', n);
  const q = params.toString();
  return `/admin/login/${q ? `?${q}` : ''}`;
}

// ───────────────────────────── who may log in ─────────────────────────────

/** owner (ADMIN_EMAILS), helper (active admin_users row) or null. */
export async function roleFor(db: D1, cfg: AuthConfig, email: string): Promise<AdminRole | null> {
  if (cfg.adminEmails.includes(email)) return 'owner';
  const h = await first<{ active: number }>(db, 'SELECT active FROM admin_users WHERE email = ?', email);
  return h?.active === 1 ? 'helper' : null;
}

/**
 * The email a login really uses: the target when `email` is an alias whose target may log in (ADMIN_EMAILS, or an
 * active helper), else `email` itself. Owner targets need no database read; only an alias with a helper target
 * costs one (aliases are set by the owners, so this says nothing about other emails).
 */
export async function resolveLoginEmail(db: D1, cfg: AuthConfig, email: string): Promise<string> {
  const target = cfg.aliases.get(email);
  if (!target) return email;
  if (cfg.adminEmails.includes(target)) return target;
  return (await roleFor(db, cfg, target)) ? target : email;
}

async function ipBucket(e: AuthEnv, ip: string | null, at: string): Promise<string> {
  const hash = await ipHash(e.IP_HASH_KEY ?? '', ip || 'unknown', at);
  return windowBucket(`login-ip:${hash}`, 60, at).bucket;
}

const emailKey = async (cfg: AuthConfig, email: string) => (await authHash(cfg.secret, 'email', email)).slice(0, 32);
const dayKey = (at: string) => istDate(at).replace(/-/g, '');

type E2eEntry = { email: string; code: string; at: string };

// ───────────────────────────── step 1: ask for a code ─────────────────────────────

export type RequestCodeResult =
  | { ok: true }
  | { ok: false; reason: 'ip_limit' | 'email_limit' | 'day_limit' };

/**
 * Counts a login attempt for this IP and, with `sendCode`, makes and emails a code when the email may log in and no
 * limit is reached. The work done is the same for every email (one D1 batch), so timing does not tell which emails
 * work; the email itself is sent in `waitUntil`. Without `sendCode` (the visitor chose "Use a recovery code") only
 * the IP attempt is counted.
 */
export async function requestLoginCode(
  e: AuthEnv,
  cfg: AuthConfig,
  input: { email: string; ip: string | null; sendCode?: boolean; at?: string; waitUntil?: (p: Promise<unknown>) => void; purpose?: CodePurpose },
): Promise<RequestCodeResult> {
  const at = input.at ?? nowIso();
  const email = input.email;
  const sendCode = input.sendCode !== false;
  const ipb = await ipBucket(e, input.ip, at);
  const ek = await emailKey(cfg, email);
  const m15 = windowBucket(`login-m15:${ek}`, 15, at).bucket;
  const mday = `login-mday:${ek}:${dayKey(at)}`;
  const code = newLoginCode();
  const codeHash = await authHash(cfg.secret, 'code', `${email}|${code}`);
  const ipHashValue = ipb.split(':')[1] ?? null;
  const envOwner = cfg.adminEmails.includes(email) ? 1 : 0;
  const db = e.DB;

  const ipOk = `(SELECT count FROM rate_limits WHERE bucket = ?3) <= ?4`;
  const bucketHit = (bucket: string) => stmt(db, `INSERT INTO rate_limits (bucket, count, expires_at) SELECT ?1, 1, ?2 WHERE ${ipOk}
    ON CONFLICT(bucket) DO UPDATE SET count = count + 1, expires_at = max(expires_at, excluded.expires_at)`,
  bucket, addTime(at, { days: 2 }), ipb, LIMITS.attemptsPerIpHour);
  // every condition for a new code, with ?1 = email
  const allowed = `(?2 = 1 OR EXISTS (SELECT 1 FROM admin_users WHERE email = ?1 AND active = 1))
    AND (SELECT count FROM rate_limits WHERE bucket = ?3) <= ?4
    AND (SELECT count FROM rate_limits WHERE bucket = ?5) <= ?6
    AND (SELECT count FROM rate_limits WHERE bucket = ?7) <= ?8`;
  const allowedParams = [email, sendCode ? envOwner : 0, ipb, LIMITS.attemptsPerIpHour, m15, LIMITS.codesPer15Min, mday, LIMITS.codesPerDay];

  const statements = [hitStmt(db, ipb, addTime(at, { hours: 2 }))];
  if (sendCode) {
    statements.push(
      bucketHit(m15),
      bucketHit(mday),
      // a new code makes the older unused ones useless (only the newest code works)
      stmt(db, `UPDATE login_codes SET expires_at = ?9 WHERE email = ?1 AND used_at IS NULL AND expires_at > ?9 AND ${allowed}`,
        ...allowedParams, at),
      stmt(db, `INSERT INTO login_codes (email, code_hash, expires_at, attempts, used_at, created_at, ip_hash)
        SELECT ?1, ?9, ?10, 0, NULL, ?11, ?12 WHERE ${allowed}`,
      ...allowedParams, codeHash, addTime(at, { minutes: LIMITS.codeMinutes }), at, ipHashValue),
    );
  }
  statements.push(stmt(db, `SELECT (SELECT count FROM rate_limits WHERE bucket = ?1) AS ip,
      (SELECT count FROM rate_limits WHERE bucket = ?2) AS m15, (SELECT count FROM rate_limits WHERE bucket = ?3) AS day`, ipb, m15, mday));
  const res = await batch(db, statements);
  const counts = res[res.length - 1].results[0] as { ip: number | null; m15: number | null; day: number | null };
  const inserted = sendCode && res[4].meta.changes === 1;

  if (inserted) {
    if (import.meta.env.MODE === 'e2e') {
      // e2e builds only (compiled out of production): lets the browser tests read the code they asked for
      const g = globalThis as { BEEZY_E2E_HOOK?: E2eEntry[] };
      const list = (g.BEEZY_E2E_HOOK ??= []);
      list.push({ email, code, at });
      if (list.length > 20) list.shift();
    }
    const sending = sendLoginCodeEmail(e.LOGIN_MAIL, email, code, { minutes: LIMITS.codeMinutes, purpose: input.purpose ?? 'login' });
    if (input.waitUntil) input.waitUntil(sending);
    else await sending;
  }

  if ((counts.ip ?? 0) > LIMITS.attemptsPerIpHour) return { ok: false, reason: 'ip_limit' };
  if (sendCode && (counts.day ?? 0) > LIMITS.codesPerDay) return { ok: false, reason: 'day_limit' };
  if (sendCode && (counts.m15 ?? 0) > LIMITS.codesPer15Min) return { ok: false, reason: 'email_limit' };
  return { ok: true };
}

// ───────────────────────────── step 2: code or recovery code → session ─────────────────────────────

export type VerifyResult =
  | { ok: true; email: string; role: AdminRole; token: string; firstLogin: boolean }
  | { ok: false; reason: 'ip_limit' | 'recovery_limit' | 'wrong' };

async function startSession(
  db: D1,
  cfg: AuthConfig,
  user: AdminUser,
  how: 'code' | 'recovery',
  userAgent: string | null,
  at: string,
): Promise<{ token: string; firstLogin: boolean }> {
  const token = newSessionToken();
  const tokenHash = await authHash(cfg.secret, 'session', token);
  const res = await batch(db, [
    stmt(db, `INSERT INTO admin_sessions (token_hash, email, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash, user.email, at, addTime(at, { days: LIMITS.sessionDays }), at, userAgent ? userAgent.slice(0, 300) : null),
    auditInsert(db, {
      at, actor: user, action: how === 'code' ? 'auth.login' : 'auth.login_recovery', entity: 'admin', entityId: user.email,
      summary: how === 'code' ? 'Logged in with an email code' : 'Logged in with a recovery code',
    }),
    stmt(db, 'SELECT count(*) AS n FROM recovery_codes WHERE email = ?', user.email),
  ]);
  return { token, firstLogin: (res[2].results[0] as { n: number }).n === 0 };
}

/**
 * Uses up one try of the newest live email code of `email` and, when the typed code matches, the code itself.
 * The try is counted first, in one atomic UPDATE … RETURNING (attempts < 5, not used, not expired, IP under its
 * limit), and the code is compared only when that UPDATE returned the row, so parallel requests can never make more
 * than 5 comparisons per code. Then used_at is stamped (single use). Every failure is 'wrong' (or 'ip_limit').
 */
export async function consumeEmailCode(
  e: AuthEnv,
  cfg: AuthConfig,
  input: { email: string; code: unknown; ip: string | null; at?: string },
): Promise<{ ok: true } | { ok: false; reason: 'ip_limit' | 'wrong' }> {
  const at = input.at ?? nowIso();
  const db = e.DB;
  const ipb = await ipBucket(e, input.ip, at);
  const [hit, claimed] = await batch(db, [
    hitStmt(db, ipb, addTime(at, { hours: 2 })),
    stmt(db, `UPDATE login_codes SET attempts = attempts + 1
      WHERE id = (SELECT id FROM login_codes WHERE email = ?1 AND used_at IS NULL AND expires_at > ?2 AND attempts < ?3 ORDER BY id DESC LIMIT 1)
        AND used_at IS NULL AND expires_at > ?2 AND attempts < ?3 AND (SELECT count FROM rate_limits WHERE bucket = ?4) <= ?5
      RETURNING id, code_hash`, input.email, at, LIMITS.codeTries, ipb, LIMITS.attemptsPerIpHour),
  ]);
  if (((hit.results[0] as { count: number } | undefined)?.count ?? 0) > LIMITS.attemptsPerIpHour) return { ok: false, reason: 'ip_limit' };
  const row = claimed.results[0] as { id: number; code_hash: string } | undefined;
  const code = String(input.code ?? '').replace(/\s+/g, '');
  const wellFormed = /^\d{6}$/.test(code);
  // the same work whether or not this email has a code (no timing hint about which emails may log in)
  const hash = await authHash(cfg.secret, 'code', `${input.email}|${wellFormed ? code : '-'}`);
  if (!row || !wellFormed || !safeEqual(hash, row.code_hash)) return { ok: false, reason: 'wrong' };
  // single use: only one request can stamp used_at (this try is already counted, so attempts may now be 5)
  const used = await stmt(db, 'UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND attempts <= ? AND expires_at > ?',
    at, row.id, LIMITS.codeTries, at).run();
  return used.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'wrong' };
}

/** Checks the email code. Every outcome except success looks the same to the visitor ('wrong'). */
export async function verifyLoginCode(
  e: AuthEnv,
  cfg: AuthConfig,
  input: { email: string; code: unknown; ip: string | null; userAgent?: string | null; at?: string },
): Promise<VerifyResult> {
  const at = input.at ?? nowIso();
  const db = e.DB;
  const checked = await consumeEmailCode(e, cfg, { email: input.email, code: input.code, ip: input.ip, at });
  if (!checked.ok) return checked;
  const role = await roleFor(db, cfg, input.email);
  if (!role) return { ok: false, reason: 'wrong' };
  const s = await startSession(db, cfg, { email: input.email, role }, 'code', input.userAgent ?? null, at);
  return { ok: true, email: input.email, role, ...s };
}

/** Checks a recovery code (each works once). Limited per IP (as every login attempt) and per email per IST day. */
export async function verifyRecoveryCode(
  e: AuthEnv,
  cfg: AuthConfig,
  input: { email: string; code: unknown; ip: string | null; userAgent?: string | null; at?: string },
): Promise<VerifyResult> {
  const at = input.at ?? nowIso();
  const db = e.DB;
  const ipb = await ipBucket(e, input.ip, at);
  const rb = `login-rec:${await emailKey(cfg, input.email)}:${dayKey(at)}`;
  const res = await batch(db, [
    hitStmt(db, ipb, addTime(at, { hours: 2 })),
    stmt(db, `INSERT INTO rate_limits (bucket, count, expires_at) SELECT ?1, 1, ?2 WHERE (SELECT count FROM rate_limits WHERE bucket = ?3) <= ?4
      ON CONFLICT(bucket) DO UPDATE SET count = count + 1, expires_at = max(expires_at, excluded.expires_at)`,
    rb, addTime(at, { days: 2 }), ipb, LIMITS.attemptsPerIpHour),
    stmt(db, 'SELECT (SELECT count FROM rate_limits WHERE bucket = ?1) AS ip, (SELECT count FROM rate_limits WHERE bucket = ?2) AS rec', ipb, rb),
  ]);
  const counts = res[2].results[0] as { ip: number | null; rec: number | null };
  if ((counts.ip ?? 0) > LIMITS.attemptsPerIpHour) return { ok: false, reason: 'ip_limit' };
  if ((counts.rec ?? 0) > LIMITS.recoveryTriesPerDay) return { ok: false, reason: 'recovery_limit' };
  const code = normaliseRecoveryCode(input.code);
  if (!code) return { ok: false, reason: 'wrong' };
  // the hash is unguessable without LOGIN_SECRET, so looking it up by value leaks nothing
  const hash = await authHash(cfg.secret, 'recovery', `${input.email}|${code}`);
  const used = await stmt(db, 'UPDATE recovery_codes SET used_at = ? WHERE email = ? AND code_hash = ? AND used_at IS NULL', at, input.email, hash).run();
  if (used.meta.changes !== 1) return { ok: false, reason: 'wrong' };
  const role = await roleFor(db, cfg, input.email);
  if (!role) return { ok: false, reason: 'wrong' };
  const s = await startSession(db, cfg, { email: input.email, role }, 'recovery', input.userAgent ?? null, at);
  return { ok: true, email: input.email, role, ...s };
}

// ───────────────────────────── sessions ─────────────────────────────

/**
 * The signed-in admin for a session token, or null. Re-checks on every call that the session exists and has not
 * expired AND that the email is still allowed; a session whose email is no longer allowed is deleted at once.
 * With `touch`, last_seen_at is refreshed at most every LIMITS.lastSeenMinutes.
 */
export async function sessionUser(db: D1, cfg: AuthConfig, token: string, at: string = nowIso(), opts: { touch?: boolean } = {}): Promise<AdminUser | null> {
  if (!SESSION_TOKEN_RE.test(token)) return null;
  const tokenHash = await authHash(cfg.secret, 'session', token);
  const [s, h] = await db.batch([
    stmt(db, 'SELECT email, last_seen_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?', tokenHash, at),
    stmt(db, 'SELECT active FROM admin_users WHERE email = (SELECT email FROM admin_sessions WHERE token_hash = ?)', tokenHash),
  ]);
  const row = s.results[0] as { email: string; last_seen_at: string | null } | undefined;
  if (!row) return null;
  const role: AdminRole | null = cfg.adminEmails.includes(row.email) ? 'owner'
    : (h.results[0] as { active: number } | undefined)?.active === 1 ? 'helper' : null;
  if (!role) {
    await stmt(db, 'DELETE FROM admin_sessions WHERE token_hash = ?', tokenHash).run();
    return null;
  }
  if (opts.touch && (!row.last_seen_at || row.last_seen_at < addTime(at, { minutes: -LIMITS.lastSeenMinutes }))) {
    await stmt(db, 'UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?', at, tokenHash).run();
  }
  return { email: row.email, role };
}

/**
 * Ends this session, or every session of its email ("Log out on all devices"), which also cancels that email's unused
 * login codes. Recovery codes are not changed (the logout answer says so and links to the recovery-codes page).
 */
export async function endSessions(db: D1, cfg: AuthConfig, token: string | null, opts: { all?: boolean; at?: string } = {}): Promise<{ email: string | null; ended: number }> {
  if (!token || !SESSION_TOKEN_RE.test(token)) return { email: null, ended: 0 };
  const at = opts.at ?? nowIso();
  const tokenHash = await authHash(cfg.secret, 'session', token);
  const row = await first<{ email: string }>(db, 'SELECT email FROM admin_sessions WHERE token_hash = ?', tokenHash);
  if (!row) return { email: null, ended: 0 };
  if (!opts.all) {
    const r = await stmt(db, 'DELETE FROM admin_sessions WHERE token_hash = ?', tokenHash).run();
    return { email: row.email, ended: r.meta.changes };
  }
  const [r] = await batch(db, [
    stmt(db, 'DELETE FROM admin_sessions WHERE email = ?', row.email),
    stmt(db, 'UPDATE login_codes SET expires_at = ? WHERE email = ? AND used_at IS NULL AND expires_at > ?', at, row.email, at),
    auditInsert(db, { at, actor: row.email, action: 'auth.logout_all', entity: 'admin', entityId: row.email, summary: 'Logged out on all devices (unused login codes cancelled)' }),
  ]);
  return { email: row.email, ended: r.meta.changes };
}

// ───────────────────────────── recovery codes ─────────────────────────────

/**
 * Makes a new set of recovery codes (the old ones stop working) and returns them: show them once, never store them.
 * Low level: pages use makeRecoveryCodes(), which checks the session age or an email code first and emails a notice.
 */
export async function createRecoveryCodes(db: D1, cfg: AuthConfig, actor: AdminUser, at: string = nowIso()): Promise<string[]> {
  const codes = new Set<string>();
  while (codes.size < LIMITS.recoveryCodes) codes.add(newRecoveryCode());
  const list = [...codes];
  const hashes = await Promise.all(list.map((c) => authHash(cfg.secret, 'recovery', `${actor.email}|${c.replace('-', '')}`)));
  await batch(db, [
    stmt(db, 'DELETE FROM recovery_codes WHERE email = ?', actor.email),
    stmt(db, `INSERT INTO recovery_codes (email, code_hash, created_at, used_at) SELECT ?, value, ?, NULL FROM json_each(?)`,
      actor.email, at, JSON.stringify(hashes)),
    auditInsert(db, { at, actor, action: 'auth.recovery_codes', entity: 'admin', entityId: actor.email, summary: 'New recovery codes made (the old ones stopped working)' }),
  ]);
  return list;
}

/** When the session of this token was made (a login), or null */
export async function sessionCreatedAt(db: D1, cfg: AuthConfig, token: string | null): Promise<string | null> {
  if (!token || !SESSION_TOKEN_RE.test(token)) return null;
  const r = await first<{ created_at: string }>(db, 'SELECT created_at FROM admin_sessions WHERE token_hash = ?', await authHash(cfg.secret, 'session', token));
  return r?.created_at ?? null;
}

/** True when the session was made (by a login) at most LIMITS.freshSessionMinutes ago */
export async function isFreshSession(db: D1, cfg: AuthConfig, token: string | null, at: string = nowIso()): Promise<boolean> {
  const created = await sessionCreatedAt(db, cfg, token);
  return created !== null && created >= addTime(at, { minutes: -LIMITS.freshSessionMinutes });
}

/** The notice emailed to an admin when new recovery codes were made for them */
export function recoveryCodesNotice(at: string): { subject: string; lines: string[] } {
  return {
    subject: 'New Beezy admin recovery codes were made',
    lines: [
      `New recovery codes for your Beezy admin login were made on ${shortDate(istDate(at))}`,
      `at ${istTime(at)} India time.`,
      'The old recovery codes stopped working.',
      '',
      'If you did this, there is nothing to do.',
      'If you did not: log in, choose "Log out on all devices", then make new recovery codes.',
    ],
  };
}

export type MakeRecoveryResult =
  | { ok: true; codes: string[] }
  | { ok: false; reason: 'needs_code' | 'wrong' | 'ip_limit' };

/**
 * "Make recovery codes" (security review 16 Nov 2026): allowed when this device's session was made at most 10 minutes
 * ago (a login just proved the email or a recovery code), otherwise only with a fresh email code (asked for with
 * requestLoginCode(…, purpose: 'recovery')), which is used up here. On success the codes are made and a notice is
 * emailed to the admin. 'needs_code': no code was typed; 'wrong': the code is wrong, used or expired.
 */
export async function makeRecoveryCodes(
  e: AuthEnv,
  cfg: AuthConfig,
  actor: AdminUser,
  input: { token: string | null; code?: string | null; ip: string | null; at?: string; waitUntil?: (p: Promise<unknown>) => void },
): Promise<MakeRecoveryResult> {
  const at = input.at ?? nowIso();
  const created = await sessionCreatedAt(e.DB, cfg, input.token);
  const fresh = created !== null && created >= addTime(at, { minutes: -LIMITS.freshSessionMinutes });
  if (!fresh) {
    if (!String(input.code ?? '').trim()) return { ok: false, reason: 'needs_code' };
    const checked = await consumeEmailCode(e, cfg, { email: actor.email, code: input.code, ip: input.ip, at });
    if (!checked.ok) return checked;
  }
  const codes = await createRecoveryCodes(e.DB, cfg, actor, at);
  const notice = recoveryCodesNotice(at);
  const sending = sendNoticeEmail(e.LOGIN_MAIL, actor.email, notice.subject, notice.lines);
  if (input.waitUntil) input.waitUntil(sending);
  else await sending;
  return { ok: true, codes };
}

export interface RecoveryStatus {
  total: number;
  unused: number;
  createdAt: string | null;
}

export async function recoveryStatus(db: D1, email: string): Promise<RecoveryStatus> {
  const r = await first<{ total: number; unused: number; created: string | null }>(db,
    'SELECT count(*) AS total, sum(used_at IS NULL) AS unused, max(created_at) AS created FROM recovery_codes WHERE email = ?', email);
  return { total: r?.total ?? 0, unused: r?.unused ?? 0, createdAt: r?.created ?? null };
}

// ───────────────────────────── the admin gate ─────────────────────────────

const NO_STORE = { 'cache-control': 'no-store' };

/** 503 while the login is not configured (fail closed). */
export function notSetUp(): Response {
  return new Response('Admin login is not set up yet.\n', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '3600', ...NO_STORE },
  });
}

/** Not signed in: JSON callers get 401, pages get a 303 to the login page (with ?next=). */
export function loginRequired(url: URL, request: Request, clearSession = false): Response {
  const headers = new Headers(NO_STORE);
  if (clearSession) headers.append('set-cookie', clearCookie(SESSION_COOKIE));
  const accept = (request.headers.get('accept') ?? '').toLowerCase();
  const wantsJson = url.pathname.startsWith('/admin/api/') || (accept.includes('application/json') && !accept.includes('text/html'));
  if (wantsJson) {
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(`${JSON.stringify({ error: 'login_required', login: '/admin/login/' })}\n`, { status: 401, headers });
  }
  headers.set('location', loginUrl(url.pathname + url.search));
  return new Response(null, { status: 303, headers });
}

/**
 * Returns the signed-in admin, or the Response to send instead: 303 to /admin/login/ (pages), 401 (JSON), or 503
 * when the login is not configured. Never throws for a normal "not signed in" case.
 */
export async function requireAdmin(context: Pick<APIContext, 'url' | 'request'>): Promise<AdminUser | Response> {
  const vars = env as unknown as AuthEnv & { DEV_ADMIN_EMAIL?: string };
  if (import.meta.env.DEV) {
    const devEmail = String(vars.DEV_ADMIN_EMAIL ?? '').trim().toLowerCase();
    if (devEmail.includes('@') && LOCAL_HOSTNAMES.includes(context.url.hostname)) {
      return { email: devEmail, role: 'owner' };
    }
  }
  const cfg = authConfig(vars);
  if (!cfg) return notSetUp();
  const token = readCookie(context.request, SESSION_COOKIE);
  if (token) {
    const user = await sessionUser(vars.DB, cfg, token, nowIso(), { touch: true });
    if (user) return user;
  }
  return loginRequired(context.url, context.request, token !== null);
}

// ───────────────────────────── login and logout pages ─────────────────────────────

export type LoginStep = 'email' | 'code' | 'recovery';

/** Fixed notices the login page can show (by key in ?note=, so a link can never show made-up text). */
export const LOGIN_NOTES = {
  sent: 'A 6-digit code is on its way to the inbox linked to this email. It works for 10 minutes. The first time, check your spam folder too.',
  resent: 'A new code is on its way to the inbox linked to this email. Use the newest email: older codes stop working.',
  limit15: 'Too many codes were asked for this email. Use the newest code you got, or wait 15 minutes and ask again.',
  limitday: 'Too many codes were asked for this email today. Use a recovery code, or try again tomorrow.',
  again: 'Please type your email again.',
  out: 'You are logged out.',
  out_all: 'You are logged out on all devices, and unused login codes no longer work. Your recovery codes still work: if someone else may have them, log in and make new ones.',
} as const;
export type LoginNote = keyof typeof LOGIN_NOTES;

export const LOGIN_ERRORS = {
  email: 'Type your full email address, for example name@beezyhoney.in.',
  noAccess: 'This email does not have access to the admin. Check the spelling, or ask an owner to add you as a helper.',
  wrong: 'That code is not right or has expired. Check the newest email from Beezy, or ask for a new code.',
  wrongRecovery: 'That recovery code is not right or was already used. Check it and try again.',
  ipLimit: 'Too many login tries from this connection. Please wait an hour and try again.',
  recoveryLimit: 'Too many recovery-code tries for this email today. Please try again tomorrow.',
} as const;

export interface LoginView {
  step: LoginStep;
  /** the email being logged in (code and recovery steps) */
  email: string | null;
  /** where to go after login */
  next: string;
  status: number;
  note: LoginNote | null;
  error: string | null;
  /** what was typed into the email box (refill after an error) */
  typedEmail?: string;
}

export type LoginOutcome =
  | { kind: 'redirect'; response: Response }
  | { kind: 'view'; view: LoginView }
  | { kind: 'unavailable' };

function redirect(location: string, cookies: string[] = []): LoginOutcome {
  const headers = new Headers({ location, ...NO_STORE });
  for (const c of cookies) headers.append('set-cookie', c);
  return { kind: 'redirect', response: new Response(null, { status: 303, headers }) };
}

const stepUrl = (step: LoginStep, next: string, note?: LoginNote) =>
  loginUrl(next, { step, ...(note ? { note } : {}) });

const isNote = (v: string | null): v is LoginNote => v !== null && Object.prototype.hasOwnProperty.call(LOGIN_NOTES, v);

/** GET /admin/login/: which step to show, or a redirect when already signed in. */
export async function loginGet(e: AuthEnv, request: Request, url: URL, at: string = nowIso()): Promise<LoginOutcome> {
  const cfg = authConfig(e);
  if (!cfg) return { kind: 'unavailable' };
  const next = safeNext(url.searchParams.get('next'));
  const token = readCookie(request, SESSION_COOKIE);
  if (token && (await sessionUser(e.DB, cfg, token, at))) return redirect(next);
  const asked = url.searchParams.get('step');
  const email = loginCookieEmail(request);
  let step: LoginStep = asked === 'code' || asked === 'recovery' ? asked : 'email';
  const noteParam = url.searchParams.get('note');
  let note: LoginNote | null = isNote(noteParam) ? noteParam : null;
  if (step !== 'email' && !email) {
    step = 'email';
    note = 'again';
  }
  if (step === 'code' && !note) note = 'sent';
  return {
    kind: 'view',
    view: { step, email: step === 'email' ? null : email, next, status: 200, note, error: null, typedEmail: step === 'email' ? email ?? '' : undefined },
  };
}

/** The client IP Cloudflare saw (null locally). */
export const clientIp = (request: Request): string | null => request.headers.get('cf-connecting-ip');

/**
 * POST /admin/login/ (`_action`): send | use_recovery | resend | verify | recover.
 * Success → 303 (to the code step, or with the session cookie to `next` / the recovery-codes page at first login);
 * a typing mistake or a wrong code → the same page again (422, or 429 over a limit).
 */
export async function loginPost(
  e: AuthEnv,
  request: Request,
  url: URL,
  opts: { waitUntil?: (p: Promise<unknown>) => void; at?: string } = {},
): Promise<LoginOutcome> {
  const cfg = authConfig(e);
  if (!cfg) return { kind: 'unavailable' };
  const at = opts.at ?? nowIso();
  let form: FormData;
  try {
    if (Number(request.headers.get('content-length') ?? 0) > 16 * 1024) throw new Error('too big');
    form = await request.formData();
  } catch {
    return redirect(loginUrl());
  }
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === 'string' ? v : '';
  };
  const next = safeNext(field('next') || url.searchParams.get('next'));
  const action = field('_action');
  const ip = clientIp(request);
  const view = (v: Partial<LoginView> & { step: LoginStep }): LoginOutcome =>
    ({ kind: 'view', view: { email: null, next, status: 422, note: null, error: null, ...v } });

  // The login cookie and the page keep the email as typed (an alias stays the alias, so the Gmail behind it is never
  // shown); every step resolves it again, and limits, codes, mail and the session use the resolved email.
  if (action === 'send' || action === 'use_recovery') {
    const typed = field('email').slice(0, 300);
    const email = normaliseEmail(typed);
    if (!email) return view({ step: 'email', error: LOGIN_ERRORS.email, typedEmail: typed });
    const login = await resolveLoginEmail(e.DB, cfg, email);
    const allowed = (await roleFor(e.DB, cfg, login)) !== null;
    // An email that may not log in only counts as one try of this IP: no code is made, no mail goes out.
    const r = await requestLoginCode(e, cfg, { email: login, ip, sendCode: action === 'send' && allowed, at, waitUntil: opts.waitUntil });
    if (!r.ok && r.reason === 'ip_limit') return view({ step: 'email', status: 429, error: LOGIN_ERRORS.ipLimit, typedEmail: typed });
    if (!allowed) return view({ step: 'email', status: 403, error: LOGIN_ERRORS.noAccess, typedEmail: typed });
    const note: LoginNote | undefined = action === 'use_recovery' ? undefined
      : r.ok ? 'sent' : r.reason === 'day_limit' ? 'limitday' : 'limit15';
    return redirect(stepUrl(action === 'send' ? 'code' : 'recovery', next, note), [loginCookie(email)]);
  }

  const email = loginCookieEmail(request);
  if (action === 'resend') {
    if (!email) return redirect(stepUrl('email', next, 'again'));
    const r = await requestLoginCode(e, cfg, { email: await resolveLoginEmail(e.DB, cfg, email), ip, at, waitUntil: opts.waitUntil });
    if (!r.ok && r.reason === 'ip_limit') return view({ step: 'code', email, status: 429, error: LOGIN_ERRORS.ipLimit });
    return redirect(stepUrl('code', next, r.ok ? 'resent' : r.reason === 'day_limit' ? 'limitday' : 'limit15'), [loginCookie(email)]);
  }

  if (action === 'verify' || action === 'recover') {
    if (!email) return redirect(stepUrl('email', next, 'again'));
    const userAgent = request.headers.get('user-agent');
    const login = await resolveLoginEmail(e.DB, cfg, email);
    const r = action === 'verify'
      ? await verifyLoginCode(e, cfg, { email: login, code: field('code'), ip, userAgent, at })
      : await verifyRecoveryCode(e, cfg, { email: login, code: field('recovery'), ip, userAgent, at });
    const step: LoginStep = action === 'verify' ? 'code' : 'recovery';
    if (!r.ok) {
      if (r.reason === 'ip_limit') return view({ step, email, status: 429, error: LOGIN_ERRORS.ipLimit });
      if (r.reason === 'recovery_limit') return view({ step, email, status: 429, error: LOGIN_ERRORS.recoveryLimit });
      return view({ step, email, error: action === 'verify' ? LOGIN_ERRORS.wrong : LOGIN_ERRORS.wrongRecovery });
    }
    const to = r.firstLogin ? `/admin/login/recovery/${next === '/admin/' ? '?first=1' : `?first=1&next=${encodeURIComponent(next)}`}` : next;
    return redirect(to, [sessionCookie(r.token), clearCookie(LOGIN_COOKIE)]);
  }

  return redirect(loginUrl(next));
}

/** POST /admin/logout/ (`_action` = 'all' for every device; anything else = this device). Always 303 to the login page. */
export async function logoutPost(e: AuthEnv, request: Request, opts: { at?: string } = {}): Promise<Response> {
  const cfg = authConfig(e);
  if (!cfg) return notSetUp();
  let all = false;
  try {
    const form = await request.formData();
    all = form.get('_action') === 'all';
  } catch {
    // no form body: log out this device
  }
  await endSessions(e.DB, cfg, readCookie(request, SESSION_COOKIE), { all, at: opts.at });
  const headers = new Headers({ location: `/admin/login/?note=${all ? 'out_all' : 'out'}`, ...NO_STORE });
  headers.append('set-cookie', clearCookie(SESSION_COOKIE));
  headers.append('set-cookie', clearCookie(LOGIN_COOKIE));
  return new Response(null, { status: 303, headers });
}

/** GET /admin/logout/: who is signed in on this device (null when nobody), or 'unavailable'. */
export async function currentUser(e: AuthEnv, request: Request, at: string = nowIso()): Promise<AdminUser | null | 'unavailable'> {
  const cfg = authConfig(e);
  if (!cfg) return 'unavailable';
  const token = readCookie(request, SESSION_COOKIE);
  return token ? sessionUser(e.DB, cfg, token, at) : null;
}

/** The last login codes sent, e2e builds only (always null otherwise; production builds do not contain the hook). */
export function e2eLastCode(email?: string | null): E2eEntry | null {
  if (import.meta.env.MODE === 'e2e') {
    const list = (globalThis as { BEEZY_E2E_HOOK?: E2eEntry[] }).BEEZY_E2E_HOOK ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (!email || list[i].email === email) return list[i];
  }
  return null;
}
