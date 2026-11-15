// The self-written QR encoder (src/admin/catalog/qr.ts). The golden matrices below were made with the widely used
// `qrcode` npm package (same text, level, version and mask) in a scratch folder, and the same symbols were decoded
// back with jsQR there; neither package is a dependency of this repo.
import { describe, expect, test } from 'vitest';
import { alignmentPositions, dataCodewords, encodeQr, formatBits, qrPath, qrSvg, rawDataModules, rsRemainder, rsDivisor } from '../../../src/admin/catalog/qr';
import { isCompact, knowYourJarUrl, labelBatch, layoutSheet, presetById, saveLabelMrp, SHEET_PRESETS, stickerText } from '../../../src/server/labels';
import { createBatch } from '../../../src/server/stock';
import { HELPER, OWNER, freshDb, row, rows, t, variantId } from '../../helpers/db';

const GOLDEN = [
  { text: 'https://beezyhoney.in/know-your-jar/?batch=MUR-2611-01', ecc: 'M', version: 4, mask: 2, size: 33 },
  { text: 'HELLO WORLD', ecc: 'Q', version: 1, mask: 7, size: 21 },
  { text: `https://beezyhoney.in/know-your-jar/?batch=NKH-2612-12&x=${'y'.repeat(60)}`, ecc: 'M', version: 7, mask: 1, size: 45 },
] as const;
// rows as hex, padded to whole nibbles (from the qrcode package)
import golden from './qr-golden.json';

const toHexRows = (m: boolean[][]) => m.map((row) => {
  const bits = row.map((b) => (b ? '1' : '0')).join('').padEnd(Math.ceil(row.length / 4) * 4, '0');
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
});

describe('QR encoder', () => {
  test('table values', () => {
    expect(rawDataModules(1)).toBe(208);
    expect(rawDataModules(7)).toBe(1568);
    expect(dataCodewords(1, 'L')).toBe(19);
    expect(dataCodewords(4, 'M')).toBe(64);
    expect(dataCodewords(10, 'H')).toBe(122);
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(formatBits('M', 0)).toBe(0x5412);
    expect(formatBits('L', 0)).toBe(0x77c4);
  });

  test('Reed–Solomon: the classic "01234567" 1-M example', () => {
    // data codewords of 01234567 at 1-M (from the standard's worked example)
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });

  test('matches the golden symbols module for module (versions 1, 4, 7; levels M and Q)', () => {
    for (const g of GOLDEN) {
      const q = encodeQr(g.text, { ecc: g.ecc, mask: g.mask });
      expect(q.version, g.text).toBe(g.version);
      expect(q.size).toBe(g.size);
      const ref = (golden as { text: string; rows: string[] }[]).find((x) => x.text === g.text)!;
      expect(toHexRows(q.modules)).toEqual(ref.rows);
    }
  });

  test('the Know Your Jar link fits a small symbol; automatic mask choice; SVG output', () => {
    const url = knowYourJarUrl('MUR-2611-01');
    expect(url).toBe('https://beezyhoney.in/know-your-jar/?batch=MUR-2611-01');
    const q = encodeQr(url);
    expect(q.version).toBe(4);
    expect(q.mask).toBeGreaterThanOrEqual(0);
    expect(qrPath(q)).toMatch(/^M4 4h7v1h-7z/); // top-left finder starts at the quiet zone
    const svg = qrSvg(url, { title: 'Batch MUR-2611-01' });
    expect(svg).toContain('viewBox="0 0 41 41"');
    expect(svg).toContain('aria-label="Batch MUR-2611-01"');
    expect(() => encodeQr('x'.repeat(400))).toThrow(RangeError);
  });
});

