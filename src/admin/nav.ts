// Admin screens: one list drives the desktop side nav, the phone tab bar and the "More" sheet.
// URLs keep the trailing slash (trailingSlash: 'always').

import type { IconName } from './icons';
import type { StringKey } from './strings';

export type Role = 'owner' | 'helper';

/** What the middleware puts in Astro.locals.admin (fixed contract 8). */
export interface AdminUser {
  email: string;
  role: Role;
}

export type NavKey =
  | 'today' | 'dashboard' | 'orders' | 'requests' | 'stock' | 'harvests' | 'batches' | 'labels' | 'invoices'
  | 'products' | 'prices' | 'website' | 'sales' | 'activity' | 'people' | 'backup' | 'help' | 'styleguide';

export type NavGroup = 'main' | 'daily' | 'shop' | 'reports' | 'setup';

export interface NavItem {
  key: NavKey;
  href: string;
  label: StringKey;
  icon: IconName;
  group: NavGroup;
  /** only owners see and may open it */
  ownerOnly?: boolean;
  /** listed nowhere (reachable by URL only), e.g. the style guide */
  hidden?: boolean;
}

export const NAV: readonly NavItem[] = [
  { key: 'today', href: '/admin/', label: 'nav.today', icon: 'today', group: 'main' },
  { key: 'dashboard', href: '/admin/dashboard/', label: 'nav.dashboard', icon: 'dashboard', group: 'main' },
  { key: 'orders', href: '/admin/orders/', label: 'nav.orders', icon: 'orders', group: 'daily' },
  { key: 'requests', href: '/admin/requests/', label: 'nav.requests', icon: 'requests', group: 'daily' },
  { key: 'stock', href: '/admin/stock/', label: 'nav.stock', icon: 'stock', group: 'daily' },
  { key: 'harvests', href: '/admin/harvests/', label: 'nav.harvests', icon: 'harvests', group: 'daily' },
  { key: 'batches', href: '/admin/batches/', label: 'nav.batches', icon: 'batches', group: 'daily' },
  { key: 'labels', href: '/admin/labels/', label: 'nav.labels', icon: 'labels', group: 'daily' },
  { key: 'invoices', href: '/admin/invoice/', label: 'nav.invoices', icon: 'invoices', group: 'daily' },
  { key: 'products', href: '/admin/products/', label: 'nav.products', icon: 'products', group: 'shop', ownerOnly: true },
  { key: 'prices', href: '/admin/prices/', label: 'nav.prices', icon: 'prices', group: 'shop', ownerOnly: true },
  { key: 'website', href: '/admin/website/', label: 'nav.website', icon: 'website', group: 'shop', ownerOnly: true },
  { key: 'sales', href: '/admin/sales/', label: 'nav.sales', icon: 'sales', group: 'reports' },
  { key: 'activity', href: '/admin/activity/', label: 'nav.activity', icon: 'activity', group: 'reports', ownerOnly: true },
  { key: 'people', href: '/admin/people/', label: 'nav.people', icon: 'people', group: 'setup', ownerOnly: true },
  { key: 'backup', href: '/admin/backup/', label: 'nav.backup', icon: 'backup', group: 'setup', ownerOnly: true },
  { key: 'help', href: '/admin/help/', label: 'nav.help', icon: 'help', group: 'setup' },
  { key: 'styleguide', href: '/admin/styleguide/', label: 'nav.styleguide', icon: 'styleguide', group: 'setup', ownerOnly: true, hidden: true },
];

export const NAV_GROUPS: readonly { group: NavGroup; label: StringKey | null }[] = [
  { group: 'main', label: null },
  { group: 'daily', label: 'nav.group.daily' },
  { group: 'shop', label: 'nav.group.shop' },
  { group: 'reports', label: 'nav.group.reports' },
  { group: 'setup', label: 'nav.group.setup' },
];

/** Phone bottom bar: Today · Orders · Stock · Products · More (helpers get Harvests in place of Products). */
export function tabsFor(role: Role | undefined): NavItem[] {
  const keys: NavKey[] = role === 'helper' ? ['today', 'orders', 'stock', 'harvests'] : ['today', 'orders', 'stock', 'products'];
  return keys.map((k) => navItem(k));
}

export function navItem(key: NavKey): NavItem {
  const item = NAV.find((n) => n.key === key);
  if (!item) throw new Error(`Unknown nav key ${key}`);
  return item;
}

/** Screens this person may see in the menus. With no role yet (dev before the middleware), everything is listed. */
export function navFor(role: Role | undefined): NavItem[] {
  return NAV.filter((n) => !n.hidden && (role !== 'helper' || !n.ownerOnly));
}

/** True when this role may open the screen (owner-only screens refuse helpers). */
export function canOpen(role: Role | undefined, key: NavKey): boolean {
  const item = navItem(key);
  return !item.ownerOnly || role === 'owner';
}

/**
 * The nav key for a path, by longest matching href: '/admin/orders/12/' → 'orders', '/admin/' → 'today'.
 * Paths outside /admin/ give undefined.
 */
export function navKeyForPath(pathname: string): NavKey | undefined {
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  let best: NavItem | undefined;
  for (const n of NAV) {
    if (path === n.href || (n.href !== '/admin/' && path.startsWith(n.href))) {
      if (!best || n.href.length > best.href.length) best = n;
    }
  }
  if (!best && path === '/admin/') return 'today';
  return best?.key;
}
