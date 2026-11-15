// Category texts and photos (Website screen, design §5 screen 10). The four shop sections are baked into the
// website, so a change bumps site_version in the same batch and asks for a rebuild (effects.publish = 'now').
// A chosen uploaded photo becomes public in the same batch (only public uploads are served at /media/…).
// Follows the src/server conventions: (db, actor, input, at?) → Result, one guarded batch with its audit row.
import {
  type Actor, type D1, type Effects, type Result, auditInsert, fail, first, ok, ownerOnly, stmt, tryBatch, versionedUpdate,
} from '../../server/db';
import { bumpVersionStmt } from '../../server/settings';
import { nowIso } from '../../server/time';

export interface CategoryInput {
  id: string;
  version: number;
  name: string;
  title: string;
  intro: string;
  image: string;
}

/** Saves one category. Errors: forbidden, invalid (field name / title / intro / image), not_found, conflict (version). */
export async function updateCategory(db: D1, actor: Actor, input: CategoryInput, at: string = nowIso()): Promise<Result<{ version: number; effects: Effects }>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  if (!input || typeof input.id !== 'string' || !Number.isSafeInteger(input.version) || input.version < 1) return fail('invalid', 'Reload the page and try again.');
  const name = String(input.name ?? '').trim();
  const title = String(input.title ?? '').trim();
  const intro = String(input.intro ?? '').trim();
  const image = String(input.image ?? '').trim();
  if (name.length < 2 || name.length > 60) return fail('invalid', 'The name must be 2–60 characters.', { field: 'name' });
  if (title.length < 2 || title.length > 80) return fail('invalid', 'The heading must be 2–80 characters.', { field: 'title' });
  if (intro.length < 1 || [...intro].length > 600) return fail('invalid', 'The text must be 1–600 characters.', { field: 'intro' });
  const cur = await first<{ name: string; title: string; intro: string; image: string; version: number }>(db,
    'SELECT name, title, intro, image, version FROM categories WHERE id = ?', input.id);
  if (!cur) return fail('not_found', 'This shop section does not exist.');
  if (!(await first(db, 'SELECT 1 AS x FROM images WHERE path = ?', image))) return fail('invalid', 'Choose one of the photos.', { field: 'image' });
  if (cur.name === name && cur.title === title && cur.intro === intro && cur.image === image) {
    return ok({ version: cur.version, effects: { publish: null, live: false } });
  }
  const by = actor.email;
  const guard = { sql: 'EXISTS (SELECT 1 FROM categories WHERE id = ? AND version = ? AND updated_at = ? AND updated_by = ?)', params: [input.id, input.version + 1, at, by] };
  const changed = [cur.name !== name && 'name', cur.title !== title && 'heading', cur.intro !== intro && 'text', cur.image !== image && 'photo'].filter(Boolean).join(', ');
  const res = await tryBatch(db, [
    versionedUpdate(db, { table: 'categories', key: ['id', input.id], version: input.version, set: { name, title, intro, image }, actor, at }),
    stmt(db, `UPDATE images SET public = 1 WHERE public = 0 AND path = ? AND ${guard.sql}`, image, ...guard.params),
    bumpVersionStmt(db, 'site_version', at, by, guard),
    auditInsert(db, {
      at, actor, action: 'category.update', entity: 'category', entityId: input.id, summary: `Shop section "${name}": ${changed} changed`,
      before: { name: cur.name, title: cur.title, intro: cur.intro, image: cur.image }, after: { name, title, intro, image },
    }, guard),
  ]);
  if (!res.ok) return res;
  if (res.value[0].meta.changes !== 1) return fail('conflict', 'Someone else changed this section just now. Reload the page.');
  return ok({ version: input.version + 1, effects: { publish: 'now', live: false } });
}
