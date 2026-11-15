// Words for the browser scripts: AdminLayout puts the needed keys (CLIENT_KEYS in ../strings.ts) in
// <script type="application/json" id="admin-strings">, so the full word list never ships to the browser.
import type { ClientKey } from '../strings';

let table: Record<string, string> | null = null;

export function s(key: ClientKey, vars?: Record<string, string | number>): string {
  if (!table) {
    try {
      table = JSON.parse(document.getElementById('admin-strings')?.textContent || '{}') as Record<string, string>;
    } catch {
      table = {};
    }
  }
  const text = table[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
