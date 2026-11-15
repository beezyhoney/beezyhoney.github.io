// The WhatsApp order message: built on the site (cart, product page, gift box) and read back by the
// admin's "Paste WhatsApp order" tool. buildOrderMessage() and parseOrderMessage() round-trip.
//
// With prices shown (settings.showPrices):
//   Hi Beezy Honey! I'd like to order (Order BZ-7K3QD):
//   1. Murungai Honey with comb – 250 g × 2 – ₹620
//   2. Honey Sticks – Box of 10 (100 g) × 1 – ₹70
//   Total: ₹690 (prices as on 15 Nov 2026)
//   Please confirm delivery charges and payment details.
// A pack without a price says "price please" and the total line then says "Total so far".
// With prices hidden, the message keeps the wording the site always used, plus the order code:
//   Hi Beezy Honey! I'd like to order (Order BZ-7K3QD):
//   1. Murungai Honey with comb – 250 g × 2
//
//   Please share the price and delivery details.
// Customers can edit the text before sending, so the parser is forgiving (dashes, x for ×, Rs for ₹, extra spaces),
// and the admin always goes by the stored order, never by the text.
import { formatINR, parseRupees } from './money';
import { isRef, REF_PREFIX } from './orderRef';

export const GREETING = 'Hi Beezy Honey!';
export const CLOSING_PRICED = 'Please confirm delivery charges and payment details.';
export const CLOSING_PLAIN = 'Please share the price and delivery details.';
export const PRICE_PLEASE = 'price please';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEP = ' – ';
const IST_OFFSET_MS = 330 * 60_000;

/** One line of an order: a pack of a product, how many, and the price of one pack (null = "price please"). */
export interface MessageLine {
  /** product name as customers see it, with ' with comb' where it applies, e.g. 'Murungai Honey with comb' */
  name: string;
  /** pack label, e.g. '250 g' or 'Box of 10 (100 g)' */
  pack: string;
  /** 1–99 */
  qty: number;
  /** price of one pack in paise, or null when the pack has no price yet */
  unitPaise: number | null;
}

export interface OrderMessageInput {
  /** order code, e.g. 'BZ-7K3QD' */
  ref: string;
  lines: MessageLine[];
  /** settings.showPrices: amounts are written only when true */
  showPrices: boolean;
  /** day the prices are from: 'YYYY-MM-DD', or a Date (its India date is used). Default: today in India. */
  pricesOn?: string | Date;
}

