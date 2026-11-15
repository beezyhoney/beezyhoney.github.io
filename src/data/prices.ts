// Starting prices in Indian rupees, taxes included, per pack.
// Source: the owner's 2026 catalogue price list (sent 15 Nov 2026).
// This only seeds the admin portal. Once the portal is live, prices are changed there, not here.
// null means no price yet; the owner will add it in the admin portal.
// Keys must match product slugs and pack names in products.ts exactly.

export const START_PRICES: Record<string, Record<string, number | null>> = {
  'murungai-honey': { '100 g': 140, '250 g': 310, '500 g': 650 },
  'multifloral-honey': { '100 g': 125, '250 g': 290, '500 g': 599 },
  'forest-honey': { '100 g': 180, '250 g': 399, '500 g': 699 },
  'sunflower-honey': { '100 g': 150, '250 g': 350, '500 g': 650 },
  'mustard-honey': { '100 g': 180, '250 g': 340, '500 g': 699 },
  'coriander-honey': { '100 g': 150, '250 g': 350, '500 g': 650 },
  'native-honey': { '100 g': 150, '250 g': 350, '500 g': 700 },
  'forest-coffee-honey': { '100 g': null, '250 g': null, '500 g': null },
  'karanji-honey': { '100 g': null, '250 g': null, '500 g': null },
  'litchi-honey': { '100 g': null, '250 g': null, '500 g': null },
  'tulasi-honey': { '100 g': null, '250 g': null, '500 g': null },
  'dammar-honey': { '100 g': 400, '250 g': 900, '500 g': 1800 },
  'kombu-honey': { '100 g': 280, '250 g': 450, '500 g': 900 },
  'neela-kurinji-honey': { '100 g': 310, '250 g': 600, '500 g': 1100 },
  'beeswax-candles': { Small: 80, Medium: 120, Large: 180 },
  'honey-sticks': { '1 stick': 7, 'Box of 10 (100 g)': 70 },
};

// Starting stock: the owner said on 15 Nov 2026 that every product is in stock right now, without amounts.
// Stock model the owner asked for: each harvest is entered in kg (e.g. "Murungai, 15 Nov, 100 kg"), and every
// confirmed order takes its weight off that honey (2 x 250 g = 0.5 kg). Candles and honey sticks are counted in pieces.
// Until the owner enters an opening amount in the admin portal, every product shows as available and has no alerts.
export const START_STOCK = { available: true, amount: null } as const;
export const STOCK_UNIT: Record<string, 'kg' | 'pieces'> = { 'beeswax-candles': 'pieces', 'honey-sticks': 'pieces' }; // others: kg
