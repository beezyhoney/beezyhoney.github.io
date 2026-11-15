// People screen writes (design §5 screen 11, amendment A1): helpers in `admin_users`. Owners are NOT rows: they come
// from the ADMIN_EMAILS Worker secret and can only be changed there. Nothing is deleted: a helper is switched off,
// which also ends their sessions at once (the login re-checks admin_users on every request as well).
// Follows the src/server conventions: (db, actor, input, at?) → Result, one batch with its audit row.
import {
  type Actor, type D1, type Result, auditInsert, fail, first, ok, ownerOnly, stmt, tryBatch, versionedUpdate,
} from '../../server/db';
import { nowIso } from '../../server/time';

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lower-cased, trimmed email, or null when it does not look like one */
export function cleanEmail(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  return s.length <= 254 && EMAIL.test(s) ? s : null;
}

/** Adds a helper (role helper, active). Errors: forbidden, invalid (field email / name), conflict (already listed). */
export async function addHelper(db: D1, actor: Actor, input: { email: string; name?: string | null; owners?: string[] }, at: string = nowIso()): Promise<Result<{ email: string }>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const email = cleanEmail(input?.email);
  if (!email) return fail('invalid', 'Please type a full email address, like name@example.com.', { field: 'email' });
  if ((input.owners ?? []).includes(email)) return fail('invalid', 'This email is an owner already. Owners do not need a helper row.', { field: 'email' });
  const name = (input.name ?? '').trim().replace(/\s+/g, ' ') || null;
  if (name && name.length > 60) return fail('invalid', 'Please keep the name to 60 characters or fewer.', { field: 'name' });
  const exists = await first(db, 'SELECT 1 AS x FROM admin_users WHERE email = ?', email);
  if (exists) return fail('conflict', 'This helper is already on the list. Switch them on below instead.', { field: 'email' });
  const res = await tryBatch(db, [
    stmt(db, `INSERT INTO admin_users (email, name, role, active, added_at, added_by, version, updated_at, updated_by)
      VALUES (?, ?, 'helper', 1, ?, ?, 1, ?, ?) ON CONFLICT(email) DO NOTHING`, email, name, at, actor.email, at, actor.email),
    auditInsert(db, { at, actor, action: 'people.add', entity: 'admin_user', entityId: email, summary: `Helper added: ${email}` },
      { sql: 'EXISTS (SELECT 1 FROM admin_users WHERE email = ? AND added_at = ? AND added_by = ?)', params: [email, at, actor.email] }),
  ], { unique: 'This helper is already on the list.' });
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return fail('conflict', 'This helper is already on the list.', { field: 'email' });
  return ok({ email });
}

/**
 * Switches a helper on or off (and can change the name). Switching off ends their open sessions in the same batch.
 * Errors: forbidden, invalid, not_found, conflict (someone else changed the row).
 */
export async function updateHelper(db: D1, actor: Actor, input: { email: string; version: number; active: boolean; name?: string | null }, at: string = nowIso()): Promise<Result<{ version: number }>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const email = cleanEmail(input?.email);
  if (!email || !Number.isSafeInteger(input.version) || input.version < 1 || typeof input.active !== 'boolean') return fail('invalid', 'Reload the page and try again.');
  const name = input.name === undefined ? undefined : ((input.name ?? '').trim().replace(/\s+/g, ' ') || null);
  if (name && name.length > 60) return fail('invalid', 'Please keep the name to 60 characters or fewer.', { field: 'name' });
  const cur = await first<{ active: number; name: string | null }>(db, 'SELECT active, name FROM admin_users WHERE email = ?', email);
  if (!cur) return fail('not_found', 'This helper is not on the list.');
  const set: Record<string, unknown> = { active: input.active ? 1 : 0 };
  if (name !== undefined) set.name = name;
  const guard = { sql: 'EXISTS (SELECT 1 FROM admin_users WHERE email = ? AND version = ? AND updated_at = ?)', params: [email, input.version + 1, at] };
  const words = input.active === (cur.active === 1) ? `Helper details changed: ${email}` : input.active ? `Helper switched on: ${email}` : `Helper switched off: ${email}`;
  const statements = [
    versionedUpdate(db, { table: 'admin_users', key: ['email', email], version: input.version, set, actor, at }),
    auditInsert(db, { at, actor, action: 'people.update', entity: 'admin_user', entityId: email, summary: words, before: { active: cur.active === 1 }, after: { active: input.active } }, guard),
  ];
  if (!input.active) statements.push(stmt(db, `DELETE FROM admin_sessions WHERE email = ? AND ${guard.sql}`, email, ...guard.params));
  const res = await tryBatch(db, statements);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return fail('conflict', 'Someone else changed this helper just now. Reload the page.');
  return ok({ version: input.version + 1 });
}
