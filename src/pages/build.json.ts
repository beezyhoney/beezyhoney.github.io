// /build.json — prerendered at build time (a static asset; public/_headers gives it Cache-Control: no-store).
// The admin's website-status chip polls it to see which site_version is live (design §2.5).
import type { APIRoute } from 'astro';
import { LIVE_VERSION, SITE_VERSION } from '../data/catalog';

export const prerender = true;

export interface BuildInfo {
  siteVersion: number;
  liveVersion: number;
  builtAt: string;
  commit: string | null;
  source: 'snapshot' | 'file' | 'remote';
}

export const GET: APIRoute = () => {
  const info: BuildInfo = {
    siteVersion: SITE_VERSION,
    liveVersion: LIVE_VERSION,
    builtAt: __BEEZY_BUILD_INFO__.builtAt,
    commit: __BEEZY_BUILD_INFO__.commit,
    source: __BEEZY_BUILD_INFO__.source,
  };
  return new Response(JSON.stringify(info) + '\n', {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
