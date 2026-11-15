// scripts/predeploy-check.mjs: the last gate before `wrangler deploy`. Every check on a fake dist in a temp folder.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isPlaceholderId, liveOrigin, localChecks, parseJsonc, predeployCheck } from '../../../scripts/predeploy-check.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'bz-predeploy-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const REAL = {
  d1_databases: [{ binding: 'DB', database_name: 'beezy', database_id: '7b1f6c2e-93d4-4a51-b0e7-5f2a8c9d1e34' }],
  kv_namespaces: [{ binding: 'MEDIA', id: 'a3f9c27e51b84d06b9e2c17f40d8a6b5' }, { binding: 'BACKUPS', id: '5e8d1b7c9a2f4630b4c1e9d7a2f8b305' }],
  vars: { PUBLIC_ORIGIN: 'https://beezyhoney.in' },
};

let n = 0;
function fakeDist(o: { source?: string; siteVersion?: number; config?: unknown; serverCode?: string; extra?: Record<string, string> } = {}) {
  const d = path.join(tmp, `dist-${++n}`);
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    writeFileSync(path.join(d, rel), text);
  };
  put('client/index.html', '<!doctype html><title>x</title>');
  put('client/build.json', JSON.stringify({ siteVersion: o.siteVersion ?? 5, liveVersion: 9, builtAt: '2026-11-15T00:00:00Z', commit: 'abc', source: o.source ?? 'remote' }));
  put('server/entry.mjs', o.serverCode ?? 'export default { fetch() {} };');
  put('server/entry.mjs.map', '{"sourcesContent":["if (import.meta.env.MODE === \'e2e\') globalThis.BEEZY_E2E_HOOK = 1; DEV_ADMIN_EMAIL"]}');
  put('server/wrangler.json', JSON.stringify(o.config ?? REAL));
  for (const [rel, text] of Object.entries(o.extra ?? {})) put(rel, text);
  return d;
}

const liveAt = (version: number | null, status = 200) => async () =>
  new Response(version === null ? 'nope' : JSON.stringify({ siteVersion: version }), { status, headers: { 'content-type': 'application/json' } });
const check = (dist: string, env: Record<string, string> = {}, fetchImpl = liveAt(4), args: string[] = []) =>
  predeployCheck(['--dist', dist, ...args], env, { fetchImpl, log: () => {} });

