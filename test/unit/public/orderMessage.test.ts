// src/lib/orderMessage.ts: the WhatsApp order text (contract 5) and the admin's paste parser. They must round-trip.
import { describe, expect, it } from 'vitest';
import {
  buildGiftMessage, buildOrderMessage, dayLabel, giftEstimate, istDate, messageTotal, parseOrderMessage, type MessageLine,
} from '../../../src/lib/orderMessage';

const CONTRACT = [
  "Hi Beezy Honey! I'd like to order (Order BZ-7K3QD):",
  '1. Murungai Honey with comb – 250 g × 2 – ₹620',
  '2. Honey Sticks – Box of 10 (100 g) × 1 – ₹70',
  'Total: ₹690 (prices as on 15 Nov 2026)',
  'Please confirm delivery charges and payment details.',
].join('\n');

const two: MessageLine[] = [
  { name: 'Murungai Honey with comb', pack: '250 g', qty: 2, unitPaise: 31000 },
  { name: 'Honey Sticks', pack: 'Box of 10 (100 g)', qty: 1, unitPaise: 7000 },
];

describe('buildOrderMessage', () => {
  it('writes exactly the agreed message', () => {
    expect(buildOrderMessage({ ref: 'BZ-7K3QD', lines: two, showPrices: true, pricesOn: '2026-11-15' })).toBe(CONTRACT);
  });
  it('says "price please" and "Total so far" when a pack has no price', () => {
    const text = buildOrderMessage({
      ref: 'BZ-7K3QD', showPrices: true, pricesOn: '2026-11-15',
      lines: [...two, { name: 'Litchi Honey', pack: '250 g', qty: 3, unitPaise: null }],
    });
    expect(text).toBe([
      "Hi Beezy Honey! I'd like to order (Order BZ-7K3QD):",
      '1. Murungai Honey with comb – 250 g × 2 – ₹620',
      '2. Honey Sticks – Box of 10 (100 g) × 1 – ₹70',
      '3. Litchi Honey – 250 g × 3 – price please',
      'Total so far: ₹690 (prices as on 15 Nov 2026)',
      'Please confirm delivery charges and payment details.',
    ].join('\n'));
  });
  it('leaves the total out when nothing has a price', () => {
    const text = buildOrderMessage({ ref: 'BZ-7K3QD', showPrices: true, pricesOn: '2026-11-15', lines: [{ name: 'Litchi Honey', pack: '100 g', qty: 1, unitPaise: null }] });
    expect(text).toBe("Hi Beezy Honey! I'd like to order (Order BZ-7K3QD):\n1. Litchi Honey – 100 g × 1 – price please\nPlease confirm delivery charges and payment details.");
  });
  it('keeps the old wording plus the order code when prices are hidden', () => {
    expect(buildOrderMessage({ ref: 'BZ-7K3QD', lines: two, showPrices: false })).toBe([
      "Hi Beezy Honey! I'd like to order (Order BZ-7K3QD):",
      '1. Murungai Honey with comb – 250 g × 2',
      '2. Honey Sticks – Box of 10 (100 g) × 1',
      '',
      'Please share the price and delivery details.',
    ].join('\n'));
  });
  it('formats big totals in lakh', () => {
    const text = buildOrderMessage({ ref: 'BZ-AAAAA', showPrices: true, pricesOn: '2026-01-02', lines: [{ name: 'Dammar Honey', pack: '500 g', qty: 99, unitPaise: 180000 }] });
    expect(text).toContain('1. Dammar Honey – 500 g × 99 – ₹1,78,200');
    expect(text).toContain('Total: ₹1,78,200 (prices as on 2 Jan 2026)');
  });
  it('dates the prices with the India date', () => {
    expect(istDate(new Date('2026-11-14T18:29:59Z'))).toBe('2026-11-14');
    expect(istDate(new Date('2026-11-14T18:30:00Z'))).toBe('2026-11-15');
    expect(dayLabel('2026-09-05')).toBe('5 Sep 2026');
    expect(() => dayLabel('2026-13-01')).toThrow();
    const text = buildOrderMessage({ ref: 'BZ-7K3QD', lines: two, showPrices: true, pricesOn: new Date('2026-03-31T19:00:00Z') });
    expect(text).toContain('(prices as on 1 Apr 2026)');
  });
  it('messageTotal', () => {
    expect(messageTotal(two)).toEqual({ totalPaise: 69000, priced: 2, complete: true });
    expect(messageTotal([...two, { name: 'x', pack: 'y', qty: 1, unitPaise: null }])).toEqual({ totalPaise: 69000, priced: 2, complete: false });
  });
});

