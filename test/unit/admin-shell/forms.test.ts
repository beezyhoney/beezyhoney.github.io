import { describe, expect, it } from 'vitest';
import {
  cleanText, formReader, isIsoDay, newFormKey, parseGramsText, parseIntText, parsePaiseText, readForm, textLength,
} from '../../../src/admin/forms';

const fd = (pairs: [string, string][]) => {
  const d = new FormData();
  for (const [k, v] of pairs) d.append(k, v);
  return d;
};
const reader = (pairs: [string, string][]) => formReader(fd(pairs));

describe('parsers', () => {
  it('cleanText trims, drops control characters, keeps or flattens line breaks', () => {
    expect(cleanText('  Murungai\u0000 Honey ​ ')).toBe('Murungai Honey');
    expect(cleanText('a\r\nb')).toBe('a b');
    expect(cleanText('a\r\nb', true)).toBe('a\nb');
    expect(cleanText('a\n\n\n\nb  \n', true)).toBe('a\n\nb');
    expect(cleanText('tab\there')).toBe('tab here');
    expect(cleanText('café')).toBe('café'); // NFC
  });

  it('textLength counts code points (₹ and Tamil letters once)', () => {
    expect(textLength('₹310')).toBe(4);
    expect(textLength('தேன்')).toBe(4);
  });

  it('parseIntText accepts whole numbers with grouping, refuses the rest', () => {
    expect(parseIntText('12')).toBe(12);
    expect(parseIntText(' 1,200 ')).toBe(1200);
    expect(parseIntText('1,05,000')).toBe(105000);
    expect(parseIntText('−3')).toBe(-3);
    expect(parseIntText('-0')).toBe(0);
    for (const bad of ['', '1.5', '1e3', '0x10', 'abc', '12abc', '9999999999999999', '--1']) expect(parseIntText(bad)).toBeNull();
  });

  it('parsePaiseText reads rupees the shared way', () => {
    expect(parsePaiseText('₹1,050.50')).toBe(105050);
    expect(parsePaiseText('1050.5')).toBe(105050);
    expect(parsePaiseText('Rs. 1,05,000')).toBe(10500000);
    expect(parsePaiseText('350')).toBe(35000);
    expect(parsePaiseText('₹ 500')).toBe(50000);
    expect(parsePaiseText('-₹50')).toBe(-5000);
    for (const bad of ['35O', '1.234', '1,0,0', 'abc', '']) expect(parsePaiseText(bad)).toBeNull();
  });

  it('parseGramsText: kg by default, grams with a unit, exact grams', () => {
    expect(parseGramsText('99.5')).toBe(99500);
    expect(parseGramsText('0.25')).toBe(250);
    expect(parseGramsText('.5')).toBe(500);
    expect(parseGramsText('2')).toBe(2000);
    expect(parseGramsText('99.')).toBe(99000);
    expect(parseGramsText('1,000')).toBe(1_000_000);
    expect(parseGramsText('99.555')).toBe(99555);
    expect(parseGramsText('500 g')).toBe(500);
    expect(parseGramsText('500gm')).toBe(500);
    expect(parseGramsText('500 grams')).toBe(500);
    expect(parseGramsText('1.5 kg')).toBe(1500);
    expect(parseGramsText('1.5KGS')).toBe(1500);
    expect(parseGramsText('2 kilograms')).toBe(2000);
    expect(parseGramsText('-1.25')).toBe(-1250);
    expect(parseGramsText('−250 g')).toBe(-250);
    expect(parseGramsText('250', 'g')).toBe(250);
    for (const bad of ['', 'kg', 'lots', '1.2345', '1.5 g', '1e3', '2 lb', '--2']) expect(parseGramsText(bad)).toBeNull();
  });

  it('isIsoDay accepts only real calendar days', () => {
    expect(isIsoDay('2026-11-15')).toBe(true);
    expect(isIsoDay('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-1-5', '15/11/2026', '']) expect(isIsoDay(bad)).toBe(false);
  });

  it('newFormKey makes a UUID that key() accepts', () => {
    const k = newFormKey();
    expect(reader([['_key', k]]).key()).toBe(k);
    expect(reader([['_key', 'not-a-uuid']]).key()).toBeNull();
  });
});

