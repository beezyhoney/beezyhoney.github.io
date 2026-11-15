// A small QR Code encoder (ISO/IEC 18004), written for the batch labels so no library or CDN is needed.
// Byte mode only, versions 1–10, error correction L/M/Q/H, automatic mask choice with the standard penalty rules.
// That is plenty for a Know Your Jar link (about 55 characters → version 4 at level M).
// Pure functions, no DOM: used on the server to draw an inline SVG.
//
// The algorithm follows the public description of the standard (the same steps as Project Nayuki's MIT-licensed
// reference implementation): data codewords → Reed–Solomon error correction over GF(256) → interleaving →
// function patterns (finders, timing, alignment, format and version bits) → zig-zag placement → mask.

export type Ecc = 'L' | 'M' | 'Q' | 'H';

const ECC_INDEX: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** format bits of each level (the standard's order differs from L, M, Q, H) */
const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };
const MAX_VERSION = 10;

// index 0 unused; versions 1…10
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28], // H
];
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8], // H
];

/** Modules available for data and error correction in a version (everything but function patterns) */
export function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (bytes) a version holds at a level */
export function dataCodewords(ver: number, ecc: Ecc): number {
  const e = ECC_INDEX[ecc];
  return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];
}

/** Centre positions of the alignment patterns along each axis */
export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ── GF(256) Reed–Solomon (polynomial x^8 + x^4 + x^3 + x^2 + 1 = 0x11D) ──

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial coefficients (highest degree first, leading 1 left out) */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Error-correction codewords for one block of data */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
  }
  return result;
}

// ── the symbol ──

export interface QrCode {
  version: number;
  size: number;
  ecc: Ecc;
  mask: number;
  /** modules[y][x], true = dark */
  modules: boolean[][];
}

const getBit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Smallest version that fits `bytes` bytes in byte mode at this level, or null */
export function fitVersion(bytes: number, ecc: Ecc): number | null {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + bytes * 8 <= dataCodewords(v, ecc) * 8) return v;
  }
  return null;
}

/** Data codewords: mode 0100, length, the bytes, terminator, padding 0xEC 0x11 … */
export function dataBytes(bytes: readonly number[], ver: number, ecc: Ecc): number[] {
  const capacity = dataCodewords(ver, ecc) * 8;
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Splits into blocks, adds error correction and interleaves (the final codeword sequence) */
export function addEccAndInterleave(data: readonly number[], ver: number, ecc: Ecc): number[] {
  const e = ECC_INDEX[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push([...dat, ...eccBytes]);
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

class Grid {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFinder(g: Grid, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && xx < g.size && yy >= 0 && yy < g.size) g.setFunction(xx, yy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(g: Grid, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
}

/** 15 format bits (level + mask, BCH-coded, XOR 0x5412) */
export function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(g: Grid, ecc: Ecc, mask: number): void {
  const bits = formatBits(ecc, mask);
  for (let i = 0; i <= 5; i++) g.setFunction(8, i, getBit(bits, i));
  g.setFunction(8, 7, getBit(bits, 6));
  g.setFunction(8, 8, getBit(bits, 7));
  g.setFunction(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) g.setFunction(14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i++) g.setFunction(g.size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) g.setFunction(8, g.size - 15 + i, getBit(bits, i));
  g.setFunction(8, g.size - 8, true); // the dark module
}

function drawVersion(g: Grid, ver: number): void {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = getBit(bits, i);
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    g.setFunction(a, b, bit);
    g.setFunction(b, a, bit);
  }
}

function drawFunctionPatterns(g: Grid, ver: number, ecc: Ecc): void {
  for (let i = 0; i < g.size; i++) {
    g.setFunction(6, i, i % 2 === 0);
    g.setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, g.size - 4, 3);
  drawFinder(g, 3, g.size - 4);
  const pos = alignmentPositions(ver);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) drawAlignment(g, pos[i], pos[j]);
    }
  }
  drawFormat(g, ecc, 0); // placeholder, redrawn with the chosen mask
  drawVersion(g, ver);
}

function drawCodewords(g: Grid, data: readonly number[]): void {
  let i = 0;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? g.size - 1 - vert : vert;
        if (!g.isFunction[y][x] && i < data.length * 8) {
          g.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number): void {
  const f = MASKS[mask];
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.isFunction[y][x] && f(x, y)) g.modules[y][x] = !g.modules[y][x];
}

/** The standard penalty score of a finished symbol (lower is better) */
export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let result = 0;
  const addHistory = (run: number, history: number[]) => {
    if (history[0] === 0) run += size; // the light border before the first run
    history.pop();
    history.unshift(run);
  };
  const countPatterns = (h: number[]) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const terminate = (color: boolean, run: number, history: number[]) => {
    if (color) { addHistory(run, history); run = 0; }
    run += size;
    addHistory(run, history);
    return countPatterns(history);
  };
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      let color = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const m = horizontal ? modules[a][b] : modules[b][a];
        if (m === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          addHistory(run, history);
          if (!color) result += countPatterns(history) * 40;
          color = m;
          run = 1;
        }
      }
      result += terminate(color, run, history) * 40;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * 10;
}

