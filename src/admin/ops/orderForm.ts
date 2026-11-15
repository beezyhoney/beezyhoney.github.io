// Reading the order-lines form (order page "Items" while New, and the New order page) into src/server/orders.ts
// LineInput[]. Pure (FormReader in, data out) so it is unit-tested without a browser.
//
// Field names (i, j = row numbers from 0):
//   existing lines   l{i}_kind (item|custom|fee, hidden), l{i}_variant (pack select, items), l{i}_was (pack it had),
//                    l{i}_wasprice (price text it was rendered with), l{i}_name / l{i}_pack (custom and charge lines),
//                    l{i}_qty, l{i}_price (rupees), l{i}_note (why the price differs), l{i}_remove (checkbox)
//   new packs        n{j}_variant (empty = row not used), n{j}_qty, n{j}_price
//   new other lines  c{j}_kind (custom|fee), c{j}_name (empty = row not used), c{j}_pack, c{j}_qty, c{j}_price
//   counts           line_count, new_count, custom_count (hidden)
//
// Prices: an empty price box on a pack means "today's price from the price list" (which may be "no price yet");
// a typed price is an override. If the pack of an existing line was changed and its price box still shows the old
// price, the new pack's price is used. Custom lines without a price stay "no price yet"; charges need an amount.
import type { FormReader } from '../forms';
import type { LineInput } from '../../server/orders';

const MAX_ROWS = 60;

const count = (form: FormReader, name: string): number => {
  const n = Number.parseInt(form.raw(name), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_ROWS) : 0;
};

const KINDS = ['item', 'custom', 'fee'] as const;

/** The lines the form describes, in order. Field errors are recorded on the reader (check form.ok). */
export function readLineForm(form: FormReader): LineInput[] {
  const out: LineInput[] = [];

  for (let i = 0; i < count(form, 'line_count'); i++) {
    const p = `l${i}_`;
    if (!form.has(`${p}qty`) && !form.has(`${p}kind`)) continue;
    if (form.bool(`${p}remove`)) continue;
    const kind = form.choice(`${p}kind`, KINDS) ?? 'item';
    const qty = form.int(`${p}qty`, { required: true, min: 1, max: 999 });
    const note = form.optText(`${p}note`, { max: 120 });
    const priceText = form.raw(`${p}price`).trim();
    const price = form.paise(`${p}price`, { required: kind === 'fee' });
    if (kind === 'item') {
      const variantId = form.int(`${p}variant`, { required: true, min: 1 });
      const was = form.int(`${p}was`, { min: 1 });
      const packChanged = was !== null && variantId !== null && was !== variantId;
      const keptOldPrice = packChanged && priceText === form.raw(`${p}wasprice`).trim();
      const line: LineInput = { kind: 'item', variantId, qty: qty ?? 1, priceNote: note };
      if (priceText !== '' && !keptOldPrice) line.unitPricePaise = price;
      out.push(line);
    } else {
      const name = form.text(`${p}name`, { required: true, max: 120 });
      const pack = form.text(`${p}pack`, { max: 60 });
      out.push({ kind, name, pack, qty: qty ?? 1, unitPricePaise: priceText === '' ? null : price, priceNote: note });
    }
  }

  for (let j = 0; j < count(form, 'new_count'); j++) {
    const p = `n${j}_`;
    if (!form.raw(`${p}variant`).trim()) continue;
    const variantId = form.int(`${p}variant`, { required: true, min: 1 });
    const qty = form.int(`${p}qty`, { required: true, min: 1, max: 999 });
    const priceText = form.raw(`${p}price`).trim();
    const price = form.paise(`${p}price`);
    const line: LineInput = { kind: 'item', variantId, qty: qty ?? 1 };
    if (priceText !== '') line.unitPricePaise = price;
    out.push(line);
  }

  for (let j = 0; j < count(form, 'custom_count'); j++) {
    const p = `c${j}_`;
    if (!form.raw(`${p}name`).trim()) continue;
    const kind = form.choice(`${p}kind`, ['custom', 'fee'] as const) ?? 'custom';
    const name = form.text(`${p}name`, { required: true, max: 120 });
    const pack = form.text(`${p}pack`, { max: 60 });
    const qty = form.int(`${p}qty`, { required: true, min: 1, max: 999 });
    const priceText = form.raw(`${p}price`).trim();
    const price = form.paise(`${p}price`, { required: kind === 'fee' });
    out.push({ kind, name, pack, qty: qty ?? 1, unitPricePaise: priceText === '' ? null : price });
  }
  return out;
}

/**
 * Field name of a server failure's line ('line-3' = the 3rd line sent) in this form, so the message lands next to
 * the right row. `sent` is what readLineForm() returned; `rows` maps each sent line back to its row prefix.
 */
export function lineFieldFor(failureField: string | undefined, rows: string[]): string | null {
  const m = /^line-(\d+)$/.exec(failureField ?? '');
  if (!m) return null;
  return rows[Number(m[1]) - 1] ?? null;
}

/** Which field of a row a src/server line message is about (orders.ts resolveLines messages) */
export function lineErrorPart(message: string): 'variant' | 'name' | 'pack' | 'note' | 'price' | 'qty' {
  const m = message.toLowerCase();
  if (m.includes('product and pack')) return 'variant';
  if (m.includes('what this line')) return 'name';
  if (m.includes('pack text')) return 'pack';
  if (m.includes('price note')) return 'note';
  if (m.includes('price') || m.includes('amount')) return 'price';
  return 'qty';
}

/** The row prefixes (l0_, n1_, c0_ …) of the lines readLineForm() returns, in the same order */
export function lineRowPrefixes(form: FormReader): string[] {
  const rows: string[] = [];
  for (let i = 0; i < count(form, 'line_count'); i++) {
    const p = `l${i}_`;
    if (!form.has(`${p}qty`) && !form.has(`${p}kind`)) continue;
    if (form.bool(`${p}remove`)) continue;
    rows.push(p);
  }
  for (let j = 0; j < count(form, 'new_count'); j++) if (form.raw(`n${j}_variant`).trim()) rows.push(`n${j}_`);
  for (let j = 0; j < count(form, 'custom_count'); j++) if (form.raw(`c${j}_name`).trim()) rows.push(`c${j}_`);
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A day as the gift message writes it ('20 Dec 2026', '20 December 2026') or an ISO day → 'YYYY-MM-DD', else null.
 * createFromPasted() keeps a needed-by date only in ISO form.
 */
export function messageDayToIso(text: string | null | undefined): string | null {
  const s = String(text ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return validDay(s);
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(s);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  return validDay(`${m[3]}-${String(month + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`);
}

function validDay(s: string): string | null {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}
