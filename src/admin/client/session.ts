// Login-session watch. One request (GET /admin/api/status.json) serves two jobs: it feeds the website status chip
// and tells us whether the login is still valid. An expired login shows "Login expired — tap to sign in again"
// (opens the login in a new tab, so nothing typed on this page is lost); coming back signed in hides it again.
//
// Expired = 401/403, a redirect to /admin/login/, or an HTML page where JSON was expected.
// Network errors, 404 and 5xx are "unknown": they never block anything.
import { $, isBare } from './dom';
import { s } from './strings';

export type SessionState = 'ok' | 'expired' | 'unknown';
export interface StatusResult {
  state: SessionState;
  data: unknown;
}

type Listener = (r: StatusResult) => void;
const listeners: Listener[] = [];
let lastOkAt = Date.now(); // the page itself just loaded with a valid login
let expired = false;
let backTimer = 0;
let inflight: Promise<StatusResult> | null = null;

export function lastOk(): number {
  return lastOkAt;
}

export function isExpired(): boolean {
  return expired;
}

export function onStatus(fn: Listener): void {
  listeners.push(fn);
}

function banner(): HTMLElement | null {
  return $('[data-session-banner]');
}

function showExpired(): void {
  const b = banner();
  if (!b) return;
  window.clearTimeout(backTimer);
  b.classList.remove('is-back');
  const text = $('[data-session-text]', b);
  const hint = $('[data-session-hint]', b);
  if (text) text.textContent = s('session.expired');
  if (hint) {
    hint.textContent = s('session.expiredHint');
    hint.hidden = false;
  }
  b.hidden = false;
}

function showBack(): void {
  const b = banner();
  if (!b || b.hidden) return;
  b.classList.add('is-back');
  const text = $('[data-session-text]', b);
  const hint = $('[data-session-hint]', b);
  if (text) text.textContent = s('session.back');
  if (hint) hint.hidden = true;
  backTimer = window.setTimeout(() => {
    b.hidden = true;
    b.classList.remove('is-back');
  }, 6000);
}

function settle(r: StatusResult): StatusResult {
  if (r.state === 'expired') {
    expired = true;
    showExpired();
  } else if (r.state === 'ok') {
    lastOkAt = Date.now();
    if (expired) {
      expired = false;
      showBack();
    }
  }
  for (const fn of listeners) {
    try {
      fn(r);
    } catch {
      /* a listener must never break the others */
    }
  }
  return r;
}

/** Classifies a status.json response (exported for tests). */
export function classify(res: { status: number; ok: boolean; redirected: boolean; url: string; type: string }): SessionState | 'json' {
  let path = '';
  try {
    path = new URL(res.url, 'http://x').pathname;
  } catch {
    /* keep '' */
  }
  if (res.status === 401 || res.status === 403 || (res.redirected && path.startsWith('/admin/login'))) return 'expired';
  if (res.ok && res.type.includes('text/html')) return 'expired';
  if (!res.ok || !res.type.includes('json')) return 'unknown';
  return 'json';
}

async function request(): Promise<StatusResult> {
  const url = document.body.dataset.statusUrl;
  if (!url || isBare()) return { state: 'unknown', data: null };
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    const kind = classify({
      status: res.status,
      ok: res.ok,
      redirected: res.redirected,
      url: res.url || url,
      type: (res.headers.get('content-type') || '').toLowerCase(),
    });
    if (kind !== 'json') return { state: kind, data: null };
    return { state: 'ok', data: await res.json() };
  } catch {
    return { state: 'unknown', data: null };
  } finally {
    window.clearTimeout(timer);
  }
}

/** Asks the server now (calls at the same moment share one request). */
export function checkSession(): Promise<StatusResult> {
  if (!inflight) inflight = request().then(settle).finally(() => { inflight = null; });
  return inflight;
}

export function initSession(): void {
  if (isBare()) return;
  // coming back to this tab (e.g. after signing in on the other tab) re-checks at once when we know it expired,
  // or when the last good answer is old
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (expired || Date.now() - lastOkAt > 60_000)) void checkSession();
  });
  window.addEventListener('focus', () => {
    if (expired) void checkSession();
  });
}
