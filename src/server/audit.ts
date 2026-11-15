// The activity log (audit_log): every admin write adds one row in the same batch as the change (see auditInsert
// in db.ts). This module reads it for the Activity screen and the order / product timelines.
import { type D1, all } from './db';

export { auditInsert, type AuditEntry } from './db';

export interface AuditRow {
  id: number;
  at: string;
  /** admin email, 'public', 'system' or 'seed' */
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  before: unknown;
  after: unknown;
}

type Raw = { id: number; at: string; actor: string; action: string; entity: string; entity_id: string; summary: string; before_json: string | null; after_json: string | null };
const parse = (s: string | null) => { if (s === null) return null; try { return JSON.parse(s); } catch { return null; } };
const toRow = (r: Raw): AuditRow => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, entity: r.entity, entityId: r.entity_id, summary: r.summary, before: parse(r.before_json), after: parse(r.after_json) });

/** Newest first, keyset paging with `beforeId`; optional filters by entity type, action prefix ('order.') or actor */
export async function listActivity(db: D1, opts: { limit?: number; beforeId?: number; entity?: string; actionPrefix?: string; actor?: string } = {}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await all<Raw>(db, `SELECT id, at, actor, action, entity, entity_id, summary, before_json, after_json FROM audit_log
    WHERE id < ?1 AND (?2 IS NULL OR entity = ?2) AND (?3 IS NULL OR substr(action, 1, length(?3)) = ?3) AND (?4 IS NULL OR actor = ?4)
    ORDER BY id DESC LIMIT ?5`, opts.beforeId ?? Number.MAX_SAFE_INTEGER, opts.entity ?? null, opts.actionPrefix ?? null, opts.actor ?? null, limit);
  return rows.map(toRow);
}

/** History of one thing, oldest first (e.g. timeline('order', 42)) */
export async function timeline(db: D1, entity: string, entityId: string | number, limit = 200): Promise<AuditRow[]> {
  const rows = await all<Raw>(db, `SELECT id, at, actor, action, entity, entity_id, summary, before_json, after_json FROM audit_log
    WHERE entity = ? AND entity_id = ? ORDER BY id LIMIT ?`, entity, String(entityId), limit);
  return rows.map(toRow);
}
