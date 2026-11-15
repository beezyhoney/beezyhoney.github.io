// Zero-diff gate: proves two builds of the site are the same, apart from hashed asset names.
//
// Compares every HTML, XML, JSON, TXT, CSS and JS file after replacing /_astro hashed file names
// (e.g. motion.BJkHjrFr.js, murungai-main.CCwZtE_W_Z1H55HG.webp) with stable names. Hashed images and fonts are
// renamed after a hash of their bytes, so a changed photo still shows up as a difference. Every other file
// (public/ images, icons) is compared byte for byte. Image counts per type are compared too.
//
// Usage: node scripts/zero-diff.mjs <baselineDir> <newDir> [--allow <path-or-glob>]... [--allow-file <list.txt>]
//   --allow       a file (as reported, e.g. 'shop/index.html' or '_astro/site.~.js') or glob ('shop/*/index.html',
//                 '**/*.xml') whose difference is expected; '[image counts]' allows a change in image counts
//   --allow-file  a text file with one --allow pattern per line (# comments allowed)
// Exit code: 0 no differences (or only allowed ones), 1 unexpected differences, 2 bad usage.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_EXTS, extOf, listFiles } from './dist-stats.mjs';

const TEXT_EXTS = new Set(['html', 'htm', 'xml', 'json', 'txt', 'css', 'js', 'mjs', 'svg', 'webmanifest', 'map']);
const HASHED_RE = /^(.+)\.([A-Za-z0-9_-]{8})(?:_([A-Za-z0-9_-]+))?\.([A-Za-z0-9]+)$/;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function usage(msg) {
  if (msg) console.error(`zero-diff: ${msg}`);
  console.error('Usage: node scripts/zero-diff.mjs <baselineDir> <newDir> [--allow <path-or-glob>]... [--allow-file <list.txt>]');
  process.exit(2);
}

/** Glob to RegExp: '**' any depth, '*' within one path segment, '?' one character */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Reads one build: maps every file to a stable name and, for text files, to content with hashed names replaced.
 * @returns {Map<string, {file: string, text?: string, sha: string, bytes: number}>}
 */
function readBuild(dir) {
  const files = listFiles(dir);
  const token = new Map(); // hashed basename -> stable basename
  const used = new Map();
  for (const f of files.filter((x) => x.startsWith('_astro/')).sort()) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const m = HASHED_RE.exec(base);
    if (!m) continue;
    const [, name, , , ext] = m;
    let t = TEXT_EXTS.has(ext.toLowerCase())
      ? `${name}.~.${ext}`
      : `${name}.~${sha(readFileSync(path.join(dir, f))).slice(0, 12)}.${ext}`;
    if (used.has(t) && TEXT_EXTS.has(ext.toLowerCase())) {
      const n = used.get(t) + 1; used.set(t, n); t = `${name}.~${n}.${ext}`;
    } else used.set(t, 1);
    token.set(base, t);
  }
  const names = [...token.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const nameRe = names.length ? new RegExp(names.join('|'), 'g') : null;
  const normalise = (s) => (nameRe ? s.replace(nameRe, (x) => token.get(x)) : s);

  const out = new Map();
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const stable = token.has(base) ? f.slice(0, f.length - base.length) + token.get(base) : f;
    const buf = readFileSync(path.join(dir, f));
    if (TEXT_EXTS.has(extOf(f))) {
      const text = normalise(buf.toString('utf8'));
      out.set(stable, { file: f, text, sha: sha(text), bytes: buf.length });
    } else {
      out.set(stable, { file: f, sha: sha(buf), bytes: buf.length });
    }
  }
  return out;
}

/** Splits text into short lines so a minified one-line page still gives a readable diff */
function lines(text, ext) {
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return text.replace(/>/g, '>\n').split('\n');
  if (['css', 'js', 'mjs'].includes(ext)) return text.replace(/([;{}])/g, '$1\n').split('\n');
  return text.split('\n');
}

