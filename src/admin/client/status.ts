// Website status chip, fed by GET /admin/api/status.json (see README "Status chip contract"):
//   { "website": { "state": "up_to_date" | "updating" | "waiting" | "failed" | "off", "at": ISO time | null } }
// The `website` object may also be src/server/publish.ts getPublishStatus() as it is ('disabled' = 'off'; the time
// is taken from last.liveAt / last.requestedAt / dueAt when there is no `at`).
// Polls every 20 s while an update is running or waiting, otherwise every 2 minutes, only while the tab is visible.
// Anything unexpected leaves the chip neutral ("Website"). Failures are silent.
import { ageShort, timeIST } from '../format';
import { $, isBare } from './dom';
import { checkSession, onStatus, type StatusResult } from './session';
import { s } from './strings';

export type ChipState = 'up_to_date' | 'updating' | 'waiting' | 'failed' | 'off';
const STATES: readonly ChipState[] = ['up_to_date', 'updating', 'waiting', 'failed', 'off'];
const FAST = 20_000;
const SLOW = 120_000;
let timer = 0;
let lastState: ChipState | 'unknown' = 'unknown';
let lastAt = 0;

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Reads the website part of a status answer; null when it is not in the expected shape. */
export function websiteOf(data: unknown): { state: ChipState; at: string | null } | null {
  if (!data || typeof data !== 'object') return null;
  const w = (data as { website?: unknown }).website;
  if (!w || typeof w !== 'object') return null;
  const o = w as { state?: unknown; at?: unknown; dueAt?: unknown; last?: unknown };
  const state = o.state === 'disabled' ? 'off' : o.state;
  if (!STATES.includes(state as ChipState)) return null;
  if (o.at !== undefined) return { state: state as ChipState, at: isTime(o.at) ? o.at : null };
  // publish.ts PublishStatus: pick the moment that belongs to the state
  const last = o.last && typeof o.last === 'object' ? (o.last as { liveAt?: unknown; requestedAt?: unknown }) : {};
  const at = state === 'waiting' ? o.dueAt
    : state === 'updating' ? last.requestedAt
    : state === 'up_to_date' ? (isTime(last.liveAt) ? last.liveAt : last.requestedAt)
    : null;
  return { state: state as ChipState, at: isTime(at) ? at : null };
}

/** The chip's long (wide screens) and short (phones) words. */
export function chipTexts(state: ChipState | 'unknown', at: string | null, now = Date.now()): { long: string; short: string } {
  switch (state) {
    case 'up_to_date':
      return { long: at ? s('chip.upToDate', { time: timeIST(at) }) : s('chip.upToDateShort'), short: s('chip.upToDateShort') };
    case 'updating':
      return { long: at ? s('chip.updating', { ago: ageShort(at, now) }) : s('chip.updatingShort'), short: s('chip.updatingShort') };
    case 'waiting':
      return { long: at ? s('chip.waiting', { time: timeIST(at) }) : s('chip.waitingShort'), short: s('chip.waitingShort') };
    case 'failed':
      return { long: s('chip.failed'), short: s('chip.failed') };
    case 'off':
      return { long: s('chip.off'), short: s('chip.offShort') };
    default:
      return { long: s('chip.unknown'), short: s('chip.unknown') };
  }
}

function render(r: StatusResult): void {
  const chip = $('[data-site-chip]');
  if (!chip) return;
  const w = r.state === 'ok' ? websiteOf(r.data) : null;
  // keep the last good state through a passing network hiccup
  if (!w && r.state === 'unknown' && lastState !== 'unknown') return;
  const state = w?.state ?? 'unknown';
  const tx = chipTexts(state, w?.at ?? null);
  chip.dataset.state = state;
  const long = $('[data-chip-long]', chip);
  const short = $('[data-chip-short]', chip);
  if (long) long.textContent = tx.long;
  if (short) short.textContent = tx.short;
  chip.title = tx.long;
  lastState = state;
}

function schedule(): void {
  window.clearTimeout(timer);
  if (document.visibilityState !== 'visible') return;
  const wait = lastState === 'updating' || lastState === 'waiting' ? FAST : SLOW;
  timer = window.setTimeout(tick, wait);
}

function tick(): void {
  lastAt = Date.now();
  void checkSession().finally(schedule);
}

export function initStatusChip(): void {
  if (isBare() || !$('[data-site-chip]')) return;
  onStatus(render);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      window.clearTimeout(timer);
      return;
    }
    if (Date.now() - lastAt > FAST) tick();
    else schedule();
  });
  // first look once the page has settled, so it never competes with the page itself
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(tick, { timeout: 2500 });
  else window.setTimeout(tick, 800);
}
