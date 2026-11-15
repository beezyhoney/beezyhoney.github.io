// The bindings declared in wrangler.jsonc exist in the worker test project (local Miniflare simulations).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('bindings from wrangler.jsonc', () => {
  it('D1 (DB) answers queries and has the migrations applied by test/worker/setup.ts', async () => {
    const row = await env.DB.prepare('SELECT 1 AS one').first<{ one: number }>();
    expect(row?.one).toBe(1);
    if (env.TEST_MIGRATIONS.length) {
      const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
      expect(results.map((r) => r.name)).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
    }
  });

  it('KV MEDIA and BACKUPS are separate namespaces', async () => {
    await env.MEDIA.put('uploads/x.jpg', 'media');
    await env.BACKUPS.put('daily/x.json', 'backup');
    expect(await env.MEDIA.get('uploads/x.jpg')).toBe('media');
    expect(await env.MEDIA.get('daily/x.json')).toBeNull();
    expect(await env.BACKUPS.get('daily/x.json')).toBe('backup');
  });

  it('send_email LOGIN_MAIL is bound', () => {
    expect(typeof env.LOGIN_MAIL.send).toBe('function');
  });

  it('vars come from wrangler.jsonc (PUBLIC_HOSTS with the local names from the worker-test vars, like .dev.vars)', () => {
    expect(env.PUBLIC_HOSTS).toBe('beezyhoney.in,next.beezyhoney.in,localhost,127.0.0.1');
    expect(env.ADMIN_HOST).toBe('admin.beezyhoney.in');
    expect(env.PUBLIC_ORIGIN).toBe('https://beezyhoney.in');
  });
});
