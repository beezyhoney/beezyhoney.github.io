// Default values of every D1 `settings` key. Plain JavaScript on purpose: scripts/make-seed.mjs (Node) seeds
// them into db/seed.sql, and src/server/settings.ts (Worker) falls back to them when a row is missing.
// The public ones (show_prices, stock_display, delivery_note, offer, gift) must equal the `settings` of
// src/data/catalog.snapshot.json (a unit test checks this). No personal data here: the business details are the
// ones the public site already shows (src/data/site.ts).

/** @type {Readonly<Record<string, unknown>>} */
export const SETTINGS_DEFAULTS = Object.freeze({
  // ── public, served by /api/live.json and baked by the build (catalog `settings`) ──
  show_prices: false,
  stock_display: 'sold_out',
  delivery_note: 'Delivery charges are confirmed on WhatsApp.',
  offer: null,                                  // { text, href, until } | null
  gift: { feePaise: 0, extras: { 'Beeswax candle': null, 'Honey sticks': null }, bulkFrom: 20 },

  // ── private ──
  order_intake: { enabled: true, perIpHour: 20, perDay: 300 },
  alerts: {
    newWaitingHours: 24,                        // Today: "New waiting over 24 h"
    unansweredDays: 14,                         // gift / bulk requests without a reply
    backupStaleDays: 2,                         // Today: "Last backup is older than 2 days"
    bestBeforeWarnDays: 60,                     // batch best-before alert window
    lowDefault: { g: 2000, piece: 5 },          // low-stock level for new pools (grams / pieces)
  },
  business: {
    name: 'Abinash Honey Farming',
    packerAddress: null,
    customerCare: '+91 63832 71931',
    fssai: '22425032000995',
    gstin: null,
  },
  privacy: { clearCustomerAfterMonths: 24 },
  go_live_at: null,                             // set at cutover; "Clear test data" only works before it

  // ── counters (never edited through the settings form) ──
  site_version: 1,                              // bumped by owner saves that need a rebuild
  live_version: 1,                              // bumped by changes /api/live.json serves without a rebuild
  published_version: 0,                         // site_version of the last build seen live
  publish_due_at: null,                         // debounced automatic publish (stock status changes)
});

/** Keys whose change reaches /api/live.json at once (bump live_version) */
export const LIVE_KEYS = Object.freeze(['show_prices', 'stock_display', 'delivery_note', 'offer']);
/** Keys baked into the build through the catalog (bump site_version and publish) */
export const SITE_KEYS = Object.freeze(['show_prices', 'stock_display', 'delivery_note', 'offer', 'gift']);
/** Keys the settings form may change (everything except the counters) */
export const EDITABLE_KEYS = Object.freeze(['show_prices', 'stock_display', 'delivery_note', 'offer', 'gift',
  'order_intake', 'alerts', 'business', 'privacy', 'go_live_at']);
/** Counter keys, changed only by the server */
export const COUNTER_KEYS = Object.freeze(['site_version', 'live_version', 'published_version', 'publish_due_at']);
