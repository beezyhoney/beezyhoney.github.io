// GET /api/health.json — on-demand liveness check for the Worker and its bindings. Public, never cached, and it
// reveals nothing private: only whether each binding is present and whether D1 answers a trivial query.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

type Check = 'ok' | 'missing' | 'error';

export interface Health {
  ok: boolean;
  service: 'beezyhoney';
  time: string;
  checks: { db: Check; media: Check; backups: Check; mail: Check };
}

async function checkDb(db: D1Database | undefined): Promise<Check> {
  if (!db) return 'missing';
  try {
    const row = await db.prepare('SELECT 1 AS one').first<{ one: number }>();
    return row?.one === 1 ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

const present = (binding: unknown): Check => (binding ? 'ok' : 'missing');

export async function health(bindings: Partial<Env>, now = new Date()): Promise<Health> {
  const checks = {
    db: await checkDb(bindings.DB),
    media: present(bindings.MEDIA),
    backups: present(bindings.BACKUPS),
    mail: present(bindings.LOGIN_MAIL),
  };
  return {
    ok: Object.values(checks).every((c) => c === 'ok'),
    service: 'beezyhoney',
    time: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    checks,
  };
}

export const GET: APIRoute = async () => {
  const body = await health(env);
  return new Response(JSON.stringify(body) + '\n', {
    status: body.ok ? 200 : 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};
