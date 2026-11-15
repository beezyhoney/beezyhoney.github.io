// Runs before every worker test file (storage is isolated per file, so each file starts from an empty, migrated D1).
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
