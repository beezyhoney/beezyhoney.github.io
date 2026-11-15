// "Are you sure?" using the shared <dialog id="confirm-dialog"> (components/ConfirmDialog.astro).
// Falls back to window.confirm when the dialog is missing (login page) or <dialog> is not supported.
import { $ } from './dom';

export interface ConfirmOptions {
  message: string;
  title?: string;
  ok?: string;
  danger?: boolean;
}

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  const dlg = $<HTMLDialogElement>('#confirm-dialog');
  if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(opts.message));
  const title = $('#confirm-title', dlg);
  const msg = $('#confirm-msg', dlg);
  const yes = $<HTMLButtonElement>('[data-confirm-yes]', dlg);
  if (title) title.textContent = opts.title || title.dataset.default || '';
  if (msg) msg.textContent = opts.message;
  if (yes) {
    yes.textContent = opts.ok || yes.dataset.default || 'OK';
    yes.classList.toggle('btn-danger', !!opts.danger);
    yes.classList.toggle('btn-primary', !opts.danger);
  }
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    // the safe choice ("Go back") has focus first, so an accidental Enter never confirms
    $<HTMLButtonElement>('[data-confirm-cancel]', dlg)?.focus();
  });
}

/** <a data-confirm="…"> links (rare: most actions are forms) */
export function initConfirmLinks(): void {
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[data-confirm]') as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void askConfirm({
      message: a.dataset.confirm || '',
      title: a.dataset.confirmTitle,
      ok: a.dataset.confirmOk,
      danger: a.dataset.confirmTone === 'danger',
    }).then((ok) => {
      if (ok) window.location.assign(a.href);
    });
  });
}
