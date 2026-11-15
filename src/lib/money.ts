// Money helpers shared by the public site, the build and the Worker (admin).
//
// Every amount is a whole number of paise: ₹310 = 31000. Rupee text uses the Indian grouping
// (₹1,05,000), exactly what Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }) prints.
// The grouping is done by hand so browsers, Node and workerd always print the same characters
// (a unit test compares it with Intl for many values).

const DIGITS = /^\d+$/;

function assertPaise(paise: number, fn: string): void {
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise)) {
    throw new RangeError(`${fn}: expected a whole number of paise, got ${String(paise)}`);
  }
}

/** Indian digit grouping of a whole, non-negative number: 105000 → '1,05,000', 12345678 → '1,23,45,678' */
export function groupIndian(n: number): string {
  const s = String(n);
  if (!DIGITS.test(s)) throw new RangeError(`groupIndian: expected a whole, non-negative number, got ${s}`);
  if (s.length <= 3) return s;
  let rest = s.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  return `${groups.join(',')},${s.slice(-3)}`;
}

/**
 * Rupee text for an amount in paise: 105000_00 → '₹1,05,000', 105050 → '₹1,050.50', -50000 → '-₹500'.
 * No decimals unless the amount has paise.
 */
export function formatINR(paise: number): string {
  assertPaise(paise, 'formatINR');
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  const text = `₹${groupIndian(rupees)}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
  return paise < 0 ? `-${text}` : text;
}

/**
 * Price per 100 g in paise (rounded to the nearest paisa), for "₹124 per 100 g".
 * null when there is no price or the pack has no weight.
 */
export function perHundredGrams(pricePaise: number | null | undefined, grams: number | null | undefined): number | null {
  if (pricePaise === null || pricePaise === undefined || grams === null || grams === undefined) return null;
  assertPaise(pricePaise, 'perHundredGrams');
  if (!Number.isFinite(grams) || grams <= 0) return null;
  return Math.round((pricePaise * 100) / grams);
}

/**
 * Reads a rupee amount typed by a person and returns paise, or null when it is not a clear amount.
 * Accepts '₹1,050.50', '1050.5', 'Rs. 1,05,000', 'INR 500', '₹500/-', '-₹50' (refunds).
 * More than two decimals, letters, or badly placed commas give null.
 */
export function parseRupees(input: string | number | null | undefined): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    const paise = Math.round(input * 100);
    return Number.isSafeInteger(paise) ? paise : null;
  }
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/[−‒–—]/g, '-');
  let negative = false;
  if (s.startsWith('-')) { negative = true; s = s.slice(1).trim(); }
  s = s.replace(/^(?:₹|rs\.?|inr)\s*/i, '');
  if (!negative && s.startsWith('-')) { negative = true; s = s.slice(1).trim(); }
  s = s.replace(/\s*\/-$/, '');
  const m = /^(\d+(?:,\d+)*)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = m[1];
  if (whole.includes(',') && !/^\d{1,3}(?:,\d{2,3})*,\d{3}$/.test(whole)) return null;
  const rupees = Number(whole.replace(/,/g, ''));
  const paise = rupees * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) return null;
  return negative && paise !== 0 ? -paise : paise;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
}

/** A whole number in Indian words: 105000 → 'One Lakh Five Thousand', 0 → 'Zero' */
export function numberInWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`numberInWords: expected a whole, non-negative number, got ${n}`);
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  let rest = n % 10_000_000;
  if (crore) parts.push(`${numberInWords(crore)} Crore`);
  const lakh = Math.floor(rest / 100_000); rest %= 100_000;
  const thousand = Math.floor(rest / 1000); rest %= 1000;
  const hundred = Math.floor(rest / 100); rest %= 100;
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/**
 * An amount in words for invoices, Indian system:
 * 10500000 → 'Rupees One Lakh Five Thousand Only', 105050 → 'Rupees One Thousand Fifty and Fifty Paise Only',
 * 50 → 'Fifty Paise Only', 0 → 'Rupees Zero Only'.
 */
export function amountInWords(paise: number): string {
  assertPaise(paise, 'amountInWords');
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  let text: string;
  if (rupees && rest) text = `Rupees ${numberInWords(rupees)} and ${numberInWords(rest)} Paise Only`;
  else if (rest) text = `${numberInWords(rest)} Paise Only`;
  else text = `Rupees ${numberInWords(rupees)} Only`;
  return paise < 0 ? `Minus ${text}` : text;
}
