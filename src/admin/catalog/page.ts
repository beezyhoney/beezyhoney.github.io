// Small helpers the catalog pages share (server side, workerd only: they read the Worker's bindings).
import { env } from 'cloudflare:workers';
import type { AdminUser } from '../nav';
import type { Effects } from '../../server/db';
import { handleEffects, type PublishRequest } from '../../server/publish';
import { loadPhotoLibrary, type LibraryPhoto } from './library';

interface AstroLike {
  locals: unknown;
  url: URL;
}

/** The signed-in admin (set by the middleware on every admin route) */
export function adminOf(astro: AstroLike): AdminUser {
  const admin = (astro.locals as { admin?: AdminUser }).admin;
  if (!admin) throw new Error('admin page rendered without a signed-in admin');
  return admin;
}

/** The Worker's bindings */
export const bindings = env as unknown as Env;

/**
 * After a successful write: asks for a website rebuild when the write needs one (effects.publish === 'now').
 * Never waits for the build. Returns what publishing did (null when nothing was needed).
 */
export async function publishAfter(astro: AstroLike, effects: Effects | undefined, reason: string): Promise<PublishRequest | null> {
  const ctx = (astro.locals as { cfContext?: ExecutionContext }).cfContext;
  if (!ctx || effects?.publish !== 'now') return null;
  try {
    return await handleEffects(bindings, ctx, adminOf(astro), effects, reason);
  } catch (e) {
    console.error('[publish] request failed', e);
    return null;
  }
}

/** The website's photo library (/photo-library.json), [] when it cannot be read */
export function photoLibrary(astro: AstroLike): Promise<LibraryPhoto[]> {
  const assets = (env as unknown as { ASSETS?: { fetch(input: Request | string | URL): Promise<Response> } }).ASSETS ?? null;
  return loadPhotoLibrary(astro.url.origin, { assets, dev: import.meta.env.DEV });
}
