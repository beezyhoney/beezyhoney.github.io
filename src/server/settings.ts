// Website and business settings (D1 `settings`, one JSON value per key).
// Defaults and key groups live in settings.defaults.mjs (shared with scripts/make-seed.mjs).
import type { CatalogOffer, StockDisplay } from '../data/catalog.types';
import {
  type Actor, type D1, type D1Statement, type Effects, type Guard, type Result,
  all, auditInsert, fail, ok, ownerOnly, stmt, tryBatch,
} from './db';
import { nowIso, isDate, isIso } from './time';
import { SETTINGS_DEFAULTS, LIVE_KEYS, SITE_KEYS, EDITABLE_KEYS } from './settings.defaults.mjs';

export { SETTINGS_DEFAULTS, LIVE_KEYS, SITE_KEYS, EDITABLE_KEYS };

export interface GiftSettings {
  /** packing fee per box in paise (0 = none) */
  feePaise: number;
  /** gift box extra name → variant code it is priced as, or null for "price on WhatsApp" */
  extras: Record<string, string | null>;
  /** from this many boxes the estimate says "Bulk price confirmed on WhatsApp" (and the request is bulk) */
  bulkFrom: number;
}
export interface OrderIntakeSettings {
  /** false = "Pause order recording": the site still opens WhatsApp, nothing is stored */
  enabled: boolean;
  /** orders per IP hash per hour before they are stored as spam */
  perIpHour: number;
  /** orders per IST day before nothing more is stored (and an "unusual traffic" alert shows) */
  perDay: number;
}
export interface AlertSettings {
  newWaitingHours: number;
  unansweredDays: number;
  backupStaleDays: number;
  bestBeforeWarnDays: number;
  /** low-stock level given to new pools, per unit */
  lowDefault: { g: number; piece: number };
}
export interface BusinessSettings {
  name: string;
  packerAddress: string | null;
  customerCare: string | null;
  fssai: string | null;
  gstin: string | null;
}
export interface PrivacySettings { clearCustomerAfterMonths: number }

/** Every settings key and its value type */
export interface SettingsValues {
  show_prices: boolean;
  stock_display: StockDisplay;
  delivery_note: string;
  offer: CatalogOffer | null;
  gift: GiftSettings;
  order_intake: OrderIntakeSettings;
  alerts: AlertSettings;
  business: BusinessSettings;
  privacy: PrivacySettings;
  /** UTC time of the cutover; null before go-live */
  go_live_at: string | null;
  site_version: number;
  live_version: number;
  published_version: number;
  /** UTC time an automatic publish is due, or null */
  publish_due_at: string | null;
}
export type SettingKey = keyof SettingsValues;
export type EditableKey = Exclude<SettingKey, 'site_version' | 'live_version' | 'published_version' | 'publish_due_at'>;

export interface SettingsSnapshot {
  values: SettingsValues;
  /** row version per key (1 for a key that has no row yet) */
  versions: Record<SettingKey, number>;
}

const clone = <T>(v: T): T => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

/** All settings with their versions; missing keys get their default (version 1) */
export async function getSettings(db: D1): Promise<SettingsSnapshot> {
  const rows = await all<{ key: string; value: string; version: number }>(db, 'SELECT key, value, version FROM settings');
  return settingsFromRows(rows);
}

/** Builds a snapshot from `SELECT key, value, version FROM settings` rows (used when batching reads) */
export function settingsFromRows(rows: { key: string; value: string; version: number }[]): SettingsSnapshot {
  const values = clone(SETTINGS_DEFAULTS) as unknown as SettingsValues;
  const versions = Object.fromEntries(Object.keys(SETTINGS_DEFAULTS).map((k) => [k, 1])) as Record<SettingKey, number>;
  for (const r of rows) {
    if (!(r.key in SETTINGS_DEFAULTS)) continue;
    try {
      (values as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
      versions[r.key as SettingKey] = r.version;
    } catch { /* keep the default */ }
  }
  return { values, versions };
}

/** One setting's value (default when missing) */
export async function getSetting<K extends SettingKey>(db: D1, key: K): Promise<SettingsValues[K]> {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!r) return clone(SETTINGS_DEFAULTS[key]) as SettingsValues[K];
  return JSON.parse(r.value) as SettingsValues[K];
}