describe('predeploy-check', () => {
  it('passes a complete production build made from the live catalog', async () => {
    const r = await check(fakeDist());
    expect(r).toEqual({ ok: true, problems: [], notes: ['live site version 4, this build 5'] });
  });

  it('refuses a missing or incomplete dist', async () => {
    const r = await check(path.join(tmp, 'nothing-here'));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/missing .*build\.json[\s\S]*missing .*entry\.mjs/);
  });

  it('refuses an e2e or dev build (the strings are only checked outside source maps)', async () => {
    const e2e = await check(fakeDist({ serverCode: 'globalThis.BEEZY_E2E_HOOK ??= [];' }));
    expect(e2e.problems).toEqual([expect.stringMatching(/entry\.mjs contains BEEZY_E2E_HOOK/)]);
    const dev = await check(fakeDist({ extra: { 'server/chunks/auth.mjs': 'env.DEV_ADMIN_EMAIL' } }));
    expect(dev.problems).toEqual([expect.stringMatching(/auth\.mjs contains DEV_ADMIN_EMAIL/)]);
    // the local preview copy of .dev.vars names the variable but is never uploaded
    expect((await check(fakeDist({ extra: { 'server/.dev.vars': 'DEV_ADMIN_EMAIL=dev@example.test\n' } }))).ok).toBe(true);
  });

  it('refuses local secrets or files that would shadow Worker routes in dist/client', async () => {
    const r = await check(fakeDist({ extra: { 'client/.dev.vars': 'LOGIN_SECRET=x', 'client/admin/index.html': 'x', 'client/api/live.json': '{}' } }));
    expect(r.problems.join('\n')).toMatch(/\.dev\.vars exists[\s\S]*admin\/ has files[\s\S]*api\/ has files/);
  });

  it('refuses a snapshot or file build unless ALLOW_SNAPSHOT_DEPLOY=1', async () => {
    const snap = fakeDist({ source: 'snapshot' });
    expect((await check(snap)).problems).toEqual([expect.stringMatching(/committed snapshot, not the live catalog/)]);
    expect((await check(fakeDist({ source: 'file' }))).problems).toEqual([expect.stringMatching(/catalog file/)]);
    const allowed = await check(snap, { ALLOW_SNAPSHOT_DEPLOY: '1' });
    expect(allowed.ok).toBe(true);
    expect(allowed.notes[0]).toMatch(/allowed by ALLOW_SNAPSHOT_DEPLOY=1/);
  });

  it('accepts the committed wrangler.jsonc (real ids) and refuses placeholder resource ids', async () => {
    const committed = parseJsonc(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
    expect(committed.vars.PUBLIC_ORIGIN).toBe('https://beezyhoney.in'); // "//" inside strings survives the comment stripping
    expect((await check(fakeDist({ config: committed }))).problems).toEqual([]);
    const placeholder = {
      ...committed,
      d1_databases: committed.d1_databases.map((d: { database_id: string }) => ({ ...d, database_id: '00000000-0000-4000-8000-000000000000' })),
      kv_namespaces: committed.kv_namespaces.map((k: { id: string }, i: number) => ({ ...k, id: `0000000000000000000000000000000${i + 1}` })),
    };
    const r = await check(fakeDist({ config: placeholder }));
    expect(r.problems).toEqual([
      'D1 binding DB still has the placeholder database_id (fill in the real id in wrangler.jsonc)',
      'KV binding MEDIA still has a placeholder id (fill in the real id in wrangler.jsonc)',
      'KV binding BACKUPS still has a placeholder id (fill in the real id in wrangler.jsonc)',
    ]);
    expect(isPlaceholderId('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(isPlaceholderId('00000000000000000000000000000012')).toBe(true);
    expect(isPlaceholderId(REAL.kv_namespaces[0].id)).toBe(false);
  });

  it('refuses a Worker config whose PUBLIC_HOSTS lists localhost or 127.0.0.1 (review: security 3)', async () => {
    const r = await check(fakeDist({ config: { ...REAL, vars: { ...REAL.vars, PUBLIC_HOSTS: 'beezyhoney.in, LOCALHOST,127.0.0.1' } } }));
    expect(r.problems).toEqual(['PUBLIC_HOSTS in the Worker config lists localhost and 127.0.0.1: local names belong in .dev.vars only']);
    expect((await check(fakeDist({ config: { ...REAL, vars: { ...REAL.vars, PUBLIC_HOSTS: 'beezyhoney.in,next.beezyhoney.in' } } }))).problems).toEqual([]);
  });

  it('refuses a downgrade of the live site unless ALLOW_DOWNGRADE=1; goes on when the live version is unknown', async () => {
    const dist = fakeDist({ siteVersion: 5 });
    const down = await check(dist, {}, liveAt(6));
    expect(down.problems).toEqual([expect.stringMatching(/^downgrade: https:\/\/beezyhoney\.in already shows site version 6, this build has 5/)]);
    expect((await check(dist, { ALLOW_DOWNGRADE: '1' }, liveAt(6))).ok).toBe(true);
    expect((await check(dist, {}, liveAt(5))).ok).toBe(true); // a rebuild of the same version is fine
    const unknown = await check(dist, {}, liveAt(null, 404));
    expect(unknown).toMatchObject({ ok: true, notes: [expect.stringMatching(/could not read https:\/\/beezyhoney\.in\/build\.json \(HTTP 404\)/)] });
    const offline = await check(dist, {}, async () => { throw new Error('offline'); });
    expect(offline.ok).toBe(true);
    expect((await check(dist, {}, liveAt(9), ['--no-live'])).ok).toBe(true);
  });

  it('finds the live site: --live, LIVE_ORIGIN, the CATALOG_URL origin, then PUBLIC_ORIGIN', () => {
    expect(liveOrigin(['--live', 'https://next.beezyhoney.in/x'], {}, REAL)).toBe('https://next.beezyhoney.in');
    expect(liveOrigin([], { LIVE_ORIGIN: 'https://a.example' }, REAL)).toBe('https://a.example');
    expect(liveOrigin([], { CATALOG_URL: 'https://next.beezyhoney.in/api/catalog.json' }, REAL)).toBe('https://next.beezyhoney.in');
    expect(liveOrigin([], {}, REAL)).toBe('https://beezyhoney.in');
    expect(liveOrigin([], { LIVE_ORIGIN: 'http://evil.example' }, {})).toBeNull();
    expect(liveOrigin(['--no-live'], { LIVE_ORIGIN: 'https://a.example' }, REAL)).toBeNull();
  });

  it('localChecks works without the network', () => {
    expect(localChecks(fakeDist()).problems).toEqual([]);
  });

  it('the command line exits 1 with the list of problems', () => {
    const r = spawnSync(process.execPath, ['scripts/predeploy-check.mjs', '--dist', fakeDist({ source: 'snapshot' }), '--no-live'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_SNAPSHOT_DEPLOY: '', ALLOW_DOWNGRADE: '' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^predeploy-check: NOT deploying \(1 problem\):/);
    const ok = spawnSync(process.execPath, ['scripts/predeploy-check.mjs', '--dist', fakeDist(), '--no-live'], { cwd: root, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/predeploy-check: OK/);
  });
});
