// Drafts for long forms: <form data-draft="product-12"> keeps what was typed in this browser (localStorage),
// so a dropped connection, an expired login or a closed tab never loses work.
// - Saved half a second after typing stops, and at once when a send is held back (login expired).
// - On the next visit a bar offers "Bring them back" / "Throw away" when the draft differs from the page.
// - A draft that was sent and came back with a green (ok) flash is removed. Drafts older than 7 days are removed.
// - Hidden, password and file inputs, and anything inside or marked [data-no-draft], are never stored.
// - If the record's hidden "version" changed since the draft, the bar warns that someone saved meanwhile.
import { dateTimeIST, dayIST, timeIST } from '../format';
import { $, $$, fire, store } from './dom';
import { s } from './strings';

const PREFIX = 'bz-draft:';
const MAX_AGE = 7 * 24 * 3600 * 1000;
const SKIP = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image']);

type Snapshot = Record<string, string[]>;
interface Draft {
  t: number;
  path: string;
  v: string | null;
  sent?: 1;
  f: Snapshot;
}
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function controls(form: HTMLFormElement): Control[] {
  return Array.from(form.elements).filter((el): el is Control => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return false;
    if (!el.name || el.disabled) return false;
    if (el instanceof HTMLInputElement && SKIP.has(el.type)) return false;
    return !el.closest('[data-no-draft]');
  });
}

export function snapshot(form: HTMLFormElement): Snapshot {
  const snap: Snapshot = {};
  for (const el of controls(form)) {
    const list = (snap[el.name] ??= []);
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      if (el.checked) list.push(el.value);
    } else if (el instanceof HTMLSelectElement && el.multiple) {
      for (const o of Array.from(el.selectedOptions)) list.push(o.value);
    } else {
      list.push(el.value);
    }
  }
  return snap;
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] ?? [];
    const y = b[k] ?? [];
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
  }
  return true;
}

function apply(form: HTMLFormElement, snap: Snapshot): void {
  const seen = new Map<string, number>();
  for (const el of controls(form)) {
    const values = snap[el.name];
    if (!values) continue;
    let changed = false;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const want = values.includes(el.value);
      changed = el.checked !== want;
      el.checked = want;
    } else if (el instanceof HTMLSelectElement && el.multiple) {
      for (const o of Array.from(el.options)) {
        const want = values.includes(o.value);
        if (o.selected !== want) { o.selected = want; changed = true; }
      }
    } else {
      // several fields with the same name (e.g. qty per line) are filled in page order
      const i = seen.get(el.name) ?? 0;
      seen.set(el.name, i + 1);
      const v = values[i];
      if (v !== undefined && el.value !== v) { el.value = v; changed = true; }
    }
    if (changed) fire(el);
  }
}

function versionOf(form: HTMLFormElement): string | null {
  const v = form.elements.namedItem('version');
  return v instanceof HTMLInputElement ? v.value : null;
}

function read(st: Storage, key: string): Draft | null {
  try {
    const d = JSON.parse(st.getItem(key) || 'null') as Draft | null;
    return d && typeof d.t === 'number' && d.f && typeof d.f === 'object' ? d : null;
  } catch {
    return null;
  }
}

function write(st: Storage, key: string, d: Draft): void {
  try {
    st.setItem(key, JSON.stringify(d));
  } catch {
    /* storage full or blocked: drafts are a convenience only */
  }
}

function cleanup(st: Storage): void {
  const now = Date.now();
  for (let i = st.length - 1; i >= 0; i--) {
    const k = st.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    const d = read(st, k);
    if (!d || now - d.t > MAX_AGE) st.removeItem(k);
  }
}

function when(t: number): string {
  return dayIST(t) === dayIST(Date.now()) ? timeIST(t) : dateTimeIST(t);
}

function showBar(form: HTMLFormElement, d: Draft, onRestore: () => void, onDiscard: () => void): void {
  const bar = document.createElement('div');
  const changedSince = d.v !== null && versionOf(form) !== null && d.v !== versionOf(form);
  bar.className = `draft-bar${changedSince ? ' is-warn' : ''}`;
  bar.setAttribute('role', 'status');
  const p = document.createElement('p');
  p.textContent = s('draft.found', { time: when(d.t) }) + (changedSince ? ` ${s('draft.changedSince')}` : '');
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'btn btn-primary';
  restore.textContent = s('draft.restore');
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'btn';
  discard.textContent = s('draft.discard');
  restore.addEventListener('click', () => {
    onRestore();
    p.textContent = s('draft.restored');
    restore.remove();
    discard.remove();
    window.setTimeout(() => bar.remove(), 8000);
  });
  discard.addEventListener('click', () => {
    onDiscard();
    bar.remove();
  });
  bar.append(p, restore, discard);
  form.before(bar);
}

export function initDrafts(): void {
  const st = store();
  if (!st) return;
  cleanup(st);
  const okFlash = !!$('#page-flash[data-flash="ok"]');
  const forms = new Map<HTMLFormElement, { sent(): void; hold(): void; reopen(): void }>();

  for (const form of $$<HTMLFormElement>('form[data-draft]')) {
    const key = PREFIX + form.dataset.draft;
    const initial = snapshot(form);
    let timer = 0;
    // once the form is on its way, a late debounced save must not overwrite the "sent" mark
    let sending = false;
    const save = (sent: boolean) => {
      const snap = snapshot(form);
      if (sameSnapshot(snap, initial)) { st.removeItem(key); return; }
      write(st, key, { t: Date.now(), path: location.pathname, v: versionOf(form), f: snap, ...(sent ? { sent: 1 as const } : {}) });
    };
    const later = () => {
      if (sending) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (!sending) save(false); }, 500);
    };
    forms.set(form, {
      sent: () => { window.clearTimeout(timer); sending = true; save(true); },
      hold: () => { window.clearTimeout(timer); save(false); },
      reopen: () => { sending = false; },
    });

    const existing = read(st, key);
    if (existing) {
      if ((existing.sent && okFlash) || sameSnapshot(existing.f, initial)) st.removeItem(key);
      else showBar(form, existing, () => { apply(form, existing.f); window.clearTimeout(timer); save(false); }, () => st.removeItem(key));
    }

    form.addEventListener('input', later);
    form.addEventListener('change', later);
  }

  const formOf = (e: Event) => (e as CustomEvent<{ form: HTMLFormElement }>).detail.form;
  document.addEventListener('bz:submitted', (e) => forms.get(formOf(e))?.sent());
  document.addEventListener('bz:hold', (e) => forms.get(formOf(e))?.hold());
  // back/forward cache: the page is live again, typing must be saved again
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) for (const f of forms.values()) f.reopen();
  });
}