describe('label sheet layout', () => {
  test('skips used stickers, spills onto more sheets, positions in mm', () => {
    const p = presetById('a4-21');
    const one = layoutSheet(p, 18, 3);
    expect(one.pages).toBe(1);
    expect(one.cells.filter((c) => c.kind === 'used').map((c) => c.index)).toEqual([0, 1, 2]);
    expect(one.cells.filter((c) => c.kind === 'label')).toHaveLength(18);
    expect(one.cells[3]).toMatchObject({ row: 1, col: 0, x: 7.25, y: 15.15 + 38.1 });
    const two = layoutSheet(p, 30, 5);
    expect(two.pages).toBe(2);
    expect(two.cells.filter((c) => c.kind === 'label')).toHaveLength(30);
    expect(presetById('nope').id).toBe('a4-65'); // the owner's sheet is the default (16 Nov 2026)
    for (const s of SHEET_PRESETS) {
      // every sticker fits on the page
      expect(s.left + (s.cols - 1) * s.pitchX + s.labelW, s.id).toBeLessThanOrEqual(s.pageW + 0.01);
      expect(s.top + (s.rows - 1) * s.pitchY + s.labelH, s.id).toBeLessThanOrEqual(s.pageH + 0.01);
    }
  });

  test('the default sheet is A4 with 65 stickers of 38.1 × 21.2 mm (5 × 13), centred on the page', () => {
    const p = presetById(null);
    expect(SHEET_PRESETS[0]).toBe(p);
    expect(p).toMatchObject({ id: 'a4-65', pageW: 210, pageH: 297, cols: 5, rows: 13, labelW: 38.1, labelH: 21.2 });
    expect(isCompact(p)).toBe(true);
    expect(isCompact(presetById('a4-21'))).toBe(false);
    const sheet = layoutSheet(p, 65);
    expect(sheet.pages).toBe(1);
    expect(sheet.cells.filter((c) => c.kind === 'label')).toHaveLength(65);
    const last = sheet.cells[64];
    expect(p.pageW - (last.x + p.labelW)).toBeCloseTo(p.left, 5); // same margin left and right
    expect(p.pageH - (last.y + p.labelH)).toBeCloseTo(p.top, 5);   // and top and bottom
    expect(layoutSheet(p, 70, 10).pages).toBe(2);
  });
});

describe('label MRP per batch and pack (owner decision 16 Nov 2026: MRP printed on the batch stickers)', () => {
  test('saved per batch and pack, suggested from the pack until saved, kept after a price change, never below the price', async () => {
    const db = await freshDb();
    const pid = (await row<{ id: number }>(db, "SELECT id FROM products WHERE slug = 'murungai-honey'")).id;
    const b = await createBatch(db, OWNER, { productId: pid, harvestedLabel: 'October 2026', packedOn: '2026-11-01', bestBefore: '2028-10' }, t(0));
    if (!b.ok) throw new Error(b.message);
    const v250 = await variantId(db, 'murungai-honey:250g');
    let lb = (await labelBatch(db, b.value.id))!;
    let p = lb.packs.find((x) => x.variantId === v250)!;
    expect(p).toMatchObject({ savedMrpPaise: null, defaultMrpPaise: 31000 }); // the pack's price (no MRP set)
    expect(await saveLabelMrp(db, OWNER, { batchId: b.value.id, variantId: v250, mrpPaise: 32000 }, t(1))).toEqual({ ok: true, value: { mrpPaise: 32000, changed: true } });
    expect(await saveLabelMrp(db, HELPER, { batchId: b.value.id, variantId: v250, mrpPaise: 32000 }, t(2))).toEqual({ ok: true, value: { mrpPaise: 32000, changed: false } });
    // the catalog price goes up later: the batch's stickers still print the saved MRP
    await db.prepare('UPDATE variants SET price_paise = 33000 WHERE id = ?').bind(v250).run();
    lb = (await labelBatch(db, b.value.id))!;
    p = lb.packs.find((x) => x.variantId === v250)!;
    expect(p).toMatchObject({ savedMrpPaise: 32000, defaultMrpPaise: 32000 });
    expect(stickerText(lb, p, { mrpPaise: p.defaultMrpPaise, qr: false })).toMatchObject({ mrp: 32000, per100: 12800 });
    // a new MRP below today's price is refused; another product's pack is not found
    expect(await saveLabelMrp(db, OWNER, { batchId: b.value.id, variantId: v250, mrpPaise: 32500 }, t(3))).toMatchObject({ ok: false, error: 'invalid', field: 'mrp' });
    expect(await saveLabelMrp(db, OWNER, { batchId: b.value.id, variantId: await variantId(db, 'kombu-honey:250g'), mrpPaise: 50000 }, t(3))).toMatchObject({ ok: false, error: 'not_found' });
    expect(await saveLabelMrp(db, OWNER, { batchId: b.value.id, variantId: v250, mrpPaise: 50 }, t(3))).toMatchObject({ ok: false, field: 'mrp' });
    expect(await saveLabelMrp(db, OWNER, { batchId: b.value.id, variantId: v250, mrpPaise: 34000 }, t(4))).toMatchObject({ ok: true, value: { changed: true } });
    expect(await rows(db, 'SELECT batch_id, variant_id, label_mrp_paise, updated_by FROM batch_items')).toEqual([{ batch_id: b.value.id, variant_id: v250, label_mrp_paise: 34000, updated_by: OWNER.email }]);
    expect((await rows<{ summary: string }>(db, "SELECT summary FROM audit_log WHERE action = 'batch.label_mrp' ORDER BY id")).map((a) => a.summary))
      .toEqual([`Label MRP for ${b.value.code} 250 g: ₹320`, `Label MRP for ${b.value.code} 250 g: ₹340 (was ₹320)`]);
  });
});
