// The login-code email (src/server/mail.ts): a correct RFC 5322 / MIME message, plain text + simple HTML.
import { describe, expect, it } from 'vitest';
import { buildLoginCodeEmail, isMailAddress, LOGIN_FROM, rfc5322Date, sendLoginCodeEmail } from '../../../src/server/mail';

const NOW = new Date('2026-11-15T04:30:05Z');
const mail = () => buildLoginCodeEmail('owner@example.test', '042917', { now: NOW, messageId: '<abc123@beezyhoney.in>', boundary: 'bz-test' });

/** Very small MIME reader for the checks below. */
function parse(raw: string) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers = new Map(head.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
  const body = rest.join('\r\n\r\n');
  const parts = body.split('--bz-test').slice(1, -1).map((p) => {
    const [ph, ...pb] = p.replace(/^\r\n/, '').split('\r\n\r\n');
    return { head: ph, body: pb.join('\r\n\r\n').replace(/\r\n$/, '') };
  });
  return { headers, parts, body };
}

describe('buildLoginCodeEmail', () => {
  it('has every header a mail server expects, with the agreed subject and sender', () => {
    const m = mail();
    const { headers } = parse(m.raw);
    expect(headers.get('from')).toBe(`"Beezy Honey admin" <${LOGIN_FROM}>`);
    expect(LOGIN_FROM).toBe('login@beezyhoney.in');
    expect(headers.get('to')).toBe('<owner@example.test>');
    expect(headers.get('subject')).toBe('Beezy admin login code: 042917');
    expect(headers.get('date')).toBe('Sun, 15 Nov 2026 04:30:05 +0000');
    expect(headers.get('message-id')).toBe('<abc123@beezyhoney.in>');
    expect(headers.get('mime-version')).toBe('1.0');
    expect(headers.get('auto-submitted')).toBe('auto-generated');
    expect(headers.get('content-type')).toBe('multipart/alternative; boundary="bz-test"');
    expect(m).toMatchObject({ from: LOGIN_FROM, to: 'owner@example.test', subject: 'Beezy admin login code: 042917', messageId: '<abc123@beezyhoney.in>' });
  });

  it('has a plain-text part and a simple HTML part, both with the code, and closes the multipart', () => {
    const { parts, body } = parse(mail().raw);
    expect(parts).toHaveLength(2);
    expect(parts[0].head).toBe('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit');
    expect(parts[0].body).toContain('Your Beezy admin login code is: 042917');
    expect(parts[0].body).toContain('It works once, for 10 minutes.');
    expect(parts[1].head).toBe('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit');
    expect(parts[1].body).toMatch(/^<!doctype html>/);
    expect(parts[1].body).toContain('>042917</p>');
    expect(parts[1].body).not.toMatch(/https?:\/\/|<img|<script/i); // nothing loaded from anywhere, no links
    expect(body.trimEnd().endsWith('--bz-test--')).toBe(true);
  });

  it('is 7-bit ASCII with CRLF line ends and short lines', () => {
    const { raw } = mail();
    expect(raw).toMatch(/^[\x20-\x7e\r\n]+$/);
    expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(Math.max(...raw.split('\r\n').map((l) => l.length))).toBeLessThanOrEqual(100);
  });

  it('makes a fresh Message-ID and boundary when none is given', () => {
    const a = buildLoginCodeEmail('owner@example.test', '123456');
    const b = buildLoginCodeEmail('owner@example.test', '123456');
    expect(a.messageId).toMatch(/^<[0-9a-f]{32}\.[0-9a-z]+@beezyhoney\.in>$/);
    expect(a.messageId).not.toBe(b.messageId);
    expect(a.raw).toMatch(/boundary="bz-[0-9a-f]{24}"/);
  });

  it('refuses addresses that could inject headers, and codes that are not 6 digits', () => {
    for (const bad of ['owner@example.test\r\nBcc: x@evil.example', 'a b@example.test', '<a@example.test>', 'noat', '"q"@example.test', '']) {
      expect(() => buildLoginCodeEmail(bad, '123456'), bad).toThrow(/recipient/);
      expect(isMailAddress(bad)).toBe(false);
    }
    for (const bad of ['12345', '1234567', 'abcdef', '12 456']) expect(() => buildLoginCodeEmail('owner@example.test', bad)).toThrow(/6 digits/);
  });

  it('rfc5322Date pads and uses +0000', () => {
    expect(rfc5322Date(new Date('2027-01-02T03:04:05Z'))).toBe('Sat, 02 Jan 2027 03:04:05 +0000');
  });
});

describe('sendLoginCodeEmail', () => {
  it('hands the raw message to the binding as an EmailMessage(from, to, raw)', async () => {
    const made: unknown[][] = [];
    class FakeMessage { constructor(...args: unknown[]) { made.push(args); } }
    const sent: unknown[] = [];
    const ok = await sendLoginCodeEmail({ send: async (m) => { sent.push(m); } }, 'owner@example.test', '654321', { EmailMessage: FakeMessage as never, now: NOW });
    expect(ok).toBe(true);
    expect(made).toHaveLength(1);
    expect(made[0][0]).toBe(LOGIN_FROM);
    expect(made[0][1]).toBe('owner@example.test');
    expect(String(made[0][2])).toContain('Subject: Beezy admin login code: 654321\r\n');
    expect(sent[0]).toBeInstanceOf(FakeMessage);
  });
});
