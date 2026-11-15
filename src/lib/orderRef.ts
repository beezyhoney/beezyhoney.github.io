// Order codes: 'BZ-' + 5 characters, made in the visitor's browser before WhatsApp opens (design §2.2).
//
// The 26 characters leave out everything that is easy to misread or mistype on a phone:
// 0/O, 1/I/L, 2/Z, 5/S and B (looks like 8). 26^5 ≈ 11.9 million codes. Codes are NOT unique by design:
// the admin search lists every match with its date and items, and the 128-bit `key` keeps records apart.

/** The characters an order code is made of (26). */
export const ALPHABET = '346789ACDEFGHJKMNPQRTUVWXY';
export const REF_PREFIX = 'BZ-';
/** Characters after the prefix */
export const REF_LENGTH = 5;

const REF_RE = new RegExp(`^${REF_PREFIX}[${ALPHABET}]{${REF_LENGTH}}$`);
const QUERY_CHARS = new RegExp(`^[${ALPHABET}]+$`);

/** Random bytes from the Web Crypto API (browsers, Node 19+, workerd). */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** A new random order code, e.g. 'BZ-7K3QD'. Uniform: bytes ≥ 234 (= 9 × 26) are thrown away, so there is no modulo bias. */
export function newRef(): string {
  const limit = 256 - (256 % ALPHABET.length); // 234
  let code = '';
  while (code.length < REF_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b < limit) code += ALPHABET[b % ALPHABET.length];
      if (code.length === REF_LENGTH) break;
    }
  }
  return REF_PREFIX + code;
}

/** A new 128-bit order key: 32 lower-case hex characters. Sent with the order record, never shown. */
export function newKey(): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** True for a well-formed order code such as 'BZ-7K3QD' (exact: capitals, with the dash). */
export function isRef(value: unknown): value is string {
  return typeof value === 'string' && REF_RE.test(value);
}

/** True for a well-formed order key (32 lower-case hex characters). */
export function isKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/**
 * Turns what the owner types into the find box into the code characters to search for, or null.
 * 'BZ-7K3QD', 'bz 7k3qd', 'Order BZ-7K3QD', '#7K3QD' → '7K3QD' (a full code); '3qd' → '3QD' (the last characters).
 * At least 3 characters are needed. Anything with a character that never appears in a code
 * (such as O, 0, I, 1, S, 5 after the 'BZ' prefix) gives null.
 * Match a stored ref with refMatches(ref, query).
 */
export function normaliseRefQuery(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('ORDER')) s = s.slice(5);
  if (s.startsWith('BZ')) s = s.slice(2); // B and Z are not in ALPHABET, so a leading BZ is always the prefix
  if (s.length < 3 || s.length > REF_LENGTH || !QUERY_CHARS.test(s)) return null;
  return s;
}

/** Does a stored order code match a find-box query? A full code matches exactly; 3–4 characters match the end. */
export function refMatches(ref: string, query: string): boolean {
  const q = normaliseRefQuery(query);
  if (!q || !isRef(ref)) return false;
  return ref.slice(REF_PREFIX.length).endsWith(q);
}
