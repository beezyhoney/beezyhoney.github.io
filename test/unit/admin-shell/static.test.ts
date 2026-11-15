// Static rules for the admin shell files.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

const adminFiles = walk('src/admin');
const codeFiles = adminFiles.filter((f) => /\.(astro|ts|css)$/.test(f));
const shellPages = ['src/pages/admin/index.astro', 'src/pages/admin/styleguide.astro'];

describe('admin shell files', () => {
  it('the shell pages render on demand (never prerendered)', () => {
    for (const p of shellPages) expect(read(p), p).toMatch(/^export const prerender = false;$/m);
  });

  it('no third-party URLs in admin code or the shell pages', () => {
    for (const f of [...codeFiles, ...shellPages]) {
      const urls = read(f).match(/https?:\/\/[^\s'"`)<]+/g) ?? [];
      // only the SVG namespace (inside a data: URI) and our own domain may appear; 'http://x' is just a base for
      // parsing relative paths with new URL() and is never fetched
      const bad = urls.filter((u) => u !== 'http://x' && !u.startsWith('http://www.w3.org/2000/svg') && !/^https:\/\/([a-z-]+\.)?beezyhoney\.in\b/.test(u));
      expect(bad, f).toEqual([]);
    }
  });

  it('the admin never loads the public site CSS, GSAP, Lenis or the public layout', () => {
    for (const f of [...codeFiles, ...shellPages]) {
      const src = read(f);
      // imports only (a comment may mention global.css as the source of the colour values)
      expect(src, f).not.toMatch(/(?:^|\n)\s*(?:import|@import)\b[^;\n]*(?:styles\/global\.css|['"]gsap|['"]lenis|layouts\/Base)/);
    }
  });

  it('fonts are self-hosted through @fontsource', () => {
    const layout = read('src/admin/AdminLayout.astro');
    expect(layout).toMatch(/@fontsource\/mukta-malar\/400\.css/);
    expect(layout).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });

  it('no personal email addresses in admin files (the repo is public)', () => {
    for (const f of [...adminFiles, ...shellPages]) {
      const emails = read(f).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? [];
      expect(emails.filter((e) => !/@example\.(test|com)$/.test(e)), f).toEqual([]);
    }
  });

  it('every admin.css colour token from the brand matches src/styles/global.css', () => {
    const pub = read('src/styles/global.css');
    const css = read('src/admin/admin.css');
    for (const token of ['cream', 'cream-2', 'paper', 'honey', 'honey-deep', 'amber', 'choc', 'cocoa', 'ink-2', 'ink-3']) {
      const a = new RegExp(`--${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(pub)?.[1];
      const b = new RegExp(`--${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(css)?.[1];
      expect(b?.toUpperCase(), token).toBe(a?.toUpperCase());
    }
  });

  it('the README documents every component, form reader and helper module (screen agents rely on it)', () => {
    const readme = read('src/admin/README.md');
    const internal = new Set(['BrandMark', 'ConfirmDialog', 'SiteChip']); // used by the layout only
    for (const f of adminFiles.filter((x) => /^src\/admin\/components\/[A-Za-z]+\.astro$/.test(x))) {
      const name = path.basename(f, '.astro');
      if (!internal.has(name)) expect(readme, name).toContain(`\`${name}\``);
    }
    const forms = read('src/admin/forms.ts');
    const methods = [...forms.matchAll(/^ {2}([a-zA-Z]+)(?:<[^>]+>)?\(/gm)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(15);
    for (const m of methods) expect(readme, `form.${m}`).toMatch(new RegExp(`form\\.${m}\\b`));
    for (const mod of ['forms.ts', 'flash.ts', 'format.ts', 'parse.ts', 'status.ts', 'nav.ts', 'strings.ts', 'icons.ts', 'chart.ts']) {
      expect(readme, mod).toContain(`\`${mod}\``);
    }
  });

  it('client scripts do not pull in the full word list or Node APIs', () => {
    for (const f of adminFiles.filter((x) => x.startsWith('src/admin/client/'))) {
      const src = read(f);
      // words reach the browser as JSON from AdminLayout; only types may come from ../strings
      expect(src, f).not.toMatch(/^import (?!type )[^;]*from ['"]\.\.\/strings['"]/m);
      expect(src, f).not.toMatch(/from ['"]node:/);
    }
  });
});

describe('JSON inside <script> blocks (review: security 6)', () => {
  it('toJson escapes every "<", so data can never close the script; every set:html JSON block uses it', async () => {
    const { toJson } = await import('../../../src/lib/json');
    const out = toJson({ note: '</script><script>alert(1)</script>', n: 1 });
    expect(out).not.toContain('<');
    expect(JSON.parse(out)).toEqual({ note: '</script><script>alert(1)</script>', n: 1 });
    const offenders = walk('src').filter((f) => f.endsWith('.astro'))
      .filter((f) => /set:html=\{JSON\.stringify\((?![^}]*\.replace\(\/<\/g)/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
