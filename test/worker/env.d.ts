// Extra bindings that exist only in the worker test project (vitest.config.mjs).
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
