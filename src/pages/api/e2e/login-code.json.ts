// GET /api/e2e/login-code.json?email= — ONLY in e2e builds (`astro build --mode e2e`) and only on localhost /
// 127.0.0.1 when the Worker's own PUBLIC_HOSTS lists them as local hosts (.dev.vars of the e2e copy; the deployed
// config never does, see predeploy-check): the last admin login code sent, so the browser tests can log in through
// the send_email simulation. The request's host name alone is never trusted.
// In every other build this route answers 404 and the code behind it is compiled out (src/server/auth.ts e2eLastCode;
// scripts/check-dist.mjs and scripts/predeploy-check.mjs check dist/server).
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hostConfigFrom, hostKind } from '../../../middleware';
import { e2eLastCode } from '../../../server/auth';

export const prerender = false;

const notFound = () => new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export const GET: APIRoute = ({ url }) => {
  if (import.meta.env.MODE !== 'e2e' || hostKind(url.hostname, hostConfigFrom(env as { PUBLIC_HOSTS?: string; ADMIN_HOST?: string })) !== 'local') return notFound();
  const last = e2eLastCode(url.searchParams.get('email'));
  return new Response(`${JSON.stringify(last)}\n`, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};
