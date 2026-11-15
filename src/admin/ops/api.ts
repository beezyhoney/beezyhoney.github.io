// Small helpers for the admin JSON and file endpoints under /admin/api/ (owned by the ops screens).
// The middleware has already checked the host, the login and unsafe-method origins and adds the admin headers;
// these only shape the answers. Every answer is no-store: admin data never sits in a cache.
import type { AdminUser } from '../nav';

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, { status, headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...headers } });
}

/** 401 when nobody is signed in (the session chip treats 401/403 as "login expired"), 403 for a helper on an owner endpoint */
export function denied(admin: AdminUser | undefined, need: 'any' | 'owner' = 'any'): Response | null {
  if (!admin) return json({ error: 'not_signed_in' }, 401);
  if (need === 'owner' && admin.role !== 'owner') return json({ error: 'forbidden', message: 'Only the owner can do this.' }, 403);
  return null;
}

/** A file download (CSV, JSON backup) with a safe file name */
export function attachment(body: string, filename: string, type: string): Response {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'download';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': type, 'content-disposition': `attachment; filename="${safe}"`, ...NO_STORE },
  });
}
