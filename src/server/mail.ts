// Login-code emails (amendment A1), sent through the `send_email` binding LOGIN_MAIL (wrangler.jsonc).
//
// Cloudflare delivers these only to destination addresses verified in the account's Email Routing, which is a second
// lock on top of our own allowlist. The binding has no address restrictions in wrangler.jsonc on purpose, so no email
// address is ever committed (the repo is public).
//
// Workers API (checked 15 Nov 2026, developers.cloudflare.com/email-routing/email-workers/send-email-workers/):
// `env.LOGIN_MAIL.send(message)` takes either the builder object ({ to, from, subject, text, html }) or the raw MIME
// form `new EmailMessage(from, to, raw)` from 'cloudflare:email'. We build the raw RFC 5322 / MIME message ourselves
// (multipart/alternative: plain text + simple HTML, with Date and Message-ID), because the local Miniflare simulation
// and Email Routing both check it the same way: a Message-ID must exist and the From: header must equal the envelope
// sender. Everything is 7-bit ASCII with CRLF line ends and short lines, so no transfer encoding is needed.
//
// buildLoginCodeEmail() and buildNoticeEmail() are pure (unit-tested in Node); the send functions load
// 'cloudflare:email' only when they run. Notices (e.g. "new recovery codes were made") go to the admin's own address.

/** The sender. Email Routing on beezyhoney.in sends from this address. */
export const LOGIN_FROM = 'login@beezyhoney.in';
export const LOGIN_FROM_NAME = 'Beezy Honey admin';
export const MESSAGE_ID_DOMAIN = 'beezyhoney.in';

const CRLF = '\r\n';
/** A plain address with no spaces, quotes, angle brackets or line breaks (stops header injection). */
const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isMailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && ADDRESS_RE.test(value);
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/** RFC 5322 date in UTC: 'Sun, 15 Nov 2026 04:30:00 +0000' */
export function rfc5322Date(date: Date): string {
  return `${DAYS[date.getUTCDay()]}, ${two(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} `
    + `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`;
}

export interface LoginCodeEmail {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  text: string;
  html: string;
  /** the whole message, CRLF line ends */
  raw: string;
}

/** What the code is for: logging in, or confirming "make new recovery codes" on the recovery-codes page */
export type CodePurpose = 'login' | 'recovery';

/** The plain-text part (also the words of the HTML part). */
export function loginCodeText(code: string, minutes: number, purpose: CodePurpose = 'login'): string {
  return [
    purpose === 'login' ? `Your Beezy admin login code is: ${code}` : `Your Beezy admin code to make new recovery codes is: ${code}`,
    '',
    `It works once, for ${minutes} minutes. Type it on the ${purpose === 'login' ? 'login' : 'recovery codes'} page.`,
    '',
    'If you did not ask for this code, you can ignore this email.',
    'Nobody can log in without the code.',
    '',
    'Beezy Honey admin',
  ].join(CRLF);
}

function loginCodeHtml(code: string, minutes: number, purpose: CodePurpose = 'login'): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Beezy admin login code</title></head>',
    '<body style="margin:0;padding:24px;background:#FBF3E6;color:#2B1A10;',
    'font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">',
    purpose === 'login' ? '<p style="margin:0 0 12px">Your Beezy admin login code is:</p>'
      : '<p style="margin:0 0 12px">Your Beezy admin code to make new recovery codes is:</p>',
    '<p style="margin:0 0 16px;font-size:30px;font-weight:bold;',
    `letter-spacing:6px">${code}</p>`,
    `<p style="margin:0 0 16px">It works once, for ${minutes} minutes.`,
    `Type it on the ${purpose === 'login' ? 'login' : 'recovery codes'} page.</p>`,
    '<p style="margin:0;color:#5E4A3A">If you did not ask for this code,',
    'you can ignore this email. Nobody can log in without the code.</p>',
    '</body>',
    '</html>',
  ].join(CRLF);
}

/**
 * Builds the login-code email. Throws on a bad address or code (never a header-injection string).
 * `now` and `ids` are for tests.
 */
export function buildLoginCodeEmail(
  to: string,
  code: string,
  opts: { minutes?: number; now?: Date; messageId?: string; boundary?: string; purpose?: CodePurpose } = {},
): LoginCodeEmail {
  if (!isMailAddress(to)) throw new Error('login mail: bad recipient address');
  if (!/^\d{6}$/.test(code)) throw new Error('login mail: the code must be 6 digits');
  const minutes = opts.minutes ?? 10;
  const purpose = opts.purpose ?? 'login';
  const subject = purpose === 'login' ? `Beezy admin login code: ${code}` : `Beezy admin code: ${code}`;
  return buildMessage(to, subject, loginCodeText(code, minutes, purpose), loginCodeHtml(code, minutes, purpose), opts);
}

