// src/middleware.ts in workerd with the vars from wrangler.jsonc (PUBLIC_HOSTS, ADMIN_HOST).
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_HEADERS,
  areaOf,
  hostConfigFrom,
  hostKind,
  isAllowed,
  isSameOriginRequest,
  isUnsafeMethod,
  notFoundPage,
  onRequest,
} from '../../../src/middleware';
import { resetLazyJobsThrottle } from '../../../src/server/jobs';

const cfg = hostConfigFrom(env);

interface FakeCtx {
  isPrerendered: boolean;
  routePattern: string;
  url: URL;
  request: Request;
  locals: Record<string, unknown>;
}

function ctx(url: string, init: RequestInit & { routePattern?: string; prerendered?: boolean; waitUntil?: (p: Promise<unknown>) => void } = {}): FakeCtx {
  const u = new URL(url);
  const locals: Record<string, unknown> = {};
  if (init.waitUntil) locals.cfContext = { waitUntil: init.waitUntil, passThroughOnException() {} };
  return {
    isPrerendered: init.prerendered ?? false,
    routePattern: init.routePattern ?? (u.pathname.replace(/\/$/, '') || '/'),
    url: u,
    request: new Request(u, init),
    locals,
  };
}

async function run(c: FakeCtx, body = 'route body') {
  const next = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }));
  const res = (await onRequest(c as never, next as never)) as Response;
  return { res, next };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetLazyJobsThrottle();
});

describe('host and route classification', () => {
  it('reads the hosts from wrangler.jsonc vars', () => {
    expect(cfg.publicHosts).toEqual(['beezyhoney.in', 'next.beezyhoney.in', 'localhost', '127.0.0.1']);
    expect(cfg.adminHost).toBe('admin.beezyhoney.in');
  });

  it('classifies hosts (case and trailing dot insensitive)', () => {
    expect(hostKind('beezyhoney.in', cfg)).toBe('public');
    expect(hostKind('BEEZYHONEY.IN.', cfg)).toBe('public');
    expect(hostKind('next.beezyhoney.in', cfg)).toBe('public');
    expect(hostKind('admin.beezyhoney.in', cfg)).toBe('admin');
    expect(hostKind('localhost', cfg)).toBe('local');
    expect(hostKind('127.0.0.1', cfg)).toBe('local');
    expect(hostKind('www.beezyhoney.in', cfg)).toBe('unknown');
    expect(hostKind('beezyhoney.in.evil.example', cfg)).toBe('unknown');
    expect(hostKind('', cfg)).toBe('unknown');
  });

  it('treats localhost as unknown when it is not listed in PUBLIC_HOSTS (production could drop it)', () => {
    const prod = hostConfigFrom({ PUBLIC_HOSTS: 'beezyhoney.in', ADMIN_HOST: 'admin.beezyhoney.in' });
    expect(hostKind('localhost', prod)).toBe('unknown');
  });

  it('fails closed when the vars are missing', () => {
    const none = hostConfigFrom({});
    expect(hostKind('beezyhoney.in', none)).toBe('unknown');
    expect(hostKind('admin.beezyhoney.in', none)).toBe('unknown');
  });

  it('classifies route patterns', () => {
    expect(areaOf('/api/live.json')).toBe('api');
    expect(areaOf('/media/uploads/[file]')).toBe('media');
    expect(areaOf('/admin')).toBe('admin');
    expect(areaOf('/admin/orders/[id]')).toBe('admin');
    expect(areaOf('/administrator')).toBe('other');
    expect(areaOf('/_image')).toBe('image');
    expect(areaOf('/404')).toBe('error');
    expect(areaOf('/shop/[slug]')).toBe('other');
  });

  it('allows each area only on its hosts', () => {
    expect(isAllowed('public', 'api')).toBe(true);
    expect(isAllowed('public', 'media')).toBe(true);
    expect(isAllowed('public', 'admin')).toBe(false);
    expect(isAllowed('public', 'image')).toBe(false);
    expect(isAllowed('admin', 'admin')).toBe(true);
    expect(isAllowed('admin', 'api')).toBe(false);
    expect(isAllowed('admin', 'media')).toBe(false);
    expect(isAllowed('local', 'admin')).toBe(true);
    expect(isAllowed('local', 'api')).toBe(true);
    expect(isAllowed('local', 'other')).toBe(false);
    expect(isAllowed('unknown', 'api')).toBe(false);
    expect(isAllowed('unknown', 'error')).toBe(false);
  });

  it('knows the unsafe methods', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) expect(isUnsafeMethod(m)).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(isUnsafeMethod(m)).toBe(true);
  });

  it('accepts same-origin proof only', () => {
    const url = new URL('https://admin.beezyhoney.in/admin/');
    const req = (h: Record<string, string>) => new Request(url, { method: 'POST', headers: h });
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }), url)).toBe(true);
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-site' }), url)).toBe(false);
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'cross-site', origin: 'https://admin.beezyhoney.in' }), url)).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'https://admin.beezyhoney.in' }), url)).toBe(true);
    expect(isSameOriginRequest(req({ origin: 'https://beezyhoney.in' }), url)).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'null' }), url)).toBe(false);
    expect(isSameOriginRequest(req({}), url)).toBe(false);
  });
});

