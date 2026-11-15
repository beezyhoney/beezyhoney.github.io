// Every word the admin shows, in one place (English now; keys are ready for Tamil later, amendment A5).
//
// - Core words (navigation, buttons, form errors, statuses, flash messages, component labels) live in EN below.
// - A screen with many words of its own may keep them in src/admin/strings/<area>.ts made with defineStrings(),
//   so two people can add words at the same time without editing this file. Its t() also knows every core key.
// - Placeholders look like {name}; t('nav.signedInAs', { email }) fills them. A missing value leaves {name} visible
//   (easy to spot in testing) instead of printing "undefined".
// - Tamil: add a TA table with the same keys. Anything missing falls back to English.

export type Lang = 'en' | 'ta';
export type Vars = Record<string, string | number>;

export const EN = {
  // app shell
  'app.name': 'Beezy Admin',
  'app.brand': 'Beezy Honey',
  'app.admin': 'Admin',
  'app.skip': 'Skip to content',
  'app.titleSuffix': 'Beezy Admin',

  // navigation
  'nav.label': 'Admin screens',
  'nav.tabsLabel': 'Main screens',
  'nav.group.daily': 'Daily work',
  'nav.group.shop': 'Shop and website',
  'nav.group.reports': 'Reports',
  'nav.group.setup': 'Settings and help',
  'nav.today': 'Today',
  'nav.orders': 'Orders',
  'nav.requests': 'Requests',
  'nav.stock': 'Stock',
  'nav.harvests': 'Harvests',
  'nav.batches': 'Batches',
  'nav.labels': 'Labels',
  'nav.invoices': 'Invoices',
  'nav.products': 'Products',
  'nav.prices': 'Prices',
  'nav.website': 'Website',
  'nav.sales': 'Sales',
  'nav.activity': 'Activity',
  'nav.people': 'People',
  'nav.backup': 'Backup',
  'nav.help': 'Help',
  'nav.styleguide': 'Style guide',
  'nav.more': 'More',
  'nav.moreTitle': 'All screens',
  'nav.close': 'Close',
  'nav.signedInAs': 'Signed in as {email}',
  'nav.logout': 'Log out',
  'nav.back': 'Back',
  'role.owner': 'Owner',
  'role.helper': 'Helper',

  // website status chip (fed by GET /admin/api/status.json)
  'chip.label': 'Website status',
  'chip.unknown': 'Website',
  'chip.upToDate': 'Website up to date ✓ ({time})',
  'chip.upToDateShort': 'Website up to date ✓',
  'chip.updating': 'Updating… started {ago} ago',
  'chip.updatingShort': 'Updating…',
  'chip.waiting': 'Changes waiting, update at {time}',
  'chip.waitingShort': 'Changes waiting',
  'chip.failed': "Update didn't finish",
  'chip.off': 'Publishing is off on this computer',
  'chip.offShort': 'Publishing off',

  // login session
  'session.expired': 'Login expired — tap to sign in again',
  'session.expiredHint': 'What you typed stays on this page. Sign in on the new tab, come back here and tap Save again.',
  'session.back': 'You are signed in again. You can save now.',

  // drafts of long forms (kept in this browser only)
  'draft.found': 'You have unsaved changes from {time}.',
  'draft.restore': 'Bring them back',
  'draft.discard': 'Throw away',
  'draft.restored': 'Your changes are back. Check them and tap Save.',
  'draft.changedSince': 'Someone saved this page after you typed these changes. Check every field before saving.',

  // confirm dialog
  'confirm.title': 'Are you sure?',
  'confirm.ok': 'Yes, go ahead',
  'confirm.cancel': 'Go back',

  // common words
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.apply': 'Apply',
  'common.show': 'Show',
  'common.search': 'Search',
  'common.clear': 'Clear',
  'common.edit': 'Edit',
  'common.add': 'Add',
  'common.close': 'Close',
  'common.dismiss': 'Dismiss',
  'common.optional': 'optional',
  'common.none': 'None',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.on': 'On',
  'common.off': 'Off',
  'common.loading': 'Loading…',
  'common.dash': '—',
  'common.error': 'Error',

  // form errors (forms.ts)
  'form.required': 'Please fill this in.',
  'form.tooLong': 'Please keep it to {max} characters or fewer.',
  'form.tooShort': 'Please type at least {min} characters.',
  'form.notNumber': 'Please type a whole number, like 12.',
  'form.notMoney': 'Please type an amount in rupees, like 350 or 1,050.50.',
  'form.notWeight': 'Please type a weight in kg, like 2.5 (or in grams, like 500 g).',
  'form.notDate': 'Please pick a date.',
  'form.notMonth': 'Please pick a month.',
  'form.tooSmall': 'The smallest allowed is {min}.',
  'form.tooBig': 'The largest allowed is {max}.',
  'form.notChoice': 'Please pick one of the choices.',
  'form.negative': 'This cannot be below zero.',
  'form.zero': 'This cannot be zero.',
  'form.dateTooEarly': 'Please pick {min} or later.',
  'form.dateTooLate': 'Please pick {max} or earlier.',
  'form.badFormat': 'This does not look right. Please check it.',
  'form.fixErrors': 'Please fix the marked fields and try again. Nothing was saved yet.',
  'form.unknownAction': 'That button did not work. Please reload the page and try again.',
  'form.unreadable': 'The form could not be read. Please reload the page and try again.',

  // flash messages after a save (keys usable in ?flash=<key>; see flash.ts)
  'flash.saved': 'Saved.',
  'flash.added': 'Added.',
  'flash.updated': 'Updated.',
  'flash.cancelled': 'Cancelled.',
  'flash.nothingChanged': 'Nothing was changed.',
  'flash.conflict': 'Someone else changed this just now. Nothing was saved. Check the page and try again.',
  'flash.notFound': 'That was not found. It may have been removed.',
  'flash.forbidden': 'Only the owner can do that.',
  'flash.invalid': 'Something in the form was not right. Nothing was saved.',
  'flash.error': 'Something went wrong and nothing was saved. Please try again.',
  'flash.signedOut': 'You are logged out.',
  'flash.publishQueued': 'Website update started. It usually takes 2–5 minutes.',
  'flash.publishOff': 'Publishing is off on this computer.',
  'flash.notReady': 'This part is not connected yet.',
  'flash.tone.ok': 'Done',
  'flash.tone.info': 'Note',
  'flash.tone.warn': 'Please check',
  'flash.tone.error': 'Problem',

  // money, weights and counts
  'money.symbol': '₹',
  'money.inRupees': 'in rupees',
  'money.priceOnWhatsApp': 'Price on WhatsApp',
  'money.emptyMeansWhatsApp': 'Leave empty for "Price on WhatsApp".',
  'weight.kg': 'kg',
  'weight.g': 'g',
  'weight.inKg': 'in kg',
  'weight.equals': '= {grams} g',
  'weight.jars': '≈ {list}',
  'weight.or': 'or',
  'stepper.decrease': 'One less',
  'stepper.increase': 'One more',

  // components
  'table.empty': 'Nothing to show yet.',
  'stat.vs': 'vs {period}',
  'stat.up': 'Up',
  'stat.down': 'Down',
  'stat.same': 'Same as {period}',
  'stat.new': 'New since {period}',
  'stat.lastMonth': 'last month',
  'chart.noData': 'No sales in this period yet.',
  'chart.table': 'Values shown in the chart',
  'chart.label': 'Label',
  'chart.value': 'Value',
  'empty.title': 'Nothing here yet',
  'pager.label': 'Pages',
  'pager.prev': 'Previous',
  'pager.next': 'Next',
  'pager.of': 'Page {page} of {pages}',
  'pager.page': 'Page {page}',
  'range.legend': 'Dates',
  'range.from': 'From',
  'range.to': 'To',
  'range.apply': 'Show',
  'range.presets': 'Quick picks',
  'range.today': 'Today',
  'range.last7': 'Last 7 days',
  'range.thisMonth': 'This month',
  'range.lastMonth': 'Last month',
  'range.thisFy': 'This financial year',
  'range.lastFy': 'Last financial year',
  'range.thisYear': 'This calendar year',
  'range.backwards': 'The "To" date must be on or after the "From" date.',
  'photo.none': 'No photos yet.',
  'photo.noneOption': 'No photo',
  'photo.selected': 'Chosen',
  'photo.upload': 'Upload a photo',
  'photo.uploadSoon': 'Uploading needs JavaScript turned on',
  'photo.library': 'Website photos',
  'search.findOrder': 'Find an order',
  'search.findOrderHint': 'Type the order code from WhatsApp, like BZ-7K3QD, or just the last 3 or 4 letters.',
  'search.go': 'Find',

  // statuses (Badge.astro / status.ts)
  'status.order.new': 'New',
  'status.order.confirmed': 'Confirmed',
  'status.order.packed': 'Packed',
  'status.order.shipped': 'Sent',
  'status.order.delivered': 'Delivered',
  'status.order.cancelled': 'Cancelled',
  'status.order.spam': 'Not a real order',
  'status.product.draft': 'Draft',
  'status.product.live': 'On website',
  'status.product.paused': 'Paused',
  'status.product.retired': 'Retired',
  'status.stock.in': 'In stock',
  'status.stock.low': 'Low',
  'status.stock.out': 'Sold out',
  'status.stock.negative': 'Below zero, recount',
  'status.stock.untracked': 'Not counted yet',
  'status.payment.paid': 'Paid',
  'status.payment.part': 'Part paid',
  'status.payment.unpaid': 'Not paid',
  'status.payment.refunded': 'Refunded',
  'status.batch.active': 'Active',
  'status.batch.finished': 'Finished',
  'status.batch.recalled': 'Recalled',
  'status.avail.auto': 'Automatic',
  'status.avail.in': 'Always available',
  'status.avail.out': 'Sold out (by hand)',
  'status.source.cart': 'Website cart',
  'status.source.product': 'Product page',
  'status.source.gift': 'Gift box',
  'status.source.manual': 'Typed in',
  'status.source.pasted': 'Pasted',

  // Today (shell; the real numbers come from src/server/*)
  'today.title': 'Today',
  'today.greeting': 'Good to see you.',
  'today.waiting': 'Waiting for you',
  'today.newOrders': 'New orders',
  'today.toPack': 'To pack or send',
  'today.unpaid': 'Confirmed, not paid',
  'today.toCollect': '{amount} to collect',
  'today.oldest': 'Oldest waited {age}',
  'today.alerts': 'Alerts',
  'today.noAlerts': 'No alerts. Everything looks fine.',
  'today.month': 'This month',
  'today.vsLastMonth': 'This month vs last month',
  'today.sales': 'Sales',
  'today.orders': 'Orders',
  'today.kgSold': 'Honey sold',
  'today.quick': 'Quick buttons',
  'today.newOrder': 'New order',
  'today.pasteOrder': 'Paste WhatsApp order',
  'today.countStock': 'Count stock',
  'today.addHarvest': 'Add harvest',
  'today.updateWebsite': 'Update website now',
  'today.updateConfirm': 'Update the website now? It takes about 2–5 minutes and the site stays online.',
  'today.placeholder': 'Numbers appear here once orders are connected.',
} as const satisfies Record<string, string>;

