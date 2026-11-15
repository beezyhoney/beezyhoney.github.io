// Reading the product editor's forms into src/server/products-admin.ts inputs (pure: testable in Node).
// Field names here are the editor's form names; server errors use the same names (PRODUCT_FIELDS, packField()).
import type { FormReader } from '../forms';
import { parseGramsText, parseIntText, parsePaiseText } from '../parse';
import { TASTES, USES, type PackInput, type ProductEditor, type ProductInput } from '../../server/products-admin';

export const MAX_SPEC_ROWS = 10;
export const MAX_LOVE = 6;

/** Gallery rows as posted: g_src[], g_cap[], g_order[] (no-JS ordering), g_del[] (removed), g_add[] (new, no JS) */
export function readGallery(form: FormReader): { src: string; caption: string }[] {
  const src = form.rawAll('g_src');
  const cap = form.rawAll('g_cap');
  const order = form.rawAll('g_order');
  const del = new Set(form.rawAll('g_del'));
  const rows = src.map((s, i) => ({ src: s.trim(), caption: (cap[i] ?? '').replace(/\s+/g, ' ').trim(), order: parseIntText(order[i] ?? '') ?? i + 1, i }))
    .filter((r) => r.src && !del.has(r.src));
  rows.sort((a, b) => a.order - b.order || a.i - b.i);
  const out = rows.map(({ src: s, caption }) => ({ src: s, caption }));
  for (const add of form.rawAll('g_add')) {
    const a = add.trim();
    if (a && !out.some((g) => g.src === a)) out.push({ src: a, caption: '' });
  }
  return out;
}

/** The main editor form → ProductInput (the slug only while it may still change) */
export function readProductForm(form: FormReader, cur: ProductEditor): ProductInput {
  const specs: [string, string][] = [];
  for (let k = 0; k < MAX_SPEC_ROWS; k++) {
    const l = form.raw(`spec_l_${k}`).replace(/\s+/g, ' ').trim();
    const v = form.raw(`spec_v_${k}`).replace(/\s+/g, ' ').trim();
    if (l || v) specs.push([l, v]);
  }
  const love: string[] = [];
  for (let k = 0; k < MAX_LOVE; k++) {
    const l = form.raw(`love_${k}`).replace(/\s+/g, ' ').trim();
    if (l) love.push(l);
  }
  const colourOn = form.bool('colour_on');
  const cMin = parseIntText(form.raw('colour_min'));
  const cMax = parseIntText(form.raw('colour_max'));
  const toneCustom = form.raw('tone_custom').trim();
  const finderOn = form.bool('finder_on');
  const bloomOn = form.bool('bloom_on');
  const months = form.rawAll('months').map((m) => parseIntText(m)).filter((m): m is number => m !== null);
  const photo = form.raw('photo').trim();
  const card = form.raw('card').trim();
  const shortCode = form.raw('short_code').trim().toUpperCase();
  const slug = form.raw('slug').trim().toLowerCase();
  return {
    id: cur.id,
    version: form.version() ?? 0,
    name: form.text('name', { max: 60 }),
    category: form.raw('category'),
    kind: form.text('kind'),
    badge: form.text('badge'),
    withComb: form.bool('with_comb'),
    tagline: form.text('tagline'),
    tone: toneCustom ? (toneCustom.startsWith('#') ? toneCustom : `#${toneCustom}`) : form.raw('tone'),
    ...(cur.slugFrozen || !slug ? {} : { slug }),
    ...(shortCode ? { shortCode } : {}),
    photo: photo || null,
    card: card || null,
    gallery: readGallery(form),
    specs,
    colour: colourOn ? [cMin ?? -1, cMax ?? cMin ?? -1] : null,
    about: form.text('about', { multiline: true }),
    love,
    useHead: form.optText('use_head'),
    use: form.text('use_text', { multiline: true }),
    store: form.text('store_text', { multiline: true }),
    finder: finderOn ? {
      taste: form.choices('taste', TASTES),
      uses: form.choices('uses', USES),
      rare: form.bool('rare'),
    } : null,
    bloom: bloomOn ? (form.bool('bloom_all') ? 'all' : months) : null,
    bloomNote: bloomOn ? form.optText('bloom_note') : null,
    inGiftBox: form.bool('in_gift_box'),
  };
}

/** Grams typed in a pack's "net weight" box ('250', '250 g', '1 kg'); null for empty, NaN for nonsense */
export function packGramsOf(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const g = parseGramsText(t, 'g');
  return g === null || g <= 0 ? Number.NaN : g;
}

/** Money typed in a pack's price / MRP box; null for empty, NaN for nonsense */
export function packPaiseOf(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const p = parsePaiseText(t);
  return p === null ? Number.NaN : p;
}

/**
 * The packs form → PackInput[] (existing packs, then the new pack when its name is filled in).
 * Typing errors are recorded on the reader (field 'pack_<id>' / 'pack_new').
 */
export function readPacksForm(form: FormReader, cur: ProductEditor): PackInput[] {
  const out: PackInput[] = [];
  const singlePool = cur.pools.length === 1 ? cur.pools[0].id : null;
  const rowOf = (prefix: string, field: string, id?: number, version?: number): PackInput | null => {
    const label = form.raw(`${prefix}label`).trim();
    const grams = packGramsOf(form.raw(`${prefix}grams`));
    const price = packPaiseOf(form.raw(`${prefix}price`));
    const mrp = packPaiseOf(form.raw(`${prefix}mrp`));
    const poolId = parseIntText(form.raw(`${prefix}pool`)) ?? singlePool ?? 0;
    const qtyRaw = form.raw(`${prefix}qty`).trim();
    const qty = qtyRaw ? parseIntText(qtyRaw) : null;
    if (Number.isNaN(grams)) { form.fail(field, 'form.notNumber'); return null; }
    if (Number.isNaN(price) || Number.isNaN(mrp)) { form.fail(field, 'form.notMoney'); return null; }
    if (qtyRaw && qty === null) { form.fail(field, 'form.notNumber'); return null; }
    return {
      ...(id ? { id, version } : {}),
      label, netGrams: grams, poolId, poolQty: qty, pricePaise: price, mrpPaise: mrp,
      active: id ? form.bool(`${prefix}active`) : true,
      giftOk: form.bool(`${prefix}gift`),
    };
  };
  for (const p of cur.packs) {
    const version = parseIntText(form.raw(`p${p.id}_v`)) ?? 0;
    const row = rowOf(`p${p.id}_`, `pack_${p.id}`, p.id, version);
    if (row) out.push(row);
  }
  if (form.raw('new_label').trim()) {
    const row = rowOf('new_', 'pack_new');
    if (row) out.push(row);
  }
  return out;
}