describe('parseOrderMessage', () => {
  it('reads the agreed message', () => {
    const p = parseOrderMessage(CONTRACT)!;
    expect(p.kind).toBe('order');
    expect(p.ref).toBe('BZ-7K3QD');
    expect(p.showPrices).toBe(true);
    expect(p.totalPaise).toBe(69000);
    expect(p.totalSoFar).toBe(false);
    expect(p.pricesOn).toBe('2026-11-15');
    expect(p.lines).toEqual([
      { name: 'Murungai Honey with comb', pack: '250 g', qty: 2, unitPaise: 31000, linePaise: 62000, pricePlease: false },
      { name: 'Honey Sticks', pack: 'Box of 10 (100 g)', qty: 1, unitPaise: 7000, linePaise: 7000, pricePlease: false },
    ]);
  });

  const cases: { name: string; lines: MessageLine[]; showPrices: boolean }[] = [
    { name: 'contract', lines: two, showPrices: true },
    { name: 'price please', lines: [...two, { name: 'Tulasi Honey', pack: '100 g', qty: 4, unitPaise: null }], showPrices: true },
    { name: 'only price please', lines: [{ name: 'Karanji Honey', pack: '500 g', qty: 1, unitPaise: null }], showPrices: true },
    { name: 'prices hidden', lines: two, showPrices: false },
    { name: 'candles', lines: [{ name: 'Beeswax Candles', pack: 'Small', qty: 12, unitPaise: 8000 }, { name: 'Beeswax Candles', pack: 'Large', qty: 1, unitPaise: 18000 }], showPrices: true },
    { name: 'paise and lakh', lines: [{ name: 'Neela Kurinji Honey', pack: '500 g', qty: 99, unitPaise: 110050 }, { name: 'Honey Sticks', pack: '1 stick', qty: 7, unitPaise: 700 }], showPrices: true },
    { name: 'many lines', lines: Array.from({ length: 30 }, (_, i) => ({ name: `Honey ${i}`, pack: `${i + 1}00 g`, qty: (i % 99) + 1, unitPaise: i % 3 ? 1000 * i : null })), showPrices: true },
  ];
  for (const c of cases) {
    it(`round-trips: ${c.name}`, () => {
      const text = buildOrderMessage({ ref: 'BZ-HJ9WX', lines: c.lines, showPrices: c.showPrices, pricesOn: '2026-11-15' });
      const p = parseOrderMessage(text)!;
      expect(p.ref).toBe('BZ-HJ9WX');
      expect(p.showPrices).toBe(c.showPrices);
      const lines = p.lines.map(({ name, pack, qty, unitPaise }) => ({ name, pack, qty, unitPaise }));
      expect(lines).toEqual(c.lines.map((l) => ({ ...l, unitPaise: c.showPrices ? l.unitPaise : null })));
      expect(buildOrderMessage({ ref: p.ref!, lines, showPrices: p.showPrices, pricesOn: p.pricesOn ?? undefined })).toBe(text);
    });
  }

  it('reads "price please" lines and "Total so far"', () => {
    const p = parseOrderMessage(buildOrderMessage({ ref: 'BZ-7K3QD', showPrices: true, pricesOn: '2026-11-15', lines: [...two, { name: 'Litchi Honey', pack: '250 g', qty: 3, unitPaise: null }] }))!;
    expect(p.lines[2]).toEqual({ name: 'Litchi Honey', pack: '250 g', qty: 3, unitPaise: null, linePaise: null, pricePlease: true });
    expect(p.totalSoFar).toBe(true);
    expect(p.totalPaise).toBe(69000);
  });

  it('forgives edits made in WhatsApp', () => {
    const edited = [
      'hi beezy honey! I’d like to order (order bz-7k3qd):',
      '1) Murungai Honey with comb - 250 g x 2 - Rs. 620',
      '2.  Honey Sticks — Box of 10 (100 g) X 1 — ₹70  ',
      'total: ₹690',
      '',
      'Please deliver fast!',
    ].join('\r\n');
    const p = parseOrderMessage(edited)!;
    expect(p.ref).toBe('BZ-7K3QD');
    expect(p.lines.map((l) => [l.name, l.pack, l.qty, l.linePaise])).toEqual([
      ['Murungai Honey with comb', '250 g', 2, 62000],
      ['Honey Sticks', 'Box of 10 (100 g)', 1, 7000],
    ]);
    expect(p.totalPaise).toBe(69000);
    expect(p.pricesOn).toBeNull();
  });

  it('reads the old message without an order code', () => {
    const old = "Hi Beezy Honey! I'd like to order:\n1. Forest Honey with comb – 100 g × 3\n\nPlease share the price and delivery details.";
    const p = parseOrderMessage(old)!;
    expect(p.ref).toBeNull();
    expect(p.showPrices).toBe(false);
    expect(p.lines).toEqual([{ name: 'Forest Honey with comb', pack: '100 g', qty: 3, unitPaise: null, linePaise: null, pricePlease: false }]);
  });

  it('keeps an amount that does not divide by the quantity as the line amount only', () => {
    const p = parseOrderMessage("Hi Beezy Honey! I'd like to order (Order BZ-7K3QD):\n1. Murungai Honey – 250 g × 3 – ₹100")!;
    expect(p.lines[0].linePaise).toBe(10000);
    expect(p.lines[0].unitPaise).toBeNull();
  });

  it('ignores a broken code and returns null for text without an order', () => {
    expect(parseOrderMessage("Hi Beezy Honey! I'd like to order (Order BZ-0O0O0):\n1. A – 100 g × 1")!.ref).toBeNull();
    expect(parseOrderMessage('Hi Beezy Honey! I have a question about your honey.')).toBeNull();
    expect(parseOrderMessage('')).toBeNull();
    expect(parseOrderMessage(42 as unknown as string)).toBeNull();
  });
});