// ───────────────────────────── validation ─────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const textOrNull = (v: unknown, max: number) => v === null || isText(v, max);
const exactKeys = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o);

/**
 * Checks one editable value. Returns an error message, or null when it is fine.
 * `variantCodes` is needed for gift.extras (each extra maps to a pack code or null).
 */
export function validateSetting(key: string, v: unknown, ctx: { variantCodes?: Set<string> } = {}): string | null {
  switch (key) {
    case 'show_prices':
      return typeof v === 'boolean' ? null : 'Show prices must be on or off.';
    case 'stock_display':
      return v === 'sold_out' || v === 'low_and_sold_out' ? null : 'Choose how stock shows on the website.';
    case 'delivery_note':
      return isText(v, 200) ? null : 'The delivery note must be 1–200 characters.';
    case 'offer': {
      if (v === null) return null;
      if (!isObj(v) || !exactKeys(v, ['text', 'href', 'until'])) return 'The offer needs text, a link (or none) and an end date (or none).';
      if (!isText(v.text, 120)) return 'The offer text must be 1–120 characters.';
      if (v.href !== null && !(typeof v.href === 'string' && /^\/(?!\/)[^\s]*$/.test(v.href) && v.href.length <= 200)) return 'The offer link must be a page of this website, starting with /.';
      if (v.until !== null && !isDate(v.until)) return 'The offer end date must look like 2026-12-31.';
      return null;
    }
    case 'gift': {
      if (!isObj(v) || !exactKeys(v, ['feePaise', 'extras', 'bulkFrom'])) return 'Gift settings are incomplete.';
      if (!isInt(v.feePaise, 0, 10_000_000)) return 'The box fee must be a whole amount of ₹0 or more.';
      if (!isInt(v.bulkFrom, 1, 100_000)) return 'Bulk from must be a whole number of boxes, 1 or more.';
      if (!isObj(v.extras)) return 'Gift extras are missing.';
      for (const [name, code] of Object.entries(v.extras)) {
        if (!isText(name, 60)) return 'Each gift extra needs a name.';
        if (code !== null && (typeof code !== 'string' || (ctx.variantCodes && !ctx.variantCodes.has(code)))) return `"${name}" is mapped to an unknown pack.`;
      }
      return null;
    }
    case 'order_intake':
      if (!isObj(v) || !exactKeys(v, ['enabled', 'perIpHour', 'perDay'])) return 'Order recording settings are incomplete.';
      if (typeof v.enabled !== 'boolean') return 'Order recording must be on or off.';
      if (!isInt(v.perIpHour, 1, 10_000) || !isInt(v.perDay, 1, 100_000)) return 'Order limits must be whole numbers above 0.';
      return null;
    case 'alerts':
      if (!isObj(v) || !exactKeys(v, ['newWaitingHours', 'unansweredDays', 'backupStaleDays', 'bestBeforeWarnDays', 'lowDefault'])) return 'Alert settings are incomplete.';
      if (!isInt(v.newWaitingHours, 1, 24 * 30) || !isInt(v.unansweredDays, 1, 365) || !isInt(v.backupStaleDays, 1, 60) || !isInt(v.bestBeforeWarnDays, 0, 730)) return 'Alert limits must be whole numbers in range.';
      if (!isObj(v.lowDefault) || !exactKeys(v.lowDefault, ['g', 'piece']) || !isInt(v.lowDefault.g) || !isInt(v.lowDefault.piece)) return 'Default low-stock levels must be whole numbers.';
      return null;
    case 'business':
      if (!isObj(v) || !exactKeys(v, ['name', 'packerAddress', 'customerCare', 'fssai', 'gstin'])) return 'Business details are incomplete.';
      if (!isText(v.name, 100)) return 'The business name must be 1–100 characters.';
      if (!textOrNull(v.packerAddress, 300) || !textOrNull(v.customerCare, 100)) return 'Address and customer care must be text (or empty).';
      if (v.fssai !== null && !(typeof v.fssai === 'string' && /^\d{14}$/.test(v.fssai))) return 'The FSSAI number has 14 digits.';
      if (v.gstin !== null && !(typeof v.gstin === 'string' && /^[0-9A-Z]{15}$/.test(v.gstin))) return 'A GSTIN has 15 letters and digits.';
      return null;
    case 'privacy':
      if (!isObj(v) || !exactKeys(v, ['clearCustomerAfterMonths']) || !isInt(v.clearCustomerAfterMonths, 1, 120)) return 'Clear customer details after 1–120 months.';
      return null;
    case 'go_live_at':
      return v === null || isIso(v) ? null : 'The go-live time must be a UTC time like 2026-12-01T00:30:00Z.';
    default:
      return `"${key}" cannot be changed here.`;
  }
}