/**
 * Encodes text (UTF-8, byte mode) as a QR symbol. Picks the smallest version that fits (1–10) and the mask with the
 * lowest penalty, unless `mask` is given. Throws when the text is too long for version 10.
 */
export function encodeQr(text: string, opts: { ecc?: Ecc; mask?: number; minVersion?: number } = {}): QrCode {
  const ecc = opts.ecc ?? 'M';
  const bytes = utf8(text);
  let ver = fitVersion(bytes.length, ecc);
  if (ver === null) throw new RangeError(`Text too long for a version ${MAX_VERSION} QR code (${bytes.length} bytes)`);
  ver = Math.max(ver, Math.min(MAX_VERSION, opts.minVersion ?? 1));
  const codewords = addEccAndInterleave(dataBytes(bytes, ver, ecc), ver, ecc);
  const g = new Grid(ver * 4 + 17);
  drawFunctionPatterns(g, ver, ecc);
  drawCodewords(g, codewords);
  let mask = opts.mask ?? -1;
  if (mask < 0 || mask > 7) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(g, m);
      drawFormat(g, ecc, m);
      const p = penalty(g.modules);
      if (p < best) { best = p; mask = m; }
      applyMask(g, m); // undo (XOR)
    }
  }
  applyMask(g, mask);
  drawFormat(g, ecc, mask);
  return { version: ver, size: g.size, ecc, mask, modules: g.modules };
}

/**
 * SVG path data for the dark modules (one unit per module, offset by the quiet zone). Rows of dark modules are
 * merged into one rectangle each, which keeps the path short.
 */
export function qrPath(qr: QrCode, quiet = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) { x++; continue; }
      let w = 1;
      while (x + w < qr.size && qr.modules[y][x + w]) w++;
      parts.push(`M${x + quiet} ${y + quiet}h${w}v1h-${w}z`);
      x += w;
    }
  }
  return parts.join('');
}

/** A complete standalone SVG (black on white, crisp edges), `px` wide (default: 4 px per module) */
export function qrSvg(text: string, opts: { ecc?: Ecc; quiet?: number; px?: number; title?: string } = {}): string {
  const qr = encodeQr(text, { ecc: opts.ecc });
  const quiet = opts.quiet ?? 4;
  const dim = qr.size + quiet * 2;
  const px = opts.px ?? dim * 4;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${px}" height="${px}" shape-rendering="crispEdges"${opts.title ? ` role="img" aria-label="${esc(opts.title)}"` : ' aria-hidden="true"'}>`
    + `<rect width="${dim}" height="${dim}" fill="#fff"/><path fill="#000" d="${qrPath(qr, quiet)}"/></svg>`;
}
