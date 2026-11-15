// Stand-in for '@astrojs/cloudflare/handler' in worker tests (vitest.config.mjs alias). The real handler needs
// Astro's build-time virtual modules. Tests that need a route call its module (GET/POST) or middleware directly.
export async function handle(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
  return new Response('Astro handler is not loaded in worker tests\n', { status: 404 });
}
