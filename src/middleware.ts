/**
 * Middleware for on-demand routes (design §4, amendment A1). Prerendered pages skip it entirely (they are static
 * assets in production and never reach the Worker).
 *
 * 1. Host routing by the matched route (context.routePattern, never the raw path, so /%61dmin/ cannot slip through):
 *      public host (PUBLIC_HOSTS)      → /api/* and /media/* only
 *      admin host (ADMIN_HOST)         → /admin* only
 *      localhost / 127.0.0.1           → both (local development and tests), when listed in PUBLIC_HOSTS
 *      anything else                   → 404
 *    Astro's own image endpoint (/_image, used by astro dev and by on-demand admin pages) is allowed on the admin and
 *    local hosts only; public pages are prerendered with build-time images (check-dist fails on any /_image URL).
 * 2. Admin routes: requireAdmin() from src/server/auth.ts (stub today), except the open paths (login, logout).
 *    The result is put on Astro.locals.admin = { email, role }.
 * 3. Unsafe methods on admin routes need Sec-Fetch-Site: same-origin, or (when that header is absent) an Origin equal
 *    to the request's own origin. Astro's security.checkOrigin also covers form posts on every on-demand route.
 *    The public order intake (/api/orders.json) does its own Origin / Sec-Fetch-Site checks and always answers 204.
 * 4. Admin responses get no-store, noindex, DENY framing, same-origin referrer and a CSP without script-src (so Astro's
 *    inline scripts keep working). Every on-demand response gets X-Content-Type-Options: nosniff.
 * 5. Signed-in admin page loads (GET) also trigger due jobs lazily (src/server/jobs.ts), the fallback for the cron.
 */
import type { APIContext, MiddlewareHandler } from 'astro';
import { env } from 'cloudflare:workers';
import { isOpenAdminPath, requireAdmin } from './server/auth';
import { maybeRunJobsLazily } from './server/jobs';

export type HostKind = 'public' | 'admin' | 'local' | 'unknown';
export type Area = 'api' | 'media' | 'admin' | 'image' | 'error' | 'other';

export interface HostConfig {
  publicHosts: string[];
  adminHost: string;
}

export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

export const ADMIN_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'; connect-src 'self'; img-src 'self' blob: data:",
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function splitList(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => normaliseHost(s))
    .filter(Boolean);
}

export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

export function hostConfigFrom(vars: { PUBLIC_HOSTS?: unknown; ADMIN_HOST?: unknown }): HostConfig {
  return { publicHosts: splitList(vars.PUBLIC_HOSTS), adminHost: normaliseHost(String(vars.ADMIN_HOST ?? '')) };
}

/** Which kind of host a request came in on. localhost/127.0.0.1 count as 'local' only when listed in PUBLIC_HOSTS. */
export function hostKind(hostname: string, cfg: HostConfig): HostKind {
  const host = normaliseHost(hostname);
  if (!host) return 'unknown';
  if (LOCAL_HOSTS.includes(host)) return cfg.publicHosts.includes(host) ? 'local' : 'unknown';
  if (cfg.adminHost && host === cfg.adminHost) return 'admin';
  if (cfg.publicHosts.includes(host)) return 'public';
  return 'unknown';
}

/** Area of a route pattern ('/api/live.json', '/admin/orders/[id]', '/404', ...). */
export function areaOf(routePattern: string): Area {
  const p = (routePattern || '/').toLowerCase();
  if (p === '/404' || p === '/500') return 'error';
  if (p === '/admin' || p.startsWith('/admin/')) return 'admin';
  if (p === '/_image' || p.startsWith('/_image/')) return 'image';
  if (p.startsWith('/api/')) return 'api';
  if (p.startsWith('/media/')) return 'media';
  return 'other';
}

/** May this area be served on this kind of host? */
export function isAllowed(kind: HostKind, area: Area): boolean {
  if (area === 'error') return kind !== 'unknown';
  if (kind === 'local') return area === 'api' || area === 'media' || area === 'admin' || area === 'image';
  if (kind === 'public') return area === 'api' || area === 'media';
  if (kind === 'admin') return area === 'admin' || area === 'image';
  return false;
}

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Same-origin proof for an unsafe request: Sec-Fetch-Site must be 'same-origin' when present; browsers that do not
 * send it must send an Origin equal to the request origin. A request with neither header is refused.
 */
export function isSameOriginRequest(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site.toLowerCase() === 'same-origin';
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  return origin.toLowerCase() === url.origin.toLowerCase();
}

/** Returns a response whose headers can be changed (Astro and fetch responses may have immutable headers). */
function mutable(response: Response): Response {
  try {
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  } catch {
    return new Response(response.body, response);
  }
}

export function withAdminHeaders(response: Response): Response {
  const res = mutable(response);
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) res.headers.set(name, value);
  return res;
}

export function withBaseHeaders(response: Response): Response {
  const res = mutable(response);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  return res;
}

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

/** Plain 404 for a route that does not exist on this host. */
export function notFound(): Response {
  return plain(404, 'Not found', { 'x-robots-tag': 'noindex' });
}

/**
 * 404 that looks exactly like any other unknown URL on the site: the prerendered 404 page from the static assets
 * (served at /404/ because of html_handling force-trailing-slash), with status 404. Falls back to the plain 404
 * (e.g. in astro dev, where the page is not built).
 */
export async function notFoundPage(url: URL, assets: Fetcher | undefined): Promise<Response> {
  if (assets) {
    try {
      const page = await assets.fetch(new URL('/404/', url.origin));
      if (page.ok && (page.headers.get('content-type') ?? '').includes('text/html')) {
        return new Response(page.body, {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' },
        });
      }
    } catch {
      // fall through to the plain 404
    }
  }
  return notFound();
}

type Ctx = Pick<APIContext, 'isPrerendered' | 'routePattern' | 'url' | 'request' | 'locals'>;

export const onRequest: MiddlewareHandler = async (context, next) => {
  const ctx = context as unknown as Ctx;
  if (ctx.isPrerendered) return next();

  const cfg = hostConfigFrom(env as unknown as Record<string, unknown>);
  const kind = hostKind(ctx.url.hostname, cfg);
  const area = areaOf(ctx.routePattern);

  if (!isAllowed(kind, area)) return notFoundPage(ctx.url, (env as { ASSETS?: Fetcher }).ASSETS);
  if (area === 'error') return next();

  if (area !== 'admin') return withBaseHeaders(await next());

  // Admin routes from here on.
  if (isUnsafeMethod(ctx.request.method) && !isSameOriginRequest(ctx.request, ctx.url)) {
    return withAdminHeaders(plain(403, 'Forbidden: cross-site request'));
  }

  if (!isOpenAdminPath(ctx.url.pathname)) {
    const result = await requireAdmin(ctx);
    if (result instanceof Response) return withAdminHeaders(result);
    ctx.locals.admin = result;

    const cfContext = (ctx.locals as { cfContext?: ExecutionContext }).cfContext;
    if (ctx.request.method === 'GET' && cfContext) maybeRunJobsLazily(env, cfContext);
  }

  return withAdminHeaders(await next());
};