/** First differing region with one line of context: '-' baseline, '+' new */
function shortDiff(a, b, ext, maxLines = 8) {
  const A = lines(a, ext);
  const B = lines(b, ext);
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length - 1;
  let endB = B.length - 1;
  while (endA >= start && endB >= start && A[endA] === B[endB]) { endA--; endB--; }
  const cut = (s) => (s.length > 220 ? `${s.slice(0, 220)}…` : s);
  const out = [];
  if (start > 0) out.push(`    ${cut(A[start - 1])}`);
  const removed = A.slice(start, endA + 1);
  const added = B.slice(start, endB + 1);
  removed.slice(0, maxLines).forEach((l) => out.push(`  - ${cut(l)}`));
  if (removed.length > maxLines) out.push(`  - … ${removed.length - maxLines} more line(s)`);
  added.slice(0, maxLines).forEach((l) => out.push(`  + ${cut(l)}`));
  if (added.length > maxLines) out.push(`  + … ${added.length - maxLines} more line(s)`);
  return out.join('\n');
}

function imageCounts(build) {
  const counts = {};
  for (const [stable] of build) {
    const e = extOf(stable);
    if (IMAGE_EXTS.includes(e)) counts[e] = (counts[e] ?? 0) + 1;
  }
  return counts;
}

/** Compares two build folders. Returns { differences: [{kind, path, detail}], counts } */
export function compareBuilds(dirA, dirB) {
  const A = readBuild(dirA);
  const B = readBuild(dirB);
  const differences = [];
  for (const [p, a] of A) {
    const b = B.get(p);
    if (!b) { differences.push({ kind: 'removed', path: p, detail: `only in baseline (${a.file})` }); continue; }
    if (a.sha === b.sha) continue;
    const ext = extOf(p);
    differences.push({
      kind: 'changed', path: p,
      detail: a.text !== undefined ? shortDiff(a.text, b.text, ext) : `  binary: ${a.bytes} -> ${b.bytes} bytes`,
    });
  }
  for (const [p, b] of B) if (!A.has(p)) differences.push({ kind: 'added', path: p, detail: `only in new build (${b.file})` });
  const ca = imageCounts(A);
  const cb = imageCounts(B);
  const exts = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort();
  const countDiff = exts.filter((e) => (ca[e] ?? 0) !== (cb[e] ?? 0));
  if (countDiff.length) {
    differences.push({ kind: 'changed', path: '[image counts]', detail: countDiff.map((e) => `  ${e}: ${ca[e] ?? 0} -> ${cb[e] ?? 0}`).join('\n') });
  }
  differences.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { differences, files: [A.size, B.size], images: [ca, cb] };
}

// ---------- CLI ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dirs = [];
  const allow = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow') { if (!args[i + 1]) usage('--allow needs a value'); allow.push(args[++i]); }
    else if (args[i] === '--allow-file') {
      const f = args[++i];
      if (!f || !existsSync(f)) usage(`--allow-file: cannot read ${f}`);
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) { const t = line.replace(/#.*/, '').trim(); if (t) allow.push(t); }
    } else if (args[i].startsWith('--')) usage(`unknown option ${args[i]}`);
    else dirs.push(args[i]);
  }
  if (dirs.length !== 2) usage();
  for (const d of dirs) if (!existsSync(d) || !statSync(d).isDirectory()) usage(`not a folder: ${d}`);
  const allowRes = allow.map((g) => [g, globRe(g)]);
  const { differences, files, images } = compareBuilds(dirs[0], dirs[1]);
  const allowed = [];
  const unexpected = [];
  for (const d of differences) (allowRes.some(([, re]) => re.test(d.path)) ? allowed : unexpected).push(d);
  const fmt = (o) => Object.entries(o).map(([e, n]) => `${n} ${e}`).join(', ') || 'none';
  console.log(`zero-diff: ${dirs[0]} (${files[0]} files) vs ${dirs[1]} (${files[1]} files)`);
  console.log(`images: ${fmt(images[0])} | ${fmt(images[1])}`);
  for (const [title, list] of [['UNEXPECTED differences', unexpected], ['allowed differences', allowed]]) {
    if (!list.length) continue;
    console.log(`\n${title} (${list.length}):`);
    for (const d of list) console.log(`${d.kind.toUpperCase().padEnd(8)} ${d.path}\n${d.detail}`);
  }
  for (const [g, re] of allowRes) if (!differences.some((d) => re.test(d.path))) console.log(`note: --allow ${g} matched nothing`);
  console.log(unexpected.length ? `\nFAIL: ${unexpected.length} unexpected difference(s)` : `\nOK: no unexpected differences${allowed.length ? ` (${allowed.length} allowed)` : ''}`);
  process.exit(unexpected.length ? 1 : 0);
}