// ───────────────────────────── statements other modules add to their batches ─────────────────────────────

/** +1 on site_version or live_version (inside the caller's batch, optionally guarded) */
export function bumpVersionStmt(db: D1, key: 'site_version' | 'live_version', at: string, by: string, guard?: Guard): D1Statement {
  return stmt(db, `UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ?, updated_by = ?
    WHERE key = ?${guard ? ` AND ${guard.sql}` : ''}`, at, by, key, ...(guard?.params ?? []));
}

/** Sets publish_due_at to `dueAt` unless an earlier time is already set (debounced automatic publish) */
export function schedulePublishStmt(db: D1, dueAt: string, at: string, guard?: Guard): D1Statement {
  return stmt(db, `UPDATE settings SET value = json_quote(?), updated_at = ?, updated_by = 'system'
    WHERE key = 'publish_due_at' AND (json_type(value) = 'null' OR json_extract(value, '$') > ?)${guard ? ` AND ${guard.sql}` : ''}`,
  dueAt, at, dueAt, ...(guard?.params ?? []));
}

/** Clears publish_due_at (after a publish was requested) */
export function clearPublishDueStmt(db: D1, at: string): D1Statement {
  return stmt(db, "UPDATE settings SET value = 'null', updated_at = ?, updated_by = 'system' WHERE key = 'publish_due_at'", at);
}

/** Minutes the automatic publish waits after a stock-status change (design §2.5) */
export const STOCK_PUBLISH_DELAY_MINUTES = 30;

// ───────────────────────────── saving ─────────────────────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const LABELS: Record<EditableKey, string> = {
  show_prices: 'Show prices', stock_display: 'Stock display', delivery_note: 'Delivery note', offer: 'Offer banner',
  gift: 'Gift box settings', order_intake: 'Order recording', alerts: 'Alerts', business: 'Business details',
  privacy: 'Privacy', go_live_at: 'Go-live time',
};

function describe(key: EditableKey, before: unknown, after: unknown): string {
  if (key === 'show_prices') return `${LABELS[key]} ${before ? 'on' : 'off'} → ${after ? 'on' : 'off'}`;
  if (key === 'stock_display') return `${LABELS[key]}: ${after === 'sold_out' ? 'only Sold out' : 'Only a few left and Sold out'}`;
  if (key === 'order_intake' && isObj(before) && isObj(after) && before.enabled !== after.enabled) {
    return after.enabled ? 'Order recording switched on' : 'Order recording paused';
  }
  if (key === 'offer') return after === null ? 'Offer banner removed' : 'Offer banner changed';
  return `${LABELS[key]} changed`;
}

export interface SettingsSaved {
  /** keys that really changed (unchanged values are skipped) */
  changed: EditableKey[];
  effects: Effects;
}

/**
 * Saves settings from the Website screen (owner only). Only changed keys are written, all or nothing.
 * `versions` are the row versions the form was rendered with; a mismatch → 'conflict'.
 * Public keys bump live_version (show at once on /api/live.json); baked keys bump site_version and the
 * result asks for a publish (effects.publish = 'now').
 */
