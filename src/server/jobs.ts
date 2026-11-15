/**
 * Scheduled work: the entry points for publish-if-due (design §2.5), the chunked daily backup into KV (A2), the
 * daily clean-up (IP hashes after 30 days, personal data, old login codes and sessions) and the weekly reconcile.
 * The jobs themselves live in ./jobs-impl.ts. src/worker.ts (cron) and src/middleware.ts (lazy trigger) call these.
 *
 * Two ways in:
 *  - cron: wrangler.jsonc `triggers.crons` (every 15 minutes) → src/worker.ts scheduled() → runDueJobs(..., { trigger: 'cron' }).
 *  - lazy: an admin page load (GET, signed in) → maybeRunJobsLazily() → runDueJobs(..., { trigger: 'lazy' }) inside
 *    waitUntil, at most once per LAZY_MIN_INTERVAL_MS per isolate. This is the design's fallback for "the cron did not
 *    fire" and also makes a due publish happen sooner after the owner opens the admin.
 * Every job is idempotent and decides from D1 state (job_runs, settings.publish_due_at) whether it is due.
 */
import { runDueJobsImpl } from './jobs-impl';

export type JobTrigger = 'cron' | 'lazy' | 'manual';

export interface JobRunInfo {
  trigger: JobTrigger;
  /** The cron expression that fired (cron trigger only). */
  cron?: string;
  /** When the run was scheduled, ms since epoch (cron) or Date.now() (lazy/manual). */
  scheduledTime: number;
}

export interface JobRunResult {
  trigger: JobTrigger;
  /** Names of the jobs that did work in this run. */
  ran: string[];
}

/** Run every job that is due. Never throws: a failing job is recorded in job_runs by jobs-impl. */
export async function runDueJobs(env: Env, ctx: ExecutionContext, info: JobRunInfo): Promise<JobRunResult> {
  try {
    const r = await runDueJobsImpl(
      { DB: env.DB as never, BACKUPS: env.BACKUPS as never, DEPLOY_HOOK_URL: (env as { DEPLOY_HOOK_URL?: string }).DEPLOY_HOOK_URL },
      ctx,
      { at: new Date(info.scheduledTime || Date.now()).toISOString().slice(0, 19) + 'Z' },
    );
    console.log(`[jobs] runDueJobs trigger=${info.trigger}${info.cron ? ` cron=${info.cron}` : ''} ran=${r.ran.join(',') || 'nothing'}`);
    return { trigger: info.trigger, ran: r.ran };
  } catch (err) {
    console.error('[jobs] runDueJobs failed', err);
    return { trigger: info.trigger, ran: [] };
  }
}

/** Lazy trigger throttle: at most one lazy run per isolate in this window. */
export const LAZY_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastLazyRun = 0;

/**
 * Called by the middleware on signed-in admin page loads. Schedules runDueJobs() in waitUntil (never delays the page)
 * unless a lazy run already started in this isolate within LAZY_MIN_INTERVAL_MS. Returns true when a run was scheduled.
 */
export function maybeRunJobsLazily(env: Env, ctx: ExecutionContext, now = Date.now()): boolean {
  if (now - lastLazyRun < LAZY_MIN_INTERVAL_MS) return false;
  lastLazyRun = now;
  ctx.waitUntil(
    runDueJobs(env, ctx, { trigger: 'lazy', scheduledTime: now }).catch((err) => {
      console.error('[jobs] lazy run failed', err);
    }),
  );
  return true;
}

/** Test helper: forget the lazy-run throttle. */
export function resetLazyJobsThrottle(): void {
  lastLazyRun = 0;
}