describe('formReader', () => {
  it('text: required, max, min, pattern, multiline', () => {
    const f = reader([['name', '  Murungai Honey  '], ['empty', '   '], ['long', 'x'.repeat(61)], ['code', 'MURU1'], ['about', 'a\r\nb']]);
    expect(f.text('name', { required: true, max: 60 })).toBe('Murungai Honey');
    expect(f.text('empty', { required: true })).toBe('');
    expect(f.errors.empty).toEqual({ key: 'form.required' });
    f.text('long', { max: 60 });
    expect(f.errors.long).toEqual({ key: 'form.tooLong', vars: { max: 60 } });
    f.text('code', { pattern: /^[A-Z]{2,4}$/ });
    expect(f.errors.code.key).toBe('form.badFormat');
    expect(f.text('about', { multiline: true })).toBe('a\nb');
    expect(f.optText('missing')).toBeNull();
    expect(f.ok).toBe(false);
    expect(f.messages().long).toBe('Please keep it to 60 characters or fewer.');
  });

  it('a missing optional field is no error', () => {
    const f = reader([]);
    expect(f.text('a')).toBe('');
    expect(f.int('b')).toBeNull();
    expect(f.paise('c')).toBeNull();
    expect(f.grams('d')).toBeNull();
    expect(f.date('e')).toBeNull();
    expect(f.month('m')).toBeNull();
    expect(f.choice('g', ['x'])).toBeNull();
    expect(f.ok).toBe(true);
  });

  it('int: range and wrong input', () => {
    const f = reader([['qty', '3'], ['zero', '0'], ['big', '120'], ['bad', '2.5'], ['neg', '-1']]);
    expect(f.int('qty', { min: 1, max: 99 })).toBe(3);
    expect(f.int('zero', { min: 1, max: 99 })).toBeNull();
    expect(f.errors.zero).toEqual({ key: 'form.tooSmall', vars: { min: '1' } });
    expect(f.int('big', { max: 99 })).toBeNull();
    expect(f.errors.big).toEqual({ key: 'form.tooBig', vars: { max: '99' } });
    expect(f.int('bad')).toBeNull();
    expect(f.errors.bad.key).toBe('form.notNumber');
    expect(f.int('neg', { min: 0 })).toBeNull();
    expect(f.errors.neg.key).toBe('form.negative');
    expect(f.int('missing', { required: true })).toBeNull();
    expect(f.errors.missing.key).toBe('form.required');
  });

  it('ints: repeated fields, empty ones skipped', () => {
    const f = reader([['id', '3'], ['id', ''], ['id', '7'], ['id', 'x']]);
    expect(f.ints('id', { min: 1 })).toEqual([3, 7]);
    expect(f.errors.id.key).toBe('form.notNumber');
  });

  it('paise: rupees to paise with limits, negatives only when allowed', () => {
    const f = reader([['price', '₹1,050.50'], ['low', '0.50'], ['neg', '-50'], ['refund', '-50'], ['zero', '0'], ['huge', '2,00,00,000'], ['bad', '35O']]);
    expect(f.paise('price', { min: 100 })).toBe(105050);
    expect(f.paise('low', { min: 100 })).toBeNull();
    expect(f.messages().low).toBe('The smallest allowed is ₹1.');
    expect(f.paise('neg')).toBeNull();
    expect(f.errors.neg.key).toBe('form.negative');
    expect(f.paise('refund', { allowNegative: true })).toBe(-5000);
    expect(f.paise('zero', { nonZero: true })).toBeNull();
    expect(f.errors.zero.key).toBe('form.zero');
    expect(f.paise('huge')).toBeNull();
    expect(f.messages().huge).toBe('The largest allowed is ₹1,00,00,000.');
    expect(f.paise('bad')).toBeNull();
    expect(f.messages().bad).toBe('Please type an amount in rupees, like 350 or 1,050.50.');
  });

  it('grams: kg to grams with limits', () => {
    const f = reader([['stock', '99.5'], ['g', '500 g'], ['neg', '-2'], ['adj', '-2'], ['bad', 'lots'], ['over', '2000']]);
    expect(f.grams('stock')).toBe(99500);
    expect(f.grams('g')).toBe(500);
    expect(f.grams('neg')).toBeNull();
    expect(f.errors.neg.key).toBe('form.negative');
    expect(f.grams('adj', { allowNegative: true })).toBe(-2000);
    expect(f.grams('bad')).toBeNull();
    expect(f.errors.bad.key).toBe('form.notWeight');
    expect(f.grams('over')).toBeNull();
    expect(f.messages().over).toBe('The largest allowed is 1,000.0 kg.');
  });

  it('bool: toggle pattern (hidden 0 then checkbox 1), last value wins', () => {
    expect(reader([['show', '0'], ['show', '1']]).bool('show')).toBe(true);
    expect(reader([['show', '0']]).bool('show')).toBe(false);
    expect(reader([['show', 'on']]).bool('show')).toBe(true);
    expect(reader([['show', 'yes']]).bool('show')).toBe(true);
    expect(reader([]).bool('show')).toBe(false);
    expect(reader([['show', 'maybe']]).bool('show')).toBe(false);
  });

  it('date and month', () => {
    const f = reader([['d', '2026-11-15'], ['bad', '2026-02-30'], ['early', '2026-01-01'], ['m', '2028-11'], ['badm', '2028-13']]);
    expect(f.date('d', { min: '2026-04-01', max: '2027-03-31' })).toBe('2026-11-15');
    expect(f.date('bad')).toBeNull();
    expect(f.errors.bad.key).toBe('form.notDate');
    expect(f.date('early', { min: '2026-04-01' })).toBeNull();
    expect(f.messages().early).toBe('Please pick 1 Apr 2026 or later.');
    expect(f.month('m')).toBe('2028-11');
    expect(f.month('badm')).toBeNull();
    expect(f.errors.badm.key).toBe('form.notMonth');
  });

  it('choice, choices and action', () => {
    const f = reader([['method', 'upi'], ['bad', 'cheque'], ['tag', 'a'], ['tag', 'zz'], ['tag', 'a'], ['tag', 'b'], ['_action', 'save'], ['_action', 'confirm']]);
    expect(f.choice('method', ['upi', 'cash'] as const)).toBe('upi');
    expect(f.choice('bad', ['upi', 'cash'] as const)).toBeNull();
    expect(f.errors.bad.key).toBe('form.notChoice');
    expect(f.choices('tag', ['a', 'b'] as const)).toEqual(['a', 'b']);
    // the pressed button comes last in tree order, so the last allowed _action wins
    expect(f.action(['save', 'confirm'] as const)).toBe('confirm');
    expect(f.action(['save'] as const)).toBe('save');
    expect(f.action(['delete'] as const)).toBeNull();
  });

  it('version, raw, has, fail', () => {
    const f = reader([['version', '7'], ['price', ' 35O ']]);
    expect(f.version()).toBe(7);
    expect(reader([['version', '0']]).version()).toBeNull();
    expect(reader([['version', 'x']]).version()).toBeNull();
    expect(f.raw('price')).toBe(' 35O ');
    expect(f.raw('none')).toBe('');
    expect(f.has('price')).toBe(true);
    expect(f.has('none')).toBe(false);
    f.fail('price', 'form.badFormat');
    f.fail('price', 'form.required'); // the first error per field stays
    expect(f.errors.price.key).toBe('form.badFormat');
  });

  it('failText and takeFailure put server words on a field', () => {
    const f = reader([['price', '35']]);
    f.failText('price', '  Price is below ₹10.\n Please check. ');
    f.failText('price', 'second'); // the first error per field stays
    expect(f.ok).toBe(false);
    expect(f.messages()).toEqual({ price: 'Price is below ₹10. Please check.' });

    const g = reader([['mrp', '']]);
    const failure = { ok: false as const, error: 'invalid', message: 'MRP must be at least the price.', field: 'mrp' };
    expect(g.takeFailure(failure, ['price', 'mrp'])).toBe(true);
    expect(g.messages()).toEqual({ mrp: 'MRP must be at least the price.' });
    // no field, or a field this form does not show → the caller flashes it instead
    expect(g.takeFailure({ ok: false, error: 'conflict', message: 'Changed meanwhile.' }, ['mrp'])).toBe(false);
    expect(g.takeFailure({ ok: false, error: 'invalid', message: 'x', field: 'slug' }, ['mrp'])).toBe(false);
    expect(Object.keys(g.errors)).toEqual(['mrp']);
  });

  it('ignores File values and reads URLSearchParams', () => {
    const d = new FormData();
    d.append('photo', new Blob(['x'], { type: 'image/jpeg' }), 'a.jpg');
    expect(formReader(d).raw('photo')).toBe('');
    expect(formReader(new URLSearchParams('a=1&a=2')).rawAll('a')).toEqual(['1', '2']);
  });
});