export async function updateSettings(db: D1, actor: Actor, input: {
  values: Partial<Pick<SettingsValues, EditableKey>>;
  versions?: Partial<Record<EditableKey, number>>;
}, at: string = nowIso()): Promise<Result<SettingsSaved>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  if (!isObj(input?.values)) return fail('invalid', 'Nothing to save.');

  const current = await getSettings(db);
  const codes = new Set((await all<{ code: string }>(db, 'SELECT code FROM variants')).map((r) => r.code));
  const changed: EditableKey[] = [];
  for (const [key, value] of Object.entries(input.values)) {
    if (!(EDITABLE_KEYS as readonly string[]).includes(key)) return fail('invalid', `"${key}" cannot be changed here.`, { field: key });
    const problem = validateSetting(key, value, { variantCodes: codes });
    if (problem) return fail('invalid', problem, { field: key });
    const k = key as EditableKey;
    if (same(current.values[k], value)) continue;
    const v = input.versions?.[k];
    if (v !== undefined && v !== current.versions[k]) return fail('conflict', 'Someone else changed these settings. Reload the page.', { field: key });
    if (k === 'go_live_at' && current.values.go_live_at !== null) return fail('not_allowed', 'The go-live time is already set and cannot be changed.', { field: key });
    changed.push(k);
  }
  if (!changed.length) return ok({ changed, effects: { publish: null, live: false } });

  const by = actor.email;
  const versionOf = (k: EditableKey) => input.versions?.[k] ?? current.versions[k];
  // all-or-nothing guard: every changed key still has the version the form saw
  const pairs = changed.map(() => '(key = ? AND version = ?)').join(' OR ');
  const before = changed.flatMap((k) => [k, versionOf(k)]);
  const afterGuard: Guard = {
    sql: `(SELECT COUNT(*) FROM settings WHERE ${pairs}) = ${changed.length} AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND updated_at = ? AND updated_by = ?)`,
    params: [...changed.flatMap((k) => [k, versionOf(k) + 1]), changed[0], at, by],
  };

  const statements: D1Statement[] = [];
  // a key added after the seed gets its row first (version 1)
  for (const k of changed) {
    statements.push(stmt(db, 'INSERT OR IGNORE INTO settings (key, value, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)',
      k, JSON.stringify(SETTINGS_DEFAULTS[k]), at, by));
  }
  statements.push(stmt(db, `UPDATE settings SET value = CASE key ${changed.map(() => 'WHEN ? THEN ?').join(' ')} END,
      version = version + 1, updated_at = ?, updated_by = ?
    WHERE key IN (${changed.map(() => '?').join(', ')}) AND (SELECT COUNT(*) FROM settings WHERE ${pairs}) = ${changed.length}`,
  ...changed.flatMap((k) => [k, JSON.stringify(input.values[k])]), at, by, ...changed, ...before));

  const live = changed.some((k) => (LIVE_KEYS as readonly string[]).includes(k));
  const site = changed.some((k) => (SITE_KEYS as readonly string[]).includes(k));
  if (live) statements.push(bumpVersionStmt(db, 'live_version', at, by, afterGuard));
  if (site) statements.push(bumpVersionStmt(db, 'site_version', at, by, afterGuard));
  statements.push(auditInsert(db, {
    at, actor, action: 'settings.save', entity: 'settings', entityId: changed.join(','),
    summary: changed.map((k) => describe(k, current.values[k], input.values[k])).join('; '),
    before: Object.fromEntries(changed.map((k) => [k, current.values[k]])),
    after: Object.fromEntries(changed.map((k) => [k, input.values[k]])),
  }, afterGuard));

  const res = await tryBatch(db, statements);
  if (!res.ok) return res;
  const updated = res.value[changed.length].meta.changes;
  if (updated !== changed.length) return fail('conflict', 'Someone else changed these settings. Reload the page.');
  return ok({ changed, effects: { publish: site ? 'now' : null, live } });
}
