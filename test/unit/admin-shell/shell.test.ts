// strings, nav, status chips, format, chart maths
import { describe, expect, it } from 'vitest';
import { bars, labelStep, niceMax, visibleLabels } from '../../../src/admin/chart';
import {
  addDays, ageShort, dateIST, dateTimeIST, dayIST, inr, inrInput, int, isDay, jarEquivalents, kg, kgInput, monthLabel,
  packGrams, pct, pieces, rangeFor, timeIST,
} from '../../../src/admin/format';
import { ICONS } from '../../../src/admin/icons';
import { NAV, canOpen, navFor, navKeyForPath, tabsFor } from '../../../src/admin/nav';
import { STATUS_TONES, paymentState, statusChip, type BadgeKind } from '../../../src/admin/status';
import { CLIENT_KEYS, EN, clientStrings, defineStrings, interpolate, isStringKey, t } from '../../../src/admin/strings';

describe('strings', () => {
  it('t fills placeholders and leaves unknown ones visible', () => {
    expect(t('nav.signedInAs', { email: 'a@example.test' })).toBe('Signed in as a@example.test');
    expect(t('form.tooLong')).toBe('Please keep it to {max} characters or fewer.');
    expect(interpolate('{a} {b}', { a: 1 })).toBe('1 {b}');
    expect(t('nav.today', undefined, 'ta')).toBe('Today'); // Tamil falls back to English
  });

  it('every string is non-empty and trimmed', () => {
    for (const [k, v] of Object.entries(EN)) {
      expect(v.trim(), k).toBe(v);
      expect(v.length, k).toBeGreaterThan(0);
    }
  });

  it('client strings are core keys', () => {
    for (const k of CLIENT_KEYS) expect(isStringKey(k)).toBe(true);
    expect(clientStrings()['session.expired']).toBe('Login expired — tap to sign in again');
  });

  it('defineStrings: area keys plus core keys, no clashes', () => {
    const S = defineStrings({ 'orders.title': 'Orders list', 'orders.count': '{n} orders' }, { 'orders.title': 'ஆர்டர்கள்' });
    expect(S.t('orders.title')).toBe('Orders list');
    expect(S.t('orders.title', undefined, 'ta')).toBe('ஆர்டர்கள்');
    expect(S.t('orders.count', { n: 3 })).toBe('3 orders');
    expect(S.t('common.save')).toBe('Save');
    expect(() => defineStrings({ 'common.save': 'x' })).toThrow(/core key/);
  });

  it('every status in status.ts has words', () => {
    for (const kind of Object.keys(STATUS_TONES) as BadgeKind[]) {
      for (const value of Object.keys(STATUS_TONES[kind])) {
        const chip = statusChip(kind, value);
        expect(chip.label && isStringKey(chip.label), `${kind}.${value}`).toBe(true);
      }
    }
    expect(statusChip('order', 'weird')).toEqual({ tone: 'neutral', label: null, raw: 'weird' });
    expect(t(statusChip('order', 'shipped').label!)).toBe('Sent');
  });
});

