import { waLink } from '../data/site';

export interface CartItem { slug: string; name: string; pack: string; qty: number }

const KEY = 'beezy-cart-v1';
const FIELDS_KEY = 'beezy-cart-fields';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode or storage blocked */ }
}

const load = () => read<CartItem[]>(KEY, []).filter((i) => i && i.slug && i.qty > 0);
// Re-read storage before every read and change, so another tab or a page restored
// from the back/forward cache never works from an old copy of the order.
let items: CartItem[] = load();
const fresh = () => { items = load(); return items; };

function commit() {
  write(KEY, items);
  window.dispatchEvent(new CustomEvent('cart:change'));
}

window.addEventListener('storage', (e) => {
  if (e.key === KEY) window.dispatchEvent(new CustomEvent('cart:change'));
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) window.dispatchEvent(new CustomEvent('cart:change'));
});

export const cart = {
  items: () => fresh(),
  count: () => fresh().reduce((n, i) => n + i.qty, 0),
  find: (slug: string, pack: string) => fresh().find((i) => i.slug === slug && i.pack === pack),
  /** Put a product + pack in the order with exactly this quantity (replaces any earlier quantity) */
  set(item: CartItem) {
    fresh();
    const qty = Math.max(1, Math.min(99, item.qty));
    const found = items.find((i) => i.slug === item.slug && i.pack === item.pack);
    if (found) found.qty = qty;
    else items.push({ ...item, qty });
    commit();
  },
  setQty(index: number, qty: number) {
    fresh();
    if (!items[index]) return;
    if (qty <= 0) items.splice(index, 1);
    else items[index].qty = Math.min(99, qty);
    commit();
  },
  remove(index: number) { fresh(); items.splice(index, 1); commit(); },
  clear() { items = []; commit(); },
};

export const savedFields = () => read<{ name?: string; pin?: string }>(FIELDS_KEY, {});
export const saveFields = (f: { name?: string; pin?: string }) => write(FIELDS_KEY, f);

export function orderMessage(list: CartItem[], name = '', pin = '') {
  const lines = list.map((i, n) => `${n + 1}. ${i.name} – ${i.pack} × ${i.qty}`);
  let msg = `Hi Beezy Honey! I'd like to order:\n${lines.join('\n')}`;
  const extra = [name.trim() && `Name: ${name.trim()}`, pin.trim() && `Pincode: ${pin.trim()}`].filter(Boolean).join('\n');
  if (extra) msg += `\n\n${extra}`;
  return `${msg}\n\nPlease share the price and delivery details.`;
}

export const orderLink = (list: CartItem[], name?: string, pin?: string) => waLink(orderMessage(list, name, pin));