/** Today's date in India (UTC+5:30) as 'YYYY-MM-DD'. */
export function istDate(at: Date = new Date()): string {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → '15 Nov 2026' (fixed English month names, the same in every browser) */
export function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new RangeError(`dayLabel: expected YYYY-MM-DD, got ${iso}`);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** '15 Nov 2026' → '2026-11-15', or null */
function parseDayLabel(text: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (month < 0) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const toDay = (d: string | Date | undefined) => (d === undefined ? istDate() : typeof d === 'string' ? d : istDate(d));

/** Sum of the priced lines, and whether every line has a price. */
export function messageTotal(lines: MessageLine[]): { totalPaise: number; priced: number; complete: boolean } {
  let totalPaise = 0;
  let priced = 0;
  for (const l of lines) {
    if (l.unitPaise === null) continue;
    totalPaise += l.unitPaise * l.qty;
    priced++;
  }
  return { totalPaise, priced, complete: priced === lines.length };
}

function header(ref: string, what: string, end: string) {
  return `${GREETING} I'd like to order${what}${ref ? ` (Order ${ref})` : ''}${end}`;
}

/** The WhatsApp text for a cart or a single product order. */
export function buildOrderMessage(input: OrderMessageInput): string {
  const { ref, lines, showPrices } = input;
  const out = [header(ref, '', ':')];
  lines.forEach((l, i) => {
    const base = `${i + 1}. ${l.name}${SEP}${l.pack} × ${l.qty}`;
    if (!showPrices) out.push(base);
    else out.push(`${base}${SEP}${l.unitPaise === null ? PRICE_PLEASE : formatINR(l.unitPaise * l.qty)}`);
  });
  if (!showPrices) {
    out.push('', CLOSING_PLAIN);
    return out.join('\n');
  }
  const t = messageTotal(lines);
  if (t.priced > 0) out.push(`${t.complete ? 'Total' : 'Total so far'}: ${formatINR(t.totalPaise)} (prices as on ${dayLabel(toDay(input.pricesOn))})`);
  out.push(CLOSING_PRICED);
  return out.join('\n');
}

/* ---------------------------------------------------------------- gift box ---- */

export interface GiftMessageInput {
  ref: string;
  showPrices: boolean;
  pricesOn?: string | Date;
  /** honeys per box */
  size: number;
  /** jar size, e.g. '100 g' */
  jar: string;
  /** the honeys, with the price of one jar at the chosen size (null = price please) */
  picks: { name: string; unitPaise: number | null }[];
  /** extras in every box, with the price for one box (null = price please) */
  extras: { name: string; unitPaise: number | null }[];
  /** packing fee per box in paise (0 = none) */
  feePaise: number;
  boxes: number;
  /** true from settings.gift.bulkFrom boxes: the total is confirmed on WhatsApp */
  bulk: boolean;
  occasion?: string;
  /** already formatted, e.g. '20 Dec 2026' */
  neededBy?: string;
  /** message on the gift card */
  card?: string;
}

/** Per-box and total estimate of a gift box order (null parts = "price on WhatsApp"). */
export function giftEstimate(g: Pick<GiftMessageInput, 'picks' | 'extras' | 'feePaise' | 'boxes' | 'bulk'>) {
  const parts = [...g.picks, ...g.extras];
  const priced = parts.filter((p) => p.unitPaise !== null);
  const perBoxPaise = priced.reduce((s, p) => s + (p.unitPaise as number), 0) + Math.max(0, g.feePaise);
  const complete = priced.length === parts.length;
  const any = priced.length > 0 || g.feePaise > 0;
  return {
    /** price of one box from the priced parts, or null when nothing has a price */
    perBoxPaise: any ? perBoxPaise : null,
    /** per box × boxes, or null for bulk orders or when nothing has a price */
    totalPaise: any && !g.bulk ? perBoxPaise * g.boxes : null,
    /** false when some honey or extra has no price yet ("so far") */
    complete,
  };
}

/** The WhatsApp text for a gift box order. */
export function buildGiftMessage(g: GiftMessageInput): string {
  const amount = (p: number | null) => (p === null ? PRICE_PLEASE : formatINR(p));
  const out = [header(g.ref, ' gift boxes', '.'), '', `Each box: ${g.size} honeys, ${g.jar} each`];
  g.picks.forEach((p, i) => out.push(`${i + 1}. ${p.name}${g.showPrices ? `${SEP}${amount(p.unitPaise)}` : ''}`));
  if (g.extras.length) {
    out.push(`Extras in each box: ${g.extras.map((x) => (g.showPrices ? `${x.name} (${amount(x.unitPaise)})` : x.name)).join(', ')}`);
  }
  const est = giftEstimate(g);
  if (g.showPrices && g.feePaise > 0) out.push(`Box fee: ${formatINR(g.feePaise)}`);
  if (g.showPrices && est.perBoxPaise !== null) out.push(`Per box: ${formatINR(est.perBoxPaise)}${est.complete ? '' : ' so far'}`);
  out.push(`Number of boxes: ${g.boxes}`);
  if (g.showPrices && g.bulk) out.push('Estimated total: bulk price confirmed on WhatsApp');
  else if (g.showPrices && est.totalPaise !== null) {
    out.push(`Estimated total: ${formatINR(est.totalPaise)}${est.complete ? '' : ' so far'} (prices as on ${dayLabel(toDay(g.pricesOn))})`);
  }
  if (g.occasion) out.push(`Occasion: ${g.occasion}`);
  if (g.neededBy) out.push(`Needed by: ${g.neededBy}`);
  if (g.card?.trim()) out.push(`Message on the card: "${g.card.trim()}"`);
  out.push('', g.showPrices ? CLOSING_PRICED : CLOSING_PLAIN);
  return out.join('\n');
}

/* ------------------------------------------------------------------ parsing ---- */

export interface ParsedLine extends MessageLine {
  /** amount written on the line (qty × unit), or null when none or "price please" */
  linePaise: number | null;
  /** true when the line said "price please" */
  pricePlease: boolean;
}

export interface ParsedOrderMessage {
  kind: 'order' | 'gift';
  /** order code, or null for an old message without one (or an edited, unreadable code) */
  ref: string | null;
  /** for gift boxes: each honey at the jar size, qty = number of boxes */
  lines: ParsedLine[];
  /** total written in the message (for gifts: the estimated total), or null */
  totalPaise: number | null;
  /** the total said "so far" (some packs had no price) */
  totalSoFar: boolean;
  /** 'YYYY-MM-DD' from "(prices as on …)", or null */
  pricesOn: string | null;
  /** the message carried prices */
  showPrices: boolean;
  /** gift box details (kind 'gift' only) */
  gift?: {
    size: number | null; jar: string | null; boxes: number | null; picks: string[]; extras: string[];
    perBoxPaise: number | null; feePaise: number | null; bulk: boolean;
    occasion: string | null; neededBy: string | null; card: string | null;
  };
}

const DASH = '\\s+[–—-]\\s+';
const normaliseText = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[‘’]/g, "'").replace(/ /g, ' ');

/** Reads an amount or "price please"; undefined when the text is neither */
function readAmount(text: string): { paise: number | null; please: boolean } | undefined {
  const t = text.trim();
  if (/^price\s*please$/i.test(t)) return { paise: null, please: true };
  if (!/^(?:₹|rs\.?|inr)/i.test(t)) return undefined; // a bare number could be part of a pack name
  const paise = parseRupees(t);
  return paise === null || paise < 0 ? undefined : { paise, please: false };
}

function findRef(text: string): string | null {
  const m = /\bBZ\s*[-–—]?\s*([A-Za-z0-9]{5})\b/i.exec(text);
  if (!m) return null;
  const ref = REF_PREFIX + m[1].toUpperCase();
  return isRef(ref) ? ref : null;
}

/** "1. Murungai Honey with comb – 250 g × 2 – ₹620" → line, or null */
function parseLine(raw: string): ParsedLine | null {
  const m = /^\d{1,2}\s*[.)]\s*(.+)$/.exec(raw.trim());
  if (!m) return null;
  let rest = m[1].trim();
  let linePaise: number | null = null;
  let pricePlease = false;
  const tail = new RegExp(`^(.*)${DASH}(.+)$`).exec(rest);
  if (tail) {
    const amt = readAmount(tail[2]);
    if (amt) { rest = tail[1]; linePaise = amt.paise; pricePlease = amt.please; }
  }
  const q = /^(.*\S)\s*[×xX*]\s*(\d{1,3})$/.exec(rest);
  if (!q) return null;
  const qty = Number(q[2]);
  const parts = new RegExp(`^(.*\\S)${DASH}(.+)$`).exec(q[1]);
  if (!parts || qty < 1) return null;
  const unitPaise = linePaise !== null && linePaise % qty === 0 ? linePaise / qty : null;
  return { name: parts[1].trim(), pack: parts[2].trim(), qty, unitPaise, linePaise, pricePlease };
}

