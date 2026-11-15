// Browser-script logic that does not need a real page: session classification, status shape, chip words.
// (The DOM behaviour itself is checked in headless Chrome against the style guide.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientStrings } from '../../../src/admin/strings';

const realDocument = (globalThis as { document?: unknown }).document;

beforeAll(() => {
  // client/strings.ts reads the words from <script id="admin-strings">
  (globalThis as { document?: unknown }).document = {
    getElementById: (id: string) => (id === 'admin-strings' ? { textContent: JSON.stringify(clientStrings()) } : null),
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

describe('session classification', async () => {
  const { classify } = await import('../../../src/admin/client/session');
  const base = { status: 200, ok: true, redirected: false, url: 'http://x/admin/api/status.json', type: 'application/json' };

  it('JSON answer is fine', () => expect(classify(base)).toBe('json'));
  it('401 / 403 mean the login expired', () => {
    expect(classify({ ...base, status: 401, ok: false })).toBe('expired');
    expect(classify({ ...base, status: 403, ok: false })).toBe('expired');
  });
  it('a redirect to the login page, or HTML where JSON was expected, means expired', () => {
    expect(classify({ ...base, redirected: true, url: 'http://x/admin/login/?next=%2Fadmin%2F', type: 'text/html; charset=utf-8' })).toBe('expired');
    expect(classify({ ...base, type: 'text/html' })).toBe('expired');
  });
  it('network-ish trouble never claims expiry', () => {
    expect(classify({ ...base, status: 404, ok: false, type: 'text/html' })).toBe('unknown');
    expect(classify({ ...base, status: 503, ok: false, type: 'text/plain' })).toBe('unknown');
    expect(classify({ ...base, type: 'text/plain' })).toBe('unknown');
  });
});

describe('status chip', async () => {
  const { chipTexts, websiteOf } = await import('../../../src/admin/client/status');

  it('reads only the expected shape', () => {
    expect(websiteOf({ website: { state: 'up_to_date', at: '2026-11-15T05:12:00Z' } })).toEqual({ state: 'up_to_date', at: '2026-11-15T05:12:00Z' });
    expect(websiteOf({ website: { state: 'off' } })).toEqual({ state: 'off', at: null });
    expect(websiteOf({ website: { state: 'updating', at: 'garbage' } })).toEqual({ state: 'updating', at: null });
    expect(websiteOf({ website: { state: 'exploded' } })).toBeNull();
    expect(websiteOf({})).toBeNull();
    expect(websiteOf(null)).toBeNull();
    expect(websiteOf('up_to_date')).toBeNull();
  });

  it('also reads src/server/publish.ts getPublishStatus() as the website part', () => {
    const last = { id: 3, siteVersion: 7, reason: 'save', requestedAt: '2026-11-15T05:10:00Z', status: 'live', liveAt: '2026-11-15T05:14:00Z', error: null };
    const base = { message: 'x', siteVersion: 7, publishedVersion: 7, dueAt: null, last };
    expect(websiteOf({ website: { ...base, state: 'up_to_date' } })).toEqual({ state: 'up_to_date', at: '2026-11-15T05:14:00Z' });
    expect(websiteOf({ website: { ...base, state: 'up_to_date', last: { ...last, liveAt: null } } })).toEqual({ state: 'up_to_date', at: '2026-11-15T05:10:00Z' });
    expect(websiteOf({ website: { ...base, state: 'up_to_date', last: null } })).toEqual({ state: 'up_to_date', at: null });
    expect(websiteOf({ website: { ...base, state: 'updating' } })).toEqual({ state: 'updating', at: '2026-11-15T05:10:00Z' });
    expect(websiteOf({ website: { ...base, state: 'waiting', dueAt: '2026-11-15T05:35:00Z' } })).toEqual({ state: 'waiting', at: '2026-11-15T05:35:00Z' });
    expect(websiteOf({ website: { ...base, state: 'waiting' } })).toEqual({ state: 'waiting', at: null });
    expect(websiteOf({ website: { ...base, state: 'failed' } })).toEqual({ state: 'failed', at: null });
    expect(websiteOf({ website: { ...base, state: 'disabled' } })).toEqual({ state: 'off', at: null });
  });

  it('words for each state (design §2.5)', () => {
    const now = Date.parse('2026-11-15T05:14:00Z');
    expect(chipTexts('up_to_date', '2026-11-15T05:12:00Z', now)).toEqual({ long: 'Website up to date ✓ (10:42 am)', short: 'Website up to date ✓' });
    expect(chipTexts('updating', '2026-11-15T05:12:00Z', now).long).toBe('Updating… started 2 min ago');
    expect(chipTexts('waiting', '2026-11-15T05:35:00Z', now).long).toBe('Changes waiting, update at 11:05 am');
    expect(chipTexts('failed', null, now).long).toBe("Update didn't finish");
    expect(chipTexts('off', null, now)).toEqual({ long: 'Publishing is off on this computer', short: 'Publishing off' });
    expect(chipTexts('unknown', null, now)).toEqual({ long: 'Website', short: 'Website' });
    expect(chipTexts('up_to_date', null, now).long).toBe('Website up to date ✓');
  });
});

describe('live kg hint', async () => {
  const { gramsHint } = await import('../../../src/admin/client/enhance');
  it('shows grams and jar counts', () => {
    expect(gramsHint('99', [250, 100])).toBe('= 99,000 g · ≈ 396 × 250 g or 990 × 100 g');
    expect(gramsHint('500 g', [])).toBe('= 500 g');
    expect(gramsHint('lots', [250])).toBe('');
  });
});