describe('gift box message', () => {
  const base = {
    ref: 'BZ-7K3QD', size: 3, jar: '100 g', boxes: 10, bulk: false, feePaise: 0,
    picks: [{ name: 'Murungai Honey with comb', unitPaise: 14000 }, { name: 'Litchi Honey', unitPaise: null }, { name: 'Forest Honey with comb', unitPaise: 18000 }],
    extras: [{ name: 'Beeswax candle', unitPaise: 8000 }, { name: 'Honey sticks', unitPaise: null }],
    occasion: 'Wedding return gift', neededBy: '20 Dec 2026', card: 'Thank you!', pricesOn: '2026-11-15',
  };
  it('keeps the old wording plus the code when prices are hidden', () => {
    expect(buildGiftMessage({ ...base, showPrices: false })).toBe([
      "Hi Beezy Honey! I'd like to order gift boxes (Order BZ-7K3QD).", '',
      'Each box: 3 honeys, 100 g each',
      '1. Murungai Honey with comb', '2. Litchi Honey', '3. Forest Honey with comb',
      'Extras in each box: Beeswax candle, Honey sticks',
      'Number of boxes: 10',
      'Occasion: Wedding return gift',
      'Needed by: 20 Dec 2026',
      'Message on the card: "Thank you!"', '',
      'Please share the price and delivery details.',
    ].join('\n'));
  });
  it('adds prices, the box fee, a per-box price and the estimate', () => {
    expect(buildGiftMessage({ ...base, showPrices: true, feePaise: 2000 })).toBe([
      "Hi Beezy Honey! I'd like to order gift boxes (Order BZ-7K3QD).", '',
      'Each box: 3 honeys, 100 g each',
      '1. Murungai Honey with comb – ₹140', '2. Litchi Honey – price please', '3. Forest Honey with comb – ₹180',
      'Extras in each box: Beeswax candle (₹80), Honey sticks (price please)',
      'Box fee: ₹20',
      'Per box: ₹420 so far',
      'Number of boxes: 10',
      'Estimated total: ₹4,200 so far (prices as on 15 Nov 2026)',
      'Occasion: Wedding return gift',
      'Needed by: 20 Dec 2026',
      'Message on the card: "Thank you!"', '',
      'Please confirm delivery charges and payment details.',
    ].join('\n'));
  });
  it('says the bulk price is confirmed on WhatsApp', () => {
    const text = buildGiftMessage({ ...base, showPrices: true, boxes: 40, bulk: true });
    expect(text).toContain('Estimated total: bulk price confirmed on WhatsApp');
    expect(text).not.toMatch(/Estimated total: ₹/);
  });
  it('giftEstimate', () => {
    expect(giftEstimate({ ...base, feePaise: 2000 })).toEqual({ perBoxPaise: 42000, totalPaise: 420000, complete: false });
    expect(giftEstimate({ ...base, bulk: true })).toEqual({ perBoxPaise: 40000, totalPaise: null, complete: false });
    expect(giftEstimate({ picks: [{ name: 'a', unitPaise: null }], extras: [], feePaise: 0, boxes: 2, bulk: false })).toEqual({ perBoxPaise: null, totalPaise: null, complete: false });
    expect(giftEstimate({ picks: [{ name: 'a', unitPaise: 100 }], extras: [], feePaise: 0, boxes: 2, bulk: false })).toEqual({ perBoxPaise: 100, totalPaise: 200, complete: true });
  });
  it('the paste parser reads gift messages', () => {
    const p = parseOrderMessage(buildGiftMessage({ ...base, showPrices: true, feePaise: 2000 }))!;
    expect(p.kind).toBe('gift');
    expect(p.ref).toBe('BZ-7K3QD');
    expect(p.showPrices).toBe(true);
    expect(p.totalPaise).toBe(420000);
    expect(p.totalSoFar).toBe(true);
    expect(p.pricesOn).toBe('2026-11-15');
    expect(p.gift).toEqual({
      size: 3, jar: '100 g', boxes: 10, picks: ['Murungai Honey with comb', 'Litchi Honey', 'Forest Honey with comb'],
      extras: ['Beeswax candle', 'Honey sticks'], perBoxPaise: 42000, feePaise: 2000, bulk: false,
      occasion: 'Wedding return gift', neededBy: '20 Dec 2026', card: 'Thank you!',
    });
    expect(p.lines[0]).toEqual({ name: 'Murungai Honey with comb', pack: '100 g', qty: 10, unitPaise: 14000, linePaise: 140000, pricePlease: false });
    expect(p.lines[1].pricePlease).toBe(true);
    const plain = parseOrderMessage(buildGiftMessage({ ...base, showPrices: false }))!;
    expect(plain.showPrices).toBe(false);
    expect(plain.gift!.picks).toHaveLength(3);
    expect(plain.gift!.extras).toEqual(['Beeswax candle', 'Honey sticks']);
    const bulk = parseOrderMessage(buildGiftMessage({ ...base, showPrices: true, boxes: 40, bulk: true }))!;
    expect(bulk.gift!.bulk).toBe(true);
    expect(bulk.totalPaise).toBeNull();
  });
});