describe('onRequest', () => {
  it('leaves prerendered pages alone', async () => {
    const { res, next } = await run(ctx('https://evil.example/', { prerendered: true, routePattern: '/' }));
    expect(next).toHaveBeenCalledOnce();
    expect(await res.text()).toBe('route body');
  });

  it('serves /api on the public host with nosniff and without admin headers', async () => {
    const { res, next } = await run(ctx('https://beezyhoney.in/api/health.json'));
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it.each([
    ['https://beezyhoney.in/admin/', '/admin'],
    ['https://next.beezyhoney.in/admin/orders/1/', '/admin/orders/[id]'],
    ['https://admin.beezyhoney.in/api/live.json', '/api/live.json'],
    ['https://admin.beezyhoney.in/media/uploads/x.jpg', '/media/uploads/[file]'],
    ['https://evil.example/api/health.json', '/api/health.json'],
    ['https://evil.example/admin/', '/admin'],
    ['https://beezyhoney.in/_image/?href=x', '/_image'],
    ['https://www.beezyhoney.in/api/live.json', '/api/live.json'],
  ])('404 for %s', async (url, routePattern) => {
    const { res, next } = await run(ctx(url, { routePattern }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('uses the matched route, not the raw path (/%61dmin/ on the public host is still admin)', async () => {
    const { res, next } = await run(ctx('https://beezyhoney.in/%61dmin/', { routePattern: '/admin' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });

  it('passes error pages through on known hosts only', async () => {
    expect((await run(ctx('https://beezyhoney.in/nope/', { routePattern: '/404' }))).next).toHaveBeenCalledOnce();
    expect((await run(ctx('https://evil.example/nope/', { routePattern: '/404' }))).next).not.toHaveBeenCalled();
  });

  it('sends a signed-out admin request on the admin host to the login page, with admin headers', async () => {
    vi.stubEnv('DEV', false);
    const { res, next } = await run(ctx('https://admin.beezyhoney.in/admin/', { routePattern: '/admin' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/admin\/login\//);
    for (const [name, value] of Object.entries(ADMIN_HEADERS)) expect(res.headers.get(name)).toBe(value);
  });

  it('never applies the dev bypass outside import.meta.env.DEV, even on localhost', async () => {
    vi.stubEnv('DEV', false);
    const { res } = await run(ctx('http://localhost:4321/admin/', { routePattern: '/admin' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/admin\/login\//);
  });

  it('signs in as the dev admin on localhost in dev, sets locals.admin and admin headers', async () => {
    vi.stubEnv('DEV', true);
    const waitUntil = vi.fn();
    const c = ctx('http://127.0.0.1:4321/admin/', { routePattern: '/admin', waitUntil });
    const { res, next } = await run(c);
    expect(next).toHaveBeenCalledOnce();
    expect(c.locals.admin).toEqual({ email: 'dev@example.test', role: 'owner' });
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(ADMIN_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(waitUntil).toHaveBeenCalledOnce(); // lazy job trigger on a signed-in GET
  });

  it('does not apply the dev bypass on the admin host in dev', async () => {
    vi.stubEnv('DEV', true);
    const { res } = await run(ctx('https://admin.beezyhoney.in/admin/', { routePattern: '/admin' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/admin\/login\//);
  });

  it('lets the login and logout pages through without a session', async () => {
    vi.stubEnv('DEV', false);
    for (const path of ['/admin/login/', '/admin/logout/']) {
      const c = ctx(`https://admin.beezyhoney.in${path}`, { routePattern: path.replace(/\/$/, '') });
      const { res, next } = await run(c);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).toBe(200);
      expect(c.locals.admin).toBeUndefined();
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('refuses unsafe admin requests without same-origin proof (403), also on open paths', async () => {
    vi.stubEnv('DEV', true);
    const cases: Record<string, string>[] = [{}, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example' }];
    for (const headers of cases) {
      for (const [url, pattern] of [['http://localhost/admin/', '/admin'], ['https://admin.beezyhoney.in/admin/login/', '/admin/login']]) {
        const { res, next } = await run(ctx(url, { method: 'POST', headers, routePattern: pattern }));
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toBe(403);
        expect(res.headers.get('x-frame-options')).toBe('DENY');
      }
    }
  });

  it('accepts unsafe admin requests with Sec-Fetch-Site same-origin or a matching Origin', async () => {
    vi.stubEnv('DEV', true);
    for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { origin: 'http://localhost' }]) {
      const c = ctx('http://localhost/admin/', { method: 'POST', headers, routePattern: '/admin' });
      const { res, next } = await run(c);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).toBe(200);
      expect(c.locals.admin).toEqual({ email: 'dev@example.test', role: 'owner' });
    }
  });

  it('leaves the public order intake to its own checks (no middleware 403 on /api POST)', async () => {
    const { res, next } = await run(ctx('https://beezyhoney.in/api/orders.json', { method: 'POST', routePattern: '/api/orders.json' }));
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('copies immutable responses before adding headers', async () => {
    vi.stubEnv('DEV', true);
    const frozen = Response.redirect('http://localhost/admin/', 303); // headers of Response.redirect are immutable
    const next = vi.fn(async () => frozen);
    const res = (await onRequest(ctx('http://localhost/admin/', { routePattern: '/admin' }) as never, next as never)) as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/admin/');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('notFoundPage', () => {
  it('uses the prerendered 404 page from the assets with status 404', async () => {
    const assets = { fetch: vi.fn(async () => new Response('<h1>404 page</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } })) };
    const res = await notFoundPage(new URL('https://beezyhoney.in/admin/'), assets as unknown as Fetcher);
    expect(assets.fetch).toHaveBeenCalledWith(new URL('https://beezyhoney.in/404/'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('<h1>404 page</h1>');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('falls back to a plain 404 when the page is missing or the binding fails', async () => {
    const missing = { fetch: async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }) };
    const broken = { fetch: async () => { throw new Error('boom'); } };
    for (const a of [missing, broken, undefined]) {
      const res = await notFoundPage(new URL('https://beezyhoney.in/admin/'), a as unknown as Fetcher);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Not found\n');
    }
  });
});