describe('nav', () => {
  const REQUIRED = ['/admin/', '/admin/orders/', '/admin/sales/', '/admin/stock/', '/admin/harvests/', '/admin/batches/',
    '/admin/labels/', '/admin/products/', '/admin/prices/', '/admin/requests/', '/admin/website/', '/admin/people/',
    '/admin/backup/', '/admin/activity/', '/admin/help/', '/admin/invoice/'];

  it('lists every screen, with trailing slashes, labels and icons', () => {
    const hrefs = navFor('owner').map((n) => n.href);
    for (const h of REQUIRED) expect(hrefs).toContain(h);
    for (const n of NAV) {
      expect(n.href).toMatch(/^\/admin\/([a-z-]+\/)*$/);
      expect(isStringKey(n.label)).toBe(true);
      expect(Object.keys(ICONS)).toContain(n.icon);
    }
    expect(hrefs).not.toContain('/admin/styleguide/'); // hidden
  });

  it('phone tabs: Today · Orders · Stock · Products (+ More); helpers get Harvests', () => {
    expect(tabsFor('owner').map((n) => n.key)).toEqual(['today', 'orders', 'stock', 'products']);
    expect(tabsFor('helper').map((n) => n.key)).toEqual(['today', 'orders', 'stock', 'harvests']);
  });

  it('helpers do not see owner-only screens', () => {
    const keys = navFor('helper').map((n) => n.key);
    for (const k of ['products', 'prices', 'website', 'people', 'backup', 'activity']) expect(keys).not.toContain(k);
    expect(keys).toContain('orders');
    expect(canOpen('helper', 'prices')).toBe(false);
    expect(canOpen('owner', 'styleguide')).toBe(true);
    expect(canOpen('helper', 'help')).toBe(true);
  });

  it('navKeyForPath picks the longest match', () => {
    expect(navKeyForPath('/admin/')).toBe('today');
    expect(navKeyForPath('/admin')).toBe('today');
    expect(navKeyForPath('/admin/orders/12/')).toBe('orders');
    expect(navKeyForPath('/admin/orders/new/')).toBe('orders');
    expect(navKeyForPath('/admin/stock/41/')).toBe('stock');
    expect(navKeyForPath('/admin/login/')).toBeUndefined();
    expect(navKeyForPath('/shop/')).toBeUndefined();
  });
});