function parseTotal(line: string): { paise: number; soFar: boolean; pricesOn: string | null } | null {
  const m = /^(?:estimated\s+)?total(\s+so\s+far)?\s*:\s*((?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d{1,2})?)(\s+so\s+far)?(?:\s*\(prices\s+as\s+on\s+([^)]+)\))?\s*$/i.exec(line.trim());
  if (!m) return null;
  const paise = parseRupees(m[2]);
  if (paise === null) return null;
  return { paise, soFar: Boolean(m[1] || m[3]), pricesOn: m[4] ? parseDayLabel(m[4]) : null };
}

function parseGift(lines: string[], ref: string | null): ParsedOrderMessage {
  const gift: NonNullable<ParsedOrderMessage['gift']> = {
    size: null, jar: null, boxes: null, picks: [], extras: [], perBoxPaise: null, feePaise: null, bulk: false,
    occasion: null, neededBy: null, card: null,
  };
  const picks: { name: string; paise: number | null; please: boolean }[] = [];
  let showPrices = false;
  let totalPaise: number | null = null;
  let totalSoFar = false;
  let pricesOn: string | null = null;
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = /^each box:\s*(\d+)\s+honeys?,\s*(.+?)\s+each$/i.exec(line))) { gift.size = Number(m[1]); gift.jar = m[2]; continue; }
    if ((m = /^\d{1,2}\s*[.)]\s*(.+)$/.exec(line))) {
      const t = new RegExp(`^(.*)${DASH}(.+)$`).exec(m[1]);
      const amt = t ? readAmount(t[2]) : undefined;
      if (t && amt) { showPrices = true; picks.push({ name: t[1].trim(), paise: amt.paise, please: amt.please }); }
      else picks.push({ name: m[1].trim(), paise: null, please: false });
      continue;
    }
    if ((m = /^extras in each box:\s*(.+)$/i.exec(line))) {
      gift.extras = m[1].split(/\s*,\s*/).map((x) => x.replace(/\s*\((?:₹[^)]*|price please)\)$/i, '').trim()).filter(Boolean);
      if (/\((?:₹|price please)/i.test(m[1])) showPrices = true;
      continue;
    }
    if ((m = /^box fee:\s*(.+)$/i.exec(line))) { gift.feePaise = parseRupees(m[1]); showPrices = true; continue; }
    if ((m = /^per box:\s*(.+?)(?:\s+so far)?$/i.exec(line))) { gift.perBoxPaise = parseRupees(m[1]); showPrices = true; continue; }
    if ((m = /^number of boxes:\s*(\d+)$/i.exec(line))) { gift.boxes = Number(m[1]); continue; }
    if (/^estimated total:\s*bulk/i.test(line)) { gift.bulk = true; showPrices = true; continue; }
    const t = parseTotal(line);
    if (t) { totalPaise = t.paise; totalSoFar = t.soFar; pricesOn = t.pricesOn; showPrices = true; continue; }
    if ((m = /^occasion:\s*(.+)$/i.exec(line))) { gift.occasion = m[1]; continue; }
    if ((m = /^needed by:\s*(.+)$/i.exec(line))) { gift.neededBy = m[1]; continue; }
    if ((m = /^message on the card:\s*"?(.*?)"?$/i.exec(line))) { gift.card = m[1]; continue; }
    if (line === CLOSING_PRICED) showPrices = true;
  }
  gift.picks = picks.map((p) => p.name);
  const boxes = gift.boxes ?? 1;
  return {
    kind: 'gift',
    ref,
    lines: picks.map((p) => ({
      name: p.name, pack: gift.jar ?? '', qty: boxes, unitPaise: p.paise,
      linePaise: p.paise === null ? null : p.paise * boxes, pricePlease: p.please,
    })),
    totalPaise, totalSoFar, pricesOn, showPrices, gift,
  };
}

