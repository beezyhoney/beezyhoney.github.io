// The repository is public: the owner's admin login emails must never be in any file git would publish
// (tracked files, and untracked files that are not ignored). They belong only in the gitignored .dev.vars locally
// and in the Worker secrets ADMIN_EMAILS / ADMIN_ALIASES. The addresses are put together from pieces here so that this test file
// does not contain them itself.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const at = String.fromCharCode(64);
const LOCAL_PARTS = [['sleo', 'stan', 'ley'].join(''), ['abin', 'ash', 'abi', '1999', '2710'].join('')];
const DOMAIN = ['gm', 'ail', '.', 'com'].join('');
// the owners' login aliases (Worker secret ADMIN_ALIASES): their own addresses on the shop's domain
const ALIASES = [['leo', 'stan', 'ley'].join(''), ['abin', 'ash'].join('')].map((l) => `${l}${at}${['beezy', 'honey', '.', 'in'].join('')}`);
const NEEDLES = [...LOCAL_PARTS.map((l) => `${l}${at}${DOMAIN}`), ...LOCAL_PARTS, ...ALIASES];

/** Files git would publish: tracked + untracked-but-not-ignored, skipping files deleted from the working tree */
function publishableFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  return [...new Set(out.split('\0').filter(Boolean))].filter((f) => {
    try { return statSync(path.join(root, f)).isFile(); } catch { return false; }
  });
}

describe('owner emails stay out of the public repository', () => {
  it('the needles are built correctly (sanity check)', () => {
    expect(NEEDLES).toHaveLength(6);
    for (const n of NEEDLES.slice(0, 2)) expect(n).toMatch(/^[a-z0-9]+@gmail\.com$/);
    for (const n of NEEDLES.slice(4)) expect(n).toMatch(/^[a-z]+@beezyhoney\.in$/);
  });

  it('this test file does not contain the addresses verbatim', () => {
    const me = readFileSync(import.meta.filename, 'latin1').toLowerCase();
    for (const n of NEEDLES) expect(me.includes(n)).toBe(false);
  });

  it('no tracked or publishable untracked file contains either address (or its local part)', () => {
    const files = publishableFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('src/data/catalog.snapshot.json');
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(path.join(root, f), 'latin1').toLowerCase();
      for (const n of NEEDLES) if (text.includes(n)) hits.push(`${f} contains "${n.slice(0, 4)}…"`);
    }
    expect(hits).toEqual([]);
  });

  it('.dev.vars (where the emails may live locally) is ignored by git', () => {
    const ignored = (p: string) => {
      try { execFileSync('git', ['check-ignore', '-q', p], { cwd: root }); return true; } catch { return false; }
    };
    expect(ignored('.dev.vars')).toBe(true);
    expect(ignored('src/data/generated/catalog.json')).toBe(true);
  });
});
