// src/worker.ts (scheduled), src/server/jobs.ts (real jobs + lazy trigger), src/pages/api/health.json.ts.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../../src/worker';
import { LAZY_MIN_INTERVAL_MS, maybeRunJobsLazily, resetLazyJobsThrottle, runDueJobs } from '../../../src/server/jobs';
import { GET as healthGET, health } from '../../../src/pages/api/health.json';

afterEach(() => {
  vi.restoreAllMocks();
  resetLazyJobsThrottle();
});

describe('worker entry', () => {
  it('exports fetch (Astro handler) and scheduled', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('scheduled() runs the due jobs with the cron that fired', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = createScheduledController({ cron: '*/15 * * * *', scheduledTime: Date.UTC(2026, 10, 15, 21, 0) });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[jobs] runDueJobs trigger=cron cron=*/15 * * * *'));
  });

  it('runDueJobs runs the real jobs once per period, records them in job_runs and never throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const at = Date.UTC(2026, 11, 1, 10, 0); // 15:30 IST, after the cron test above
    const first = await runDueJobs(env, createExecutionContext(), { trigger: 'manual', scheduledTime: at });
    expect(first.trigger).toBe('manual');
    expect(first.ran).toEqual(expect.arrayContaining(['cleanup', 'reconcile']));
    const rows = await env.DB.prepare("SELECT job, ok FROM job_runs WHERE job IN ('cleanup','reconcile') AND started_at >= '2026-12-01' ORDER BY job").all<{ job: string; ok: number }>();
    expect(rows.results).toEqual([{ job: 'cleanup', ok: 1 }, { job: 'reconcile', ok: 1 }]);
    const again = await runDueJobs(env, createExecutionContext(), { trigger: 'manual', scheduledTime: at + 60_000 });
    expect(again.ran).not.toContain('cleanup');
    expect(again.ran).not.toContain('reconcile');
  });

  it('runDueJobs never throws when D1 fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenDb = { prepare: () => { throw new Error('D1 down'); }, batch: () => { throw new Error('D1 down'); } };
    const res = await runDueJobs({ ...env, DB: brokenDb } as never, createExecutionContext(), { trigger: 'manual', scheduledTime: Date.now() });
    expect(res.ran).toEqual([]);
  });
});

describe('lazy job trigger', () => {
  it('schedules at most one lazy run per isolate per interval, inside waitUntil', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException() {} } as unknown as ExecutionContext;
    const t0 = 1_000_000_000;
    expect(maybeRunJobsLazily(env, ctx, t0)).toBe(true);
    expect(maybeRunJobsLazily(env, ctx, t0 + 1000)).toBe(false);
    expect(maybeRunJobsLazily(env, ctx, t0 + LAZY_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(maybeRunJobsLazily(env, ctx, t0 + LAZY_MIN_INTERVAL_MS)).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(waitUntil.mock.calls.map(([p]) => p));
  });
});

describe('/api/health.json', () => {
  it('reports every binding ok', async () => {
    const h = await health(env, new Date('2026-11-15T10:00:00.123Z'));
    expect(h).toEqual({
      ok: true,
      service: 'beezyhoney',
      time: '2026-11-15T10:00:00Z',
      checks: { db: 'ok', media: 'ok', backups: 'ok', mail: 'ok' },
    });
  });

  it('reports missing and broken bindings without throwing', async () => {
    const brokenDb = { prepare: () => { throw new Error('D1 down'); } } as unknown as D1Database;
    const h = await health({ DB: brokenDb });
    expect(h.ok).toBe(false);
    expect(h.checks).toEqual({ db: 'error', media: 'missing', backups: 'missing', mail: 'missing' });
  });

  it('GET answers JSON, never cached, and is prerender = false', async () => {
    const mod = await import('../../../src/pages/api/health.json');
    expect(mod.prerender).toBe(false);
    const res = await healthGET({} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });
});

describe('worker test project wiring', () => {
  it('uses deterministic test secrets, never the local .dev.vars values', () => {
    expect(env.ADMIN_EMAILS).toBe('owner@example.test,second-owner@example.test');
    expect((env as unknown as { ADMIN_ALIASES?: string }).ADMIN_ALIASES).toBe(''); // never the real aliases of .dev.vars
    expect(env.DEV_ADMIN_EMAIL).toBe('dev@example.test');
    expect(env.LOGIN_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });
});
