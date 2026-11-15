// Batch labels (design §5 v2 "Labels", amendment A5): a print sheet of small stickers for one batch and one pack, with
// the batch no., packed on, best before, MRP (incl. of all taxes), ₹ per 100 g, the FSSAI licence number from the
// business settings and an optional QR code to Know Your Jar. This module reads data, lays out the sheet and saves the
// MRP printed for a batch and pack (batch_items, owner decision 16 Nov 2026); the page draws the sheet with print CSS
// (src/pages/admin/labels/[batchId].astro) and the QR comes from src/admin/catalog/qr.ts.
import { formatINR, perHundredGrams } from '../lib/money';
import { type Actor, type D1, type Result, all, auditInsert, fail, first, ok, stmt, tryBatch } from './db';
import { getSetting } from './settings';
import { monthName, nowIso, shortDate } from './time';

export interface SheetPreset {
  id: string;
  /** shown in the picker */
  name: string;
  /** page size in mm */
  pageW: number;
  pageH: number;
  cols: number;
  rows: number;
  /** sticker size in mm */
  labelW: number;
  labelH: number;
  /** distance from the page's top-left corner to the first sticker, mm */
  top: number;
  left: number;
  /** distance between the starts of neighbouring stickers, mm */
  pitchX: number;
  pitchY: number;
}

/**
 * Common sticker sheets (A4 sizes as sold for laser/inkjet printers, plus a one-sticker-per-page roll for small
 * label printers). The owner's sheet (decision 16 Nov 2026) is A4 with 65 stickers of 38.1 × 21.2 mm (5 × 13): it is
 * first, so it is the default. The others stay for other sheets.
 */
export const SHEET_PRESETS: readonly SheetPreset[] = [
  { id: 'a4-65', name: 'A4, 65 stickers (38.1 × 21.2 mm, 5 × 13)', pageW: 210, pageH: 297, cols: 5, rows: 13, labelW: 38.1, labelH: 21.2, top: 10.7, left: 4.75, pitchX: 40.6, pitchY: 21.2 },
  { id: 'a4-21', name: 'A4, 21 stickers (63.5 × 38.1 mm, 3 × 7)', pageW: 210, pageH: 297, cols: 3, rows: 7, labelW: 63.5, labelH: 38.1, top: 15.15, left: 7.25, pitchX: 66, pitchY: 38.1 },
  { id: 'a4-24', name: 'A4, 24 stickers (63.5 × 33.9 mm, 3 × 8)', pageW: 210, pageH: 297, cols: 3, rows: 8, labelW: 63.5, labelH: 33.9, top: 12.9, left: 7.25, pitchX: 66, pitchY: 33.9 },
  { id: 'a4-14', name: 'A4, 14 stickers (99.1 × 38.1 mm, 2 × 7)', pageW: 210, pageH: 297, cols: 2, rows: 7, labelW: 99.1, labelH: 38.1, top: 15.15, left: 4.65, pitchX: 101.6, pitchY: 38.1 },
  { id: 'a4-8', name: 'A4, 8 stickers (99.1 × 67.7 mm, 2 × 4)', pageW: 210, pageH: 297, cols: 2, rows: 4, labelW: 99.1, labelH: 67.7, top: 13.1, left: 4.65, pitchX: 101.6, pitchY: 67.7 },
  { id: 'roll-50x30', name: 'Label printer roll, 50 × 30 mm (one per page)', pageW: 50, pageH: 30, cols: 1, rows: 1, labelW: 50, labelH: 30, top: 0, left: 0, pitchX: 50, pitchY: 30 },
];

/** The default sheet (the owner's A4 65-up) */
export const DEFAULT_SHEET_ID = 'a4-65';
export const presetById = (id: string | null | undefined): SheetPreset =>
  SHEET_PRESETS.find((p) => p.id === id) ?? SHEET_PRESETS.find((p) => p.id === DEFAULT_SHEET_ID)!;

/** Small stickers (under 25 mm high, like the 65-up sheet) use the compact layout: the QR code is off by default */
export const isCompact = (p: SheetPreset): boolean => p.labelH < 25;

/** Where the QR code on a label leads: the public Know Your Jar page with the batch filled in */
export function knowYourJarUrl(code: string, origin = 'https://beezyhoney.in'): string {
  return `${origin}/know-your-jar/?batch=${encodeURIComponent(code.trim())}`;
}

