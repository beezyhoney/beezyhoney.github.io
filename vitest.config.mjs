import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

// Two projects, both run by `npm test`:
//  - unit:   plain Node, test/unit/**  (`npm run test:unit`)
//  - worker: inside workerd via @cloudflare/vitest-plugin, test/worker/** (`npm run test:worker`), with the D1, KV and
//            send_email bindings from wrangler.jsonc (local Miniflare simulations; storage is isolated per test file).
//            db/migrations/*.sql (when the folder exists) are applied to env.DB by test/worker/setup.ts before each file.
const astroHandlerStub = fileURLToPath(new URL('./test/worker/stubs/astro-handler.ts', import.meta.url));
const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));

// Deterministic secrets for worker tests. They override anything in a local .dev.vars, so tests never see (or
// depend on) the real owner emails and CI without a .dev.vars behaves the same.
export const WORKER_TEST_VARS = {
  // local names as public + admin host, as in .dev.vars (wrangler.jsonc lists only the real hosts)
  PUBLIC_HOSTS: 'beezyhoney.in,next.beezyhoney.in,localhost,127.0.0.1',
  ADMIN_EMAILS: 'owner@example.test,second-owner@example.test',
  // empty: overrides the real aliases of a local .dev.vars (alias tests pass their own ADMIN_ALIASES)
  ADMIN_ALIASES: '',
  LOGIN_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  IP_HASH_KEY: 'test-ip-hash-key',
  DEV_ADMIN_EMAIL: 'dev@example.test',
  DEPLOY_HOOK_URL: '',
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.{ts,mjs}'],
          environment: 'node',
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: {
                ...WORKER_TEST_VARS,
                TEST_MIGRATIONS: existsSync(migrationsDir) ? await readD1Migrations(migrationsDir) : [],
              },
            },
          })),
        ],
        resolve: {
          // The Worker entry is src/worker.ts (wrangler.jsonc main). Astro's request handler needs Astro's build-time
          // virtual modules, which do not exist here, so worker tests get a stand-in for it. scheduled() is real.
          alias: { '@astrojs/cloudflare/handler': astroHandlerStub },
        },
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
          setupFiles: ['./test/worker/setup.ts'],
        },
      },
    ],
  },
});