/**
 * Reads a WhatsApp order message made by the site (cart, product page or gift box; with or without prices;
 * also the older messages without an order code). Returns null when the text has no order in it.
 */
export function parseOrderMessage(text: string): ParsedOrderMessage | null {
  if (typeof text !== 'string') return null;
  const lines = normaliseText(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines.findIndex((l) => /i'd like to order/i.test(l));
  const ref = findRef(head >= 0 ? lines[head] : text) ?? findRef(text);
  if (head >= 0 && /i'd like to order gift boxes/i.test(lines[head])) return parseGift(lines.slice(head + 1), ref);

  const out: ParsedLine[] = [];
  let totalPaise: number | null = null;
  let totalSoFar = false;
  let pricesOn: string | null = null;
  let showPrices = false;
  for (const line of lines.slice(head + 1)) {
    const l = parseLine(line);
    if (l) {
      out.push(l);
      if (l.linePaise !== null || l.pricePlease) showPrices = true;
      continue;
    }
    const t = parseTotal(line);
    if (t) { totalPaise = t.paise; totalSoFar = t.soFar; pricesOn = t.pricesOn; showPrices = true; continue; }
    if (line === CLOSING_PRICED) showPrices = true;
  }
  if (!out.length) return null;
  return { kind: 'order', ref, lines: out, totalPaise, totalSoFar, pricesOn, showPrices };
}