/**
 * A short notice to an admin's own address (plain text + the same words as simple HTML). `lines` are plain ASCII
 * sentences of at most 90 characters; an empty string starts a new paragraph.
 */
export function buildNoticeEmail(to: string, subject: string, lines: string[], opts: { now?: Date; messageId?: string; boundary?: string } = {}): LoginCodeEmail {
  if (!isMailAddress(to)) throw new Error('login mail: bad recipient address');
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras: string[][] = [[]];
  for (const l of lines) {
    if (l === '') paras.push([]);
    else paras[paras.length - 1].push(esc(l));
  }
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    `<head><meta charset="utf-8"><title>${esc(subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#FBF3E6;color:#2B1A10;',
    'font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">',
    ...paras.filter((p) => p.length).map((p) => ['<p style="margin:0 0 12px">', ...p, '</p>'].join(CRLF)),
    '</body>',
    '</html>',
  ].join(CRLF);
  return buildMessage(to, subject, [...lines, '', 'Beezy Honey admin'].join(CRLF), html, opts);
}

/** The whole MIME message (multipart/alternative: text + HTML). Throws when it would not be 7-bit with short lines. */
function buildMessage(to: string, subject: string, text: string, html: string, opts: { now?: Date; messageId?: string; boundary?: string }): LoginCodeEmail {
  const now = opts.now ?? new Date();
  const messageId = opts.messageId ?? `<${randomHex(16)}.${now.getTime().toString(36)}@${MESSAGE_ID_DOMAIN}>`;
  const boundary = opts.boundary ?? `bz-${randomHex(12)}`;
  const headers = [
    `From: "${LOGIN_FROM_NAME}" <${LOGIN_FROM}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) => [
    `--${boundary}`,
    `Content-Type: ${type}; charset=utf-8`,
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
  ].join(CRLF);
  const raw = [
    headers.join(CRLF),
    '',
    'This is a multi-part message in MIME format.',
    part('text/plain', text),
    part('text/html', html),
    `--${boundary}--`,
    '',
  ].join(CRLF);
  // 7bit means ASCII only and lines of at most 998 characters (we keep them under 100)
  if (!/^[\x20-\x7e\r\n]*$/.test(raw)) throw new Error('login mail: the message must be ASCII');
  if (raw.split(CRLF).some((l) => l.length > 100)) throw new Error('login mail: a line is too long');
  return { from: LOGIN_FROM, to, subject, messageId, text, html, raw };
}

/** The part of the send_email binding we use. */
export interface MailBinding {
  send(message: unknown): Promise<unknown>;
}

type EmailMessageCtor = new (from: string, to: string, raw: string) => unknown;

/**
 * Sends the login code. Resolves to true when the binding accepted the message, false (and logs) when it failed or
 * the binding is missing. Never throws, so it can run inside waitUntil. The address is never logged.
 */
export async function sendLoginCodeEmail(
  binding: MailBinding | undefined | null,
  to: string,
  code: string,
  opts: { minutes?: number; now?: Date; EmailMessage?: EmailMessageCtor; purpose?: CodePurpose } = {},
): Promise<boolean> {
  return sendBuilt(binding, () => buildLoginCodeEmail(to, code, opts), 'login code', opts.EmailMessage);
}

/** Sends a notice (see buildNoticeEmail). Never throws; false when it was not sent. The address is never logged. */
export async function sendNoticeEmail(
  binding: MailBinding | undefined | null,
  to: string,
  subject: string,
  lines: string[],
  opts: { now?: Date; EmailMessage?: EmailMessageCtor } = {},
): Promise<boolean> {
  return sendBuilt(binding, () => buildNoticeEmail(to, subject, lines, opts), 'notice', opts.EmailMessage);
}

async function sendBuilt(binding: MailBinding | undefined | null, build: () => LoginCodeEmail, what: string, EmailMessage?: EmailMessageCtor): Promise<boolean> {
  try {
    if (!binding) {
      console.error(`[mail] LOGIN_MAIL binding is missing: ${what} not sent`);
      return false;
    }
    const mail = build();
    const Ctor = EmailMessage ?? ((await import('cloudflare:email')) as unknown as { EmailMessage: EmailMessageCtor }).EmailMessage;
    await binding.send(new Ctor(mail.from, mail.to, mail.raw));
    return true;
  } catch (e) {
    console.error(`[mail] ${what} not sent:`, e instanceof Error ? e.message.replace(/\S+@\S+/g, '<address>') : 'unknown error');
    return false;
  }
}
