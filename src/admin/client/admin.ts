// The admin's one shared browser script (bundled by Astro from AdminLayout; no third-party code).
// Pages work without it; it adds the confirm dialog, drafts, login-expiry detection, the status chip and small helpers.
import { initConfirmLinks } from './confirm';
import { initDrafts } from './drafts';
import { initEnhance } from './enhance';
import { initSession } from './session';
import { initStatusChip } from './status';
import { initSubmit } from './submit';

function start(): void {
  initEnhance();
  initDrafts();
  initSubmit();
  initConfirmLinks();
  initSession();
  initStatusChip();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