describe('readForm', () => {
  const post = (body: BodyInit, type: string, headers: Record<string, string> = {}) =>
    new Request('http://127.0.0.1/admin/', { method: 'POST', body, headers: { 'content-type': type, ...headers } });

  it('reads urlencoded and multipart posts', async () => {
    const a = await readForm(post('name=Murungai+Honey&price=%E2%82%B9310', 'application/x-www-form-urlencoded'));
    expect(a?.text('name')).toBe('Murungai Honey');
    expect(a?.paise('price')).toBe(31000);
    const m = new FormData();
    m.append('qty', '2');
    const b = await readForm(new Request('http://127.0.0.1/admin/', { method: 'POST', body: m }));
    expect(b?.int('qty')).toBe(2);
  });

  it('returns null for GET, non-form types and bodies over the limit', async () => {
    expect(await readForm(new Request('http://127.0.0.1/admin/'))).toBeNull();
    expect(await readForm(post('{"a":1}', 'application/json'))).toBeNull();
    expect(await readForm(post('a=1', 'text/plain'))).toBeNull();
    expect(await readForm(post(`a=${'x'.repeat(2000)}`, 'application/x-www-form-urlencoded'), { maxBytes: 1000 })).toBeNull();
    expect(await readForm(post('a=1', 'application/x-www-form-urlencoded', { 'content-length': '999999' }))).toBeNull();
  });
});
