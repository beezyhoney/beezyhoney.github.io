// Size and count summary of a built site (dist/): file counts by type, image counts and the JavaScript
// each page loads. Used for the Phase 0 baseline and by scripts/zero-diff.mjs.
// Usage: node scripts/dist-stats.mjs <distDir> [--out stats.json]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const IMAGE_EXTS = ['webp', 'avif', 'jpg', 'jpeg', 'png', 'gif', 'svg'];

/** Every file under dir, as forward-slash paths relative to dir, sorted */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

export const extOf = (f) => (f.includes('.') ? f.slice(f.lastIndexOf('.') + 1).toLowerCase() : '');

/** Page URL for an HTML file: index.html → /, shop/index.html → /shop/, 404.html → /404.html */
export const pageUrl = (f) => (f === 'index.html' ? '/' : f.endsWith('/index.html') ? `/${f.slice(0, -'index.html'.length)}` : `/${f}`);

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const STATIC_IMPORT_RE = /(?:\bimport|\bfrom)\s*["']([^"']+\.m?js)["']/g;
// Vite / Rolldown write dynamic imports with quotes or backticks: import(`./orderMessage.CJYKy54D.js`)
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["'`]([^"'`$]+\.m?js)["'`]\s*\)/g;

/** JavaScript one HTML page runs: external module files (with their static imports) and inline scripts */
export function pageScripts(dist, htmlFile) {
  const html = readFileSync(path.join(dist, htmlFile), 'utf8');
  const external = new Set();
  const dynamic = new Set();
  let inlineBytes = 0;
  let inlineGzip = 0;
  let inlineCount = 0;
  for (const [, attrs, body] of html.matchAll(SCRIPT_RE)) {
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
    if (type && type !== 'module' && type !== 'text/javascript') continue; // JSON data, JSON-LD
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (src) {
      if (src.startsWith('/')) external.add(src.slice(1));
      else external.add(`EXTERNAL:${src}`);
    } else if (body.trim()) {
      inlineCount++;
      inlineBytes += Buffer.byteLength(body);
      inlineGzip += gzipSync(body).length;
    }
  }
  // follow static imports between chunks; dynamic imports are listed but not counted as page load
  const queue = [...external].filter((f) => !f.startsWith('EXTERNAL:'));
  while (queue.length) {
    const f = queue.shift();
    let code;
    try { code = readFileSync(path.join(dist, f), 'utf8'); } catch { continue; }
    const dir = path.posix.dirname(f);
    for (const [, spec] of code.matchAll(STATIC_IMPORT_RE)) {
      const dep = spec.startsWith('/') ? spec.slice(1) : path.posix.normalize(path.posix.join(dir, spec));
      if (!external.has(dep)) { external.add(dep); queue.push(dep); }
    }
    for (const [, spec] of code.matchAll(DYNAMIC_IMPORT_RE)) {
      dynamic.add(spec.startsWith('/') ? spec.slice(1) : path.posix.normalize(path.posix.join(dir, spec)));
    }
  }
  const files = [...external].sort();
  let bytes = 0;
  let gzip = 0;
  for (const f of files) {
    if (f.startsWith('EXTERNAL:')) continue;
    const buf = readFileSync(path.join(dist, f));
    bytes += buf.length;
    gzip += gzipSync(buf).length;
  }
  // on-demand chunks (dynamic imports, with their own static imports) that the page may load later
  const onDemand = [...dynamic].filter((f) => !external.has(f));
  const seen = new Set([...external, ...onDemand]);
  for (let i = 0; i < onDemand.length; i++) {
    let code;
    try { code = readFileSync(path.join(dist, onDemand[i]), 'utf8'); } catch { continue; }
    const dir = path.posix.dirname(onDemand[i]);
    for (const [, spec] of code.matchAll(STATIC_IMPORT_RE)) {
      const dep = spec.startsWith('/') ? spec.slice(1) : path.posix.normalize(path.posix.join(dir, spec));
      if (!seen.has(dep)) { seen.add(dep); onDemand.push(dep); }
    }
  }
  let onDemandGzip = 0;
  for (const f of onDemand) { try { onDemandGzip += gzipSync(readFileSync(path.join(dist, f))).length; } catch { /* missing */ } }
  return {
    files,
    dynamicImports: onDemand.sort(),
    onDemandGzipBytes: onDemandGzip,
    fileBytes: bytes,
    fileGzipBytes: gzip,
    inlineScripts: inlineCount,
    inlineBytes,
    inlineGzipBytes: inlineGzip,
    totalBytes: bytes + inlineBytes,
    totalGzipBytes: gzip + inlineGzip,
  };
}

export function distStats(dist) {
  const files = listFiles(dist);
  const byExt = {};
  let totalBytes = 0;
  for (const f of files) {
    const e = extOf(f) || '(none)';
    byExt[e] = (byExt[e] ?? 0) + 1;
    totalBytes += statSync(path.join(dist, f)).size;
  }
  const images = Object.fromEntries(IMAGE_EXTS.filter((e) => byExt[e]).map((e) => [e, byExt[e]]));
  const pages = {};
  for (const f of files.filter((x) => extOf(x) === 'html')) pages[pageUrl(f)] = pageScripts(dist, f);
  const jsFiles = files.filter((f) => extOf(f) === 'js');
  return {
    fileCount: files.length,
    totalBytes,
    byExt: Object.fromEntries(Object.entries(byExt).sort(([a], [b]) => a.localeCompare(b))),
    htmlPages: Object.keys(pages).length,
    webpCount: byExt.webp ?? 0,
    imageCount: Object.values(images).reduce((a, b) => a + b, 0),
    images,
    jsFileCount: jsFiles.length,
    jsTotalBytes: jsFiles.reduce((a, f) => a + statSync(path.join(dist, f)).size, 0),
    pages,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
  const outIdx = args.indexOf('--out');
  if (!dir) { console.error('Usage: node scripts/dist-stats.mjs <distDir> [--out stats.json]'); process.exit(2); }
  const stats = distStats(path.resolve(dir));
  const json = JSON.stringify(stats, null, 2) + '\n';
  if (outIdx >= 0) writeFileSync(args[outIdx + 1], json);
  else process.stdout.write(json);
  if (outIdx >= 0) {
    console.log(`${stats.fileCount} files, ${stats.htmlPages} pages, ${stats.webpCount} WebP, ${stats.jsFileCount} JS files (${stats.jsTotalBytes} bytes)`);
  }
}
