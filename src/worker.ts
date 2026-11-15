/**
 * Worker entry (wrangler.jsonc `main`). Static pages never reach this file: Cloudflare serves them from the assets
 * (dist/client) before the Worker runs. Only on-demand routes (/api/*, /media/*, /admin/*) and unknown paths arrive here.
 *
 * - fetch: Astro's handler (routing, middleware in src/middleware.ts, pages and endpoints).
 * - scheduled: the 15-minute cron (wrangler.jsonc triggers.crons) runs the due jobs (src/server/jobs.ts).
 *   Locally: `astro dev` / `astro preview` expose /cdn-cgi/handler/scheduled?cron=... to fire it by hand.
 */
import { handle } from '@astrojs/cloudflare/handler';
import { runDueJobs } from './server/jobs';

export default {
  fetch: handle,

  async scheduled(controller, env, ctx) {
    await runDueJobs(env, ctx, {
      trigger: 'cron',
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
  },
} satisfies ExportedHandler<Env>;
