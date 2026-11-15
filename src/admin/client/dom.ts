// Tiny DOM helpers for the admin scripts.

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

export function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

/** localStorage, or null when the browser blocks it (private mode, settings). */
export function store(): Storage | null {
  try {
    const st = window.localStorage;
    const probe = '__bz';
    st.setItem(probe, '1');
    st.removeItem(probe);
    return st;
  } catch {
    return null;
  }
}

/** Fires input + change so live hints, totals and drafts notice a value set by script. */
export function fire(el: Element): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function isBare(): boolean {
  return document.body.hasAttribute('data-bare');
}
