// One place decides what happens when any admin form is sent:
// 1. data-confirm on the pressed button (or the form) → the "Are you sure?" dialog first;
// 2. POST forms when the login was last confirmed over a minute ago → a quick login check; if it expired, the send
//    is held (text stays on the page, the draft is saved) and the "Login expired" banner shows;
// 3. then the form goes as normal, its buttons are disabled to stop double taps ("Saving…"), and drafts are told.
// Without JavaScript none of this runs and forms simply submit. Opt out per form with data-no-guard / data-no-once.
import { askConfirm } from './confirm';
import { isBare } from './dom';
import { checkSession, lastOk } from './session';
import { s } from './strings';

type Submitter = HTMLButtonElement | HTMLInputElement;
const PASS = new WeakSet<HTMLFormElement>();
const lastClicked = new WeakMap<HTMLFormElement, Submitter>();
const GUARD_AFTER = 60_000;

function submitButtons(form: HTMLFormElement): Submitter[] {
  return Array.from(form.elements).filter((el): el is Submitter =>
    (el instanceof HTMLButtonElement && el.type === 'submit') || (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image')));
}

function afterSubmit(form: HTMLFormElement, sub: Submitter | null): void {
  document.dispatchEvent(new CustomEvent('bz:submitted', { detail: { form } }));
  if (form.hasAttribute('data-no-once') || (form.target && form.target !== '_self')) return;
  form.classList.add('is-submitting');
  // disable after the browser has collected the form data (a disabled button would drop its _action value)
  window.setTimeout(() => {
    for (const b of submitButtons(form)) {
      if (b.disabled) continue;
      b.disabled = true;
      b.dataset.bzOnce = '';
    }
    if (sub instanceof HTMLButtonElement && sub.dataset.bzOnce !== undefined && (form.getAttribute('method') ?? 'get').toLowerCase() === 'post') {
      sub.dataset.bzLabel = sub.innerHTML;
      sub.textContent = s('common.saving');
    }
  }, 0);
  // a download or a slow answer must not leave the page stuck
  window.setTimeout(() => release(form), 12_000);
}

function release(form: HTMLFormElement): void {
  form.classList.remove('is-submitting');
  for (const b of submitButtons(form)) {
    if (b.dataset.bzOnce === undefined) continue;
    b.disabled = false;
    delete b.dataset.bzOnce;
    if (b.dataset.bzLabel !== undefined) {
      b.innerHTML = b.dataset.bzLabel;
      delete b.dataset.bzLabel;
    }
  }
}

function resubmit(form: HTMLFormElement, sub: Submitter | null): void {
  PASS.add(form);
  if (typeof form.requestSubmit === 'function') {
    if (sub && sub.form === form) form.requestSubmit(sub);
    else form.requestSubmit();
    return;
  }
  // very old browsers: carry the pressed button's value by hand (form.submit() skips the submit event)
  if (sub && sub.name) {
    const h = document.createElement('input');
    h.type = 'hidden';
    h.name = sub.name;
    h.value = sub.value;
    form.append(h);
  }
  PASS.delete(form);
  afterSubmit(form, sub);
  form.submit();
}

export function initSubmit(): void {
  // remember the pressed button for browsers without SubmitEvent.submitter
  document.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.('button, input[type="submit"], input[type="image"]') as Submitter | null;
    if (b && b.form && (b.type === 'submit' || b.type === 'image')) lastClicked.set(b.form, b);
  }, true);

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || (form.getAttribute('method') ?? 'get').toLowerCase() === 'dialog') return;
    if (e.defaultPrevented) {
      // a page script took over this send (e.g. a fetch); stay out of its way
      PASS.delete(form);
      return;
    }
    const sub = ((e as SubmitEvent).submitter as Submitter | null) ?? lastClicked.get(form) ?? null;
    if (PASS.has(form)) {
      PASS.delete(form);
      afterSubmit(form, sub);
      return;
    }
    const message = sub?.dataset.confirm ?? form.dataset.confirm;
    const guard = (form.getAttribute('method') ?? 'get').toLowerCase() === 'post' && !isBare() && !form.hasAttribute('data-no-guard')
      && Date.now() - lastOk() > GUARD_AFTER;
    if (!message && !guard) {
      afterSubmit(form, sub);
      return;
    }
    e.preventDefault();
    void (async () => {
      if (message) {
        const ok = await askConfirm({
          message,
          title: sub?.dataset.confirmTitle ?? form.dataset.confirmTitle,
          ok: sub?.dataset.confirmOk ?? form.dataset.confirmOk,
          danger: (sub?.dataset.confirmTone ?? form.dataset.confirmTone) === 'danger',
        });
        if (!ok) return;
      }
      if (guard) {
        const r = await checkSession();
        if (r.state === 'expired') {
          document.dispatchEvent(new CustomEvent('bz:hold', { detail: { form } }));
          return;
        }
      }
      resubmit(form, sub);
    })();
  });

  // Back/forward cache: a page restored after sending must not keep its buttons disabled
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) for (const f of Array.from(document.forms)) release(f);
  });
}