export interface LabelPack {
  variantId: number;
  label: string;
  netGrams: number | null;
  pricePaise: number | null;
  mrpPaise: number | null;
  active: boolean;
  /** the MRP saved for this batch and pack (batch_items), or null */
  savedMrpPaise: number | null;
  /** the amount printed as MRP unless the owner types another: the saved label MRP, else the pack's MRP, else the price */
  defaultMrpPaise: number | null;
}

export interface LabelBatch {
  id: number;
  code: string;
  productId: number;
  productName: string;
  withComb: boolean;
  status: 'active' | 'finished' | 'recalled';
  isPublic: boolean;
  harvestedLabel: string;
  packedOn: string;
  bestBefore: string;
  packs: LabelPack[];
  fssai: string | null;
  customerCare: string | null;
  businessName: string;
}

/** Everything a label sheet prints for one batch, or null when the batch does not exist */
export async function labelBatch(db: D1, batchId: number): Promise<LabelBatch | null> {
  const b = await first<{ id: number; code: string; product_id: number; name: string; with_comb: number; status: LabelBatch['status']; is_public: number; harvested_label: string; packed_on: string; best_before: string }>(db,
    `SELECT b.id, b.code, b.product_id, p.name, p.with_comb, b.status, b.is_public, b.harvested_label, b.packed_on, b.best_before
       FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?`, batchId);
  if (!b) return null;
  const [packs, business] = await Promise.all([
    all<{ id: number; label: string; net_grams: number | null; price_paise: number | null; mrp_paise: number | null; active: number; label_mrp_paise: number | null }>(db,
      `SELECT v.id, v.label, v.net_grams, v.price_paise, v.mrp_paise, v.active, bi.label_mrp_paise
         FROM variants v LEFT JOIN batch_items bi ON bi.batch_id = ? AND bi.variant_id = v.id
        WHERE v.product_id = ? ORDER BY v.active DESC, v.sort, v.id`, b.id, b.product_id),
    getSetting(db, 'business'),
  ]);
  return {
    id: b.id, code: b.code, productId: b.product_id, productName: b.name, withComb: b.with_comb === 1, status: b.status, isPublic: b.is_public === 1,
    harvestedLabel: b.harvested_label, packedOn: b.packed_on, bestBefore: b.best_before,
    packs: packs.map((v) => ({ variantId: v.id, label: v.label, netGrams: v.net_grams, pricePaise: v.price_paise, mrpPaise: v.mrp_paise, active: v.active === 1,
      savedMrpPaise: v.label_mrp_paise, defaultMrpPaise: v.label_mrp_paise ?? v.mrp_paise ?? v.price_paise })),
    fssai: business.fssai, customerCare: business.customerCare, businessName: business.name,
  };
}

/**
 * Saves the MRP printed on a batch's stickers for one pack (batch_items), so a reprint uses the same MRP after the
 * catalog price changes. Owner and helper. The MRP cannot be below the pack's price (nobody may sell above the MRP).
 * Errors: invalid (field 'mrp'), not_found (batch, or a pack of another product).
 */
export async function saveLabelMrp(db: D1, actor: Actor, input: { batchId: number; variantId: number; mrpPaise: number }, at: string = nowIso()): Promise<Result<{ mrpPaise: number; changed: boolean }>> {
  const mrp = input?.mrpPaise;
  if (!Number.isSafeInteger(mrp) || mrp < 100 || mrp > 10_000_000) return fail('invalid', 'Enter the MRP to print, at least ₹1.', { field: 'mrp' });
  const r = await first<{ code: string; label: string; price_paise: number | null; saved: number | null }>(db,
    `SELECT b.code, v.label, v.price_paise, bi.label_mrp_paise AS saved
       FROM batches b JOIN variants v ON v.product_id = b.product_id LEFT JOIN batch_items bi ON bi.batch_id = b.id AND bi.variant_id = v.id
      WHERE b.id = ? AND v.id = ?`, input.batchId, input.variantId);
  if (!r) return fail('not_found', 'This batch or pack does not exist. Reload the page.');
  if (r.price_paise !== null && mrp < r.price_paise) return fail('invalid', `The MRP cannot be less than the price (${formatINR(r.price_paise)}).`, { field: 'mrp' });
  if (r.saved === mrp) return ok({ mrpPaise: mrp, changed: false });
  const res = await tryBatch(db, [
    stmt(db, `INSERT INTO batch_items (batch_id, variant_id, label_mrp_paise, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (batch_id, variant_id) DO UPDATE SET label_mrp_paise = excluded.label_mrp_paise, updated_at = excluded.updated_at,
        updated_by = excluded.updated_by`, input.batchId, input.variantId, mrp, at, actor.email),
    auditInsert(db, {
      at, actor, action: 'batch.label_mrp', entity: 'batch', entityId: input.batchId,
      summary: `Label MRP for ${r.code} ${r.label}: ${formatINR(mrp)}${r.saved !== null ? ` (was ${formatINR(r.saved)})` : ''}`,
      before: { variantId: input.variantId, mrpPaise: r.saved }, after: { variantId: input.variantId, mrpPaise: mrp },
    }),
  ]);
  if (!res.ok) return res;
  return ok({ mrpPaise: mrp, changed: true });
}

