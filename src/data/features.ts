// Data for the interactive features: Honey Finder quiz, bloom calendar and gift box builder.
// Each honey's quiz profile and flowering months come from the catalog (see catalog.ts);
// the questions, month names and gift box choices stay here. The batches for "Know your jar" are in batches.ts.

export { FINDER_PROFILES, BLOOM, BLOOM_NOTE } from './catalog';

/* ---------- Honey Finder ---------- */
export type { Taste, Use } from './catalog.types';
export type Shade = 'light' | 'amber' | 'dark' | 'any';
export type Rarity = 'everyday' | 'rare';

export const FINDER_QUESTIONS = [
  {
    id: 'taste', title: 'How do you like your honey?',
    options: [
      { value: 'mild', label: 'Mild & gentle', hint: 'Soft sweetness for every day' },
      { value: 'floral', label: 'Floral & fruity', hint: 'Light, fragrant, a little fruity' },
      { value: 'rich', label: 'Rich & bold', hint: 'Deep, full and caramel-like' },
      { value: 'herbal', label: 'Herbal & tangy', hint: 'A spiced, herbal or tangy edge' },
    ],
  },
  {
    id: 'use', title: 'What will you use it for?',
    options: [
      { value: 'daily', label: 'Tea & a daily spoon', hint: 'Tea, lemon water, warm water' },
      { value: 'kids', label: 'Breakfast & desserts', hint: 'Bread, dosa, curd, fruit' },
      { value: 'remedy', label: 'Home remedies', hint: 'Kashayam, ginger and lemon' },
      { value: 'gift', label: 'A gift', hint: 'For family, friends or guests' },
      { value: 'onthego', label: 'On the go', hint: 'Travel, gym, tiffin box' },
    ],
  },
  {
    id: 'shade', title: 'Light or dark?',
    options: [
      { value: 'light', label: 'Light & golden', hint: 'Pale gold to light amber' },
      { value: 'amber', label: 'Amber', hint: 'The classic honey colour' },
      { value: 'dark', label: 'Dark & deep', hint: 'Amber to dark amber' },
      { value: 'any', label: 'Surprise me', hint: 'Colour doesn’t matter' },
    ],
  },
  {
    id: 'rarity', title: 'Everyday or something special?',
    options: [
      { value: 'everyday', label: 'An everyday honey', hint: 'For the kitchen shelf' },
      { value: 'rare', label: 'Something rare', hint: 'Small, special harvests' },
    ],
  },
] as const;

/* How each honey answers the quiz (FINDER_PROFILES): first taste and first use count a little more than the rest.
   Colour comes from the product's colour grade. The profiles are part of each product in the catalog. */

/* ---------- Bloom calendar ----------
   BLOOM: months are 1–12, 'all' = flowers through most of the year.
   BLOOM_NOTE: honeys whose bloom is not every year (shown on the calendar, never marked "in bloom now").
   Both are part of each product in the catalog. */
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "January – April", "December – February", "All year" */
export function bloomText(months: number[] | 'all' | undefined): string {
  if (!months) return '';
  if (months === 'all') return 'Most of the year';
  if (months.length === 1) return MONTHS[months[0] - 1];
  return `${MONTHS[months[0] - 1]} – ${MONTHS[months[months.length - 1] - 1]}`;
}

/* ---------- Gift box ---------- */
export const GIFT_SIZES = [2, 3, 4];
export const GIFT_JARS = ['100 g', '250 g'];
export const GIFT_OCCASIONS = ['Wedding return gift', 'Housewarming', 'Birthday', 'Festival', 'Corporate gift', 'Thank you', 'Other'];
export const GIFT_EXTRAS = ['Beeswax candle', 'Honey sticks'];