describe('format', () => {
  it('money', () => {
    expect(inr(10500000)).toBe('₹1,05,000');
    expect(inr(105050)).toBe('₹1,050.50');
    expect(inr(null)).toBe('—');
    expect(inrInput(10500000)).toBe('1,05,000');
    expect(inrInput(105050)).toBe('1,050.50');
    expect(inrInput(-5000)).toBe('-50');
    expect(inrInput(null)).toBe('');
  });

  it('numbers and percents', () => {
    expect(int(105000)).toBe('1,05,000');
    expect(int(-1200)).toBe('-1,200');
    expect(int(null)).toBe('—');
    expect(pct(0.125)).toBe('12.5%');
    expect(pct(0.1)).toBe('10%');
    expect(pct(-0.4)).toBe('-40%');
    expect(pieces(1)).toBe('1 piece');
    expect(pieces(12)).toBe('12 pieces');
  });

  it('kg for display and for inputs (never loses grams)', () => {
    expect(kg(99500)).toBe('99.5 kg');
    expect(kg(-2000)).toBe('-2.0 kg');
    expect(kg(1250000)).toBe('1,250.0 kg');
    expect(kg(0)).toBe('0.0 kg');
    expect(kg(-40)).toBe('0.0 kg');
    expect(kgInput(99500)).toBe('99.5');
    expect(kgInput(99550)).toBe('99.55');
    expect(kgInput(99555)).toBe('99.555');
    expect(kgInput(100000)).toBe('100.0');
    expect(kgInput(250)).toBe('0.25');
    expect(kgInput(5)).toBe('0.005');
    expect(kgInput(-1250)).toBe('-1.25');
    expect(kgInput(null)).toBe('');
    expect(packGrams(250)).toBe('250 g');
    expect(packGrams(1000)).toBe('1 kg');
    expect(packGrams(1500)).toBe('1.5 kg');
  });

  it('jar equivalents (amendment A3)', () => {
    expect(jarEquivalents(99000, [250, 100])).toBe('≈ 396 × 250 g or 990 × 100 g');
    expect(jarEquivalents(99000, [100, 250, 250])).toBe('≈ 396 × 250 g or 990 × 100 g');
    expect(jarEquivalents(200, [250, 100])).toBe('≈ 2 × 100 g');
    expect(jarEquivalents(50, [250])).toBe('');
    expect(jarEquivalents(-2000, [250])).toBe('');
  });

  it('IST dates and times', () => {
    expect(dateIST('2026-11-14T19:00:00Z')).toBe('15 Nov 2026'); // 00:30 IST next day
    expect(dateIST('2026-11-15')).toBe('15 Nov 2026');
    expect(dateIST(null)).toBe('—');
    expect(dateIST('nonsense')).toBe('—');
    expect(timeIST('2026-11-15T05:12:00Z')).toBe('10:42 am');
    expect(timeIST('2026-11-15T12:00:00Z')).toBe('5:30 pm');
    expect(dateTimeIST('2026-11-15T05:12:00Z')).toBe('15 Nov 2026, 10:42 am');
    expect(monthLabel('2026-04')).toBe('Apr 2026');
    expect(dayIST('2026-03-31T18:29:59Z')).toBe('2026-03-31');
    expect(dayIST('2026-03-31T18:30:00Z')).toBe('2026-04-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(isDay('2026-02-29')).toBe(false);
  });

  it('ages', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(ageShort('2026-11-15T11:59:20Z', now)).toBe('40 sec');
    expect(ageShort('2026-11-15T11:55:00Z', now)).toBe('5 min');
    expect(ageShort('2026-11-15T09:00:00Z', now)).toBe('3 h');
    expect(ageShort('2026-11-13T12:00:00Z', now)).toBe('2 days');
    expect(ageShort('2026-10-01T12:00:00Z', now)).toBe('6 weeks');
    expect(ageShort('2026-11-16T12:00:00Z', now)).toBe('0 sec');
  });

  it('range presets in IST, financial year April–March', () => {
    const now = Date.parse('2026-11-15T05:00:00Z');
    expect(rangeFor('today', now)).toEqual({ from: '2026-11-15', to: '2026-11-15' });
    expect(rangeFor('last7', now)).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    expect(rangeFor('thisMonth', now)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(rangeFor('lastMonth', now)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(rangeFor('thisFy', now)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(rangeFor('lastFy', now)).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(rangeFor('thisYear', now)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    // 31 Mar 23:59 IST is still the old financial year; 1 Apr 00:00 IST is the new one
    expect(rangeFor('thisFy', Date.parse('2026-03-31T18:29:00Z')).from).toBe('2025-04-01');
    expect(rangeFor('thisFy', Date.parse('2026-03-31T18:30:00Z')).from).toBe('2026-04-01');
    expect(rangeFor('lastMonth', Date.parse('2026-01-10T00:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(rangeFor('thisMonth', Date.parse('2028-02-10T00:00:00Z')).to).toBe('2028-02-29');
  });
});

describe('status helpers', () => {
  it('paymentState', () => {
    expect(paymentState(69000, 0)).toBe('unpaid');
    expect(paymentState(69000, 30000)).toBe('part');
    expect(paymentState(69000, 69000)).toBe('paid');
    expect(paymentState(69000, 70000)).toBe('paid');
    expect(paymentState(0, 0)).toBe('paid');
    expect(paymentState(69000, -1000)).toBe('refunded');
  });
});

describe('chart maths', () => {
  it('niceMax', () => {
    expect(niceMax(0)).toBe(0);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(6)).toBe(10);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.2)).toBe(2);
    expect(niceMax(2.2)).toBe(2.5);
    expect(niceMax(3980000)).toBe(5000000);
    expect(niceMax(2000)).toBe(2000);
  });

  it('labels thin out and never crowd the last one', () => {
    expect(labelStep(12, 6)).toBe(2);
    expect(labelStep(30, 6)).toBe(5);
    expect(labelStep(5, 14)).toBe(1);
    expect([...visibleLabels(12, 2)].sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8, 11]);
    expect([...visibleLabels(30, 5)].sort((a, b) => a - b)).toEqual([0, 5, 10, 15, 20, 25, 29]);
    expect([...visibleLabels(31, 6)].sort((a, b) => a - b)).toEqual([0, 6, 12, 18, 24, 30]);
    expect([...visibleLabels(4, 1)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect([...visibleLabels(0, 3)]).toEqual([]);
  });

  it('bars scale to the nice top; small values stay visible; negatives draw as 0', () => {
    const r = bars([0, 50, 100, 0.001, -5], { slot: 10, gap: 2, height: 100, minH: 1 });
    expect(r.max).toBe(100);
    expect(r.width).toBe(50);
    expect(r.bars[0]).toEqual({ x: 1, y: 100, w: 8, h: 0 });
    expect(r.bars[1].h).toBe(50);
    expect(r.bars[2]).toEqual({ x: 21, y: 0, w: 8, h: 100 });
    expect(r.bars[3].h).toBe(1);
    expect(r.bars[4].h).toBe(0);
    expect(bars([0, 0]).max).toBe(0);
  });
});