/** The words on one sticker */
export interface StickerText {
  title: string;
  pack: string;
  batch: string;
  packedOn: string;
  bestBefore: string;
  /** '₹310', or null to leave a blank to write by hand */
  mrp: number | null;
  /** ₹ per 100 g (paise), null for packs without a weight or without an MRP */
  per100: number | null;
  fssai: string | null;
  /** the QR link, or null when the QR is switched off or the batch is hidden from Know Your Jar */
  qr: string | null;
}

/** What one sticker says for a batch, a pack and the chosen MRP */
export function stickerText(batch: LabelBatch, pack: LabelPack, opts: { mrpPaise: number | null; qr: boolean; origin?: string }): StickerText {
  return {
    title: batch.productName + (batch.withComb ? ' with comb' : ''),
    pack: pack.label,
    batch: batch.code,
    packedOn: shortDate(batch.packedOn),
    bestBefore: monthName(batch.bestBefore),
    mrp: opts.mrpPaise,
    per100: perHundredGrams(opts.mrpPaise, pack.netGrams),
    fssai: batch.fssai,
    qr: opts.qr && batch.isPublic && batch.status !== 'recalled' ? knowYourJarUrl(batch.code, opts.origin) : null,
  };
}

/** One position on the sheet: 'used' (left blank because that sticker was already peeled off) or 'label' */
export interface SheetCell { page: number; index: number; row: number; col: number; x: number; y: number; kind: 'used' | 'label' | 'empty' }

/**
 * Lays out `count` stickers on sheets of `preset`, skipping the first `skip` positions of the first sheet (stickers
 * already used). Positions are in mm from each page's top-left corner. At most 20 pages.
 */
export function layoutSheet(preset: SheetPreset, count: number, skip = 0): { pages: number; cells: SheetCell[] } {
  const perPage = preset.cols * preset.rows;
  const s = Math.max(0, Math.min(perPage - 1, Math.floor(skip) || 0));
  const n = Math.max(0, Math.min(perPage * 20 - s, Math.floor(count) || 0));
  const total = s + n;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const cells: SheetCell[] = [];
  for (let k = 0; k < pages * perPage; k++) {
    const page = Math.floor(k / perPage);
    const index = k % perPage;
    const row = Math.floor(index / preset.cols);
    const col = index % preset.cols;
    cells.push({
      page, index, row, col,
      x: preset.left + col * preset.pitchX,
      y: preset.top + row * preset.pitchY,
      kind: k < s ? 'used' : k < total ? 'label' : 'empty',
    });
  }
  return { pages, cells };
}

/** Active batches for the Labels start screen (newest first) */
export async function labelBatches(db: D1): Promise<{ id: number; code: string; productName: string; packedOn: string; bestBefore: string; isPublic: boolean }[]> {
  const rows = await all<{ id: number; code: string; name: string; packed_on: string; best_before: string; is_public: number }>(db,
    `SELECT b.id, b.code, p.name, b.packed_on, b.best_before, b.is_public FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.status = 'active' ORDER BY b.packed_on DESC, b.id DESC LIMIT 200`);
  return rows.map((r) => ({ id: r.id, code: r.code, productName: r.name, packedOn: r.packed_on, bestBefore: r.best_before, isPublic: r.is_public === 1 }));
}