export type StringKey = keyof typeof EN;

/** Tamil labels go here later (amendment A5: not translated now). Missing keys fall back to English. */
export const TA: Partial<Record<StringKey, string>> = {};

const TABLES: Record<Lang, Partial<Record<string, string>>> = { en: EN, ta: TA };

/** Fills {name} placeholders. Unknown placeholders stay as they are. */
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
}

/** The words for a key, in the chosen language (English fallback), with placeholders filled. */
export function t(key: StringKey, vars?: Vars, lang: Lang = 'en'): string {
  const text = TABLES[lang]?.[key] ?? EN[key] ?? key;
  return interpolate(text, vars);
}

/** True when `key` is a core string key (used to whitelist ?flash= keys). */
export function isStringKey(key: string): key is StringKey {
  return Object.prototype.hasOwnProperty.call(EN, key);
}

/**
 * Words for one screen, kept in its own file (src/admin/strings/<area>.ts):
 *
 *   export const S = defineStrings({ 'orders.title': 'Orders', 'orders.empty': 'No orders yet.' });
 *   S.t('orders.title'); S.t('common.save');   // area keys and core keys both work
 *
 * Area keys must not repeat a core key (a test-friendly error is thrown at import time).
 */
export function defineStrings<T extends Record<string, string>>(en: T, ta: Partial<Record<keyof T, string>> = {}) {
  for (const k of Object.keys(en)) {
    if (isStringKey(k)) throw new Error(`defineStrings: "${k}" is already a core key in src/admin/strings.ts`);
  }
  type Key = Extract<keyof T, string> | StringKey;
  return {
    en,
    ta,
    t(key: Key, vars?: Vars, lang: Lang = 'en'): string {
      if (Object.prototype.hasOwnProperty.call(en, key)) {
        const text = (lang === 'ta' ? (ta as Record<string, string | undefined>)[key] : undefined) ?? en[key as keyof T];
        return interpolate(String(text), vars);
      }
      return t(key as StringKey, vars, lang);
    },
  };
}

/** Keys the browser scripts need (sent to the page as JSON by AdminLayout). */
export const CLIENT_KEYS = [
  'chip.unknown', 'chip.upToDate', 'chip.upToDateShort', 'chip.updating', 'chip.updatingShort', 'chip.waiting',
  'chip.waitingShort', 'chip.failed', 'chip.off', 'chip.offShort',
  'session.expired', 'session.expiredHint', 'session.back',
  'draft.found', 'draft.restore', 'draft.discard', 'draft.restored', 'draft.changedSince',
  'confirm.title', 'confirm.ok', 'confirm.cancel',
  'common.saving', 'common.dismiss',
  'weight.equals', 'weight.jars', 'weight.or', 'weight.g',
] as const satisfies readonly StringKey[];

export type ClientKey = (typeof CLIENT_KEYS)[number];

export function clientStrings(lang: Lang = 'en'): Record<ClientKey, string> {
  return Object.fromEntries(CLIENT_KEYS.map((k) => [k, t(k, undefined, lang)])) as Record<ClientKey, string>;
}
