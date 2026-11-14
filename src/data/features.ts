// Data for the interactive features: Honey Finder quiz, bloom calendar and gift box builder.
// The batches for "Know your jar" live in batches.ts.

/* ---------- Honey Finder ---------- */
export type Taste = 'mild' | 'floral' | 'rich' | 'herbal';
export type Use = 'daily' | 'kids' | 'remedy' | 'gift' | 'onthego';
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

/** How each honey answers the quiz: first taste and first use count a little more than the rest.
    Colour comes from the product's colour grade. */
export const FINDER_PROFILES: Record<string, { taste: Taste[]; uses: Use[]; rare?: boolean }> = {
  'murungai-honey': { taste: ['mild', 'herbal'], uses: ['daily', 'remedy'] },
  'multifloral-honey': { taste: ['floral', 'mild'], uses: ['daily', 'kids'] },
  'forest-honey': { taste: ['rich'], uses: ['daily', 'remedy'] },
  'sunflower-honey': { taste: ['mild', 'floral'], uses: ['kids', 'daily'] },
  'mustard-honey': { taste: ['mild'], uses: ['kids', 'daily'] },
  'coriander-honey': { taste: ['herbal', 'floral'], uses: ['daily', 'remedy'] },
  'native-honey': { taste: ['mild'], uses: ['remedy', 'daily'] },
  'forest-coffee-honey': { taste: ['rich', 'floral'], uses: ['daily', 'kids'] },
  'karanji-honey': { taste: ['rich', 'herbal'], uses: ['remedy', 'daily'] },
  'litchi-honey': { taste: ['floral', 'mild'], uses: ['kids', 'daily'] },
  'tulasi-honey': { taste: ['herbal'], uses: ['remedy', 'daily'] },
  'dammar-honey': { taste: ['herbal'], uses: ['remedy'], rare: true },
  'kombu-honey': { taste: ['rich'], uses: ['remedy', 'daily'], rare: true },
  'neela-kurinji-honey': { taste: ['floral'], uses: ['gift', 'daily'], rare: true },
};

/* ---------- Bloom calendar ----------
   Months are 1–12. 'all' = flowers through most of the year.
   These are the usual flowering seasons; change them here if your harvests differ. */
export const BLOOM: Record<string, number[] | 'all'> = {
  'murungai-honey': [1, 2, 3, 4],
  'multifloral-honey': 'all',
  'forest-honey': [3, 4, 5, 6],
  'sunflower-honey': [1, 2, 3],
  'mustard-honey': [12, 1, 2],
  'coriander-honey': [1, 2, 3],
  'native-honey': 'all',
  'forest-coffee-honey': [2, 3, 4],
  'karanji-honey': [3, 4, 5],
  'litchi-honey': [2, 3],
  'tulasi-honey': 'all',
  'dammar-honey': 'all',
  'kombu-honey': [2, 3, 4, 5],
  'neela-kurinji-honey': [8, 9, 10],
};
/** Honeys whose bloom is not every year (shown on the calendar, never marked "in bloom now") */
export const BLOOM_NOTE: Record<string, string> = {
  'neela-kurinji-honey': 'Blooms together only about once every twelve years',
};
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
