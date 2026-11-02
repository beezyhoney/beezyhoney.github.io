// Product content, ported from catalogue/beezy-honey-catalogue.html (English version).

export type CategoryId = 'comb-honey' | 'wild-rare' | 'from-the-hive';

export interface Product {
  slug: string;
  name: string;
  category: CategoryId;
  kind: string;
  badge: string;
  withComb: boolean;
  tagline: string;
  tone: string;
  /** main photo: product hero, home carousel */
  photo: string;
  /** shop card photo (defaults to photo) */
  card?: string;
  /** photo slider on the product page */
  gallery: { src: string; caption: string }[];
  specs: [string, string][];
  /** colour range on the 7-step honey grade scale, if it applies */
  colour?: [number, number];
  about: string;
  love: string[];
  useHead?: string;
  use: string;
  packs: string[];
  store: string;
}

export const CATEGORIES: { id: CategoryId; name: string; title: string; intro: string; image: string }[] = [
  {
    id: 'comb-honey',
    name: 'Comb Honey',
    title: 'Comb Honey',
    intro: 'Single-flower and seasonal honeys, packed with a piece of real honeycomb in every box. Each one tastes of the flowers the bees visited: drumstick blossoms, sunflower fields, mustard in winter bloom, coriander, or a whole season of wildflowers.',
    image: 'cat-comb.jpg',
  },
  {
    id: 'wild-rare',
    name: 'Wild & Rare',
    title: 'Wild & Rare',
    intro: 'Honey from bees nobody keeps and flowers nobody plants: the stingless dammar bee that stores honey in tiny resin pots, the dwarf honey bee that hangs a single comb from a wild branch, and the Neela Kurinji hills of the Western Ghats. Harvests are small and seasonal.',
    image: 'cat-wild.jpg',
  },
  {
    id: 'from-the-hive',
    name: 'From the Hive',
    title: 'From the Hive',
    intro: 'Pure beeswax candles that burn clean with a soft honey scent, and 10 g honey sticks for tea, tiffin boxes, travel and return gifts.',
    image: 'honey-sticks-box.jpg',
  },
];

export const GRADES: [string, string][] = [
  ['Water white', '#F6F0D2'], ['Extra white', '#F1E3A0'], ['White', '#EACF73'], ['Extra light amber', '#E2B347'],
  ['Light amber', '#D4952A'], ['Amber', '#B46A16'], ['Dark amber', '#6B3A10'],
];

const JAR = ['100 g', '250 g', '500 g'];
const COMB = 'With honeycomb';
const HONEY_STORE = 'Store at room temperature with the lid closed. Always use a dry spoon.';
const COMB_LOVE = 'Real honeycomb in the box: raw and edible';

export const PRODUCTS: Product[] = [
  {
    slug: 'murungai-honey', name: 'Murungai Honey', category: 'comb-honey', kind: 'Monofloral', badge: COMB, withComb: true,
    tagline: 'Gathered from the blossoms of the drumstick tree.',
    tone: '#EEF0D6', photo: 'murungai-main.jpg',
    gallery: [
      { src: 'murungai-box.jpg', caption: 'Beezy moringa honey comb, as packed' },
      { src: 'moringa-hex-shelf.jpg', caption: 'Moringa honey comb on our hexagon shelf' },
      { src: 'murungai-honey-bowl.jpg', caption: 'Golden moringa honey, fresh comb and drumstick blossoms' },
      { src: 'moringa-box-dark.jpg', caption: 'Moringa comb sealed in a clear box' },
      { src: 'murungai-pods.jpg', caption: 'Drumstick pods, seeds and flowers' },
    ],
    specs: [['Source', 'Drumstick tree flowers'], ['Colour', 'Amber'], ['Taste', 'Mild, lightly herbal'], ['Texture', 'Thick and smooth']],
    colour: [4, 5],
    about: 'Murungai honey is gathered by bees from the small cream-white flowers of the drumstick tree, found in almost every Tamil home garden. It is amber in colour, with a mild sweetness and a light herbal note. Moringa blooms only in certain seasons, so this single-flower honey comes in limited batches, with a piece of raw honeycomb in every box.',
    love: ['Single-flower honey from moringa blossoms', 'Mild taste the whole family enjoys', 'A natural source of quick energy', COMB_LOVE],
    use: 'Stir a spoonful into warm water in the morning, drizzle over dosa or chapati, or add to herbal kashayam once it has cooled a little.',
    packs: JAR, store: HONEY_STORE,
  },
  {
    slug: 'multifloral-honey', name: 'Multifloral Honey', category: 'comb-honey', kind: 'Multifloral', badge: COMB, withComb: true,
    tagline: 'A taste of every flower in the season.',
    tone: '#F7E3E6', photo: 'multifloral-main.jpg',
    gallery: [
      { src: 'multifloral-jar-hands.jpg', caption: 'A big jar of Beezy multifloral honey' },
      { src: 'bulk-jars.jpg', caption: 'Multifloral honey jars, fresh from the farm' },
      { src: 'cover-jar.jpg', caption: 'Raw, real and unpasteurised' },
      { src: 'multifloral-field.jpg', caption: 'A season of wildflowers' },
    ],
    specs: [['Source', 'Wildflowers, fruit trees, crops'], ['Colour', 'Light amber to amber'], ['Taste', 'Balanced and floral'], ['Texture', 'Smooth and flowing']],
    colour: [4, 5],
    about: 'Multifloral honey is made when bees visit many kinds of flowers in the same season: wildflowers, fruit trees and field crops. No two harvests taste exactly alike, and that is part of its charm. It has a balanced sweetness and a pleasant floral aroma, which makes it the everyday honey for the whole family.',
    love: ['Nectar from many flowers in one box', 'Everyday honey for the whole family', 'Use it in place of sugar in drinks and sweets', COMB_LOVE],
    use: 'Add to tea, lemon juice and milkshakes, spread on bread, or pour over a bowl of fruit.',
    packs: JAR, store: HONEY_STORE,
  },
  {
    slug: 'forest-honey', name: 'Forest Honey', category: 'comb-honey', kind: 'Wild harvest', badge: COMB, withComb: true,
    tagline: 'Wild honey from deep forest hives.',
    tone: '#DCE7E0', photo: 'forest-main.jpg',
    gallery: [
      { src: 'forest-comb.jpg', caption: 'Our forest honey comb, packed as it comes from the hive' },
      { src: 'gen-forest-wild-comb.jpg', caption: 'A wild rock bee comb high in the forest canopy' },
      { src: 'gen-forest-comb-drip.jpg', caption: 'Dark forest honey dripping from wild comb' },
      { src: 'forest-canopy.jpg', caption: 'Deep forest, home of the wild rock bee' },
    ],
    specs: [['Source', 'Wild forest trees and flowers'], ['Colour', 'Amber to dark amber'], ['Taste', 'Bold, rich, slightly woody'], ['Texture', 'Thick']],
    colour: [5, 6],
    about: 'Forest honey comes from wild hives that bees build high in trees and on rock faces deep inside the forest, most often by the giant rock bee. The nectar comes from countless wild trees and flowers that no farm can grow. The result is a dark, thick honey with a bold, rich flavour and a slightly woody finish, harvested by hand in small batches.',
    love: ['Nectar from wild, uncultivated forest', 'Strong, full-bodied taste for honey lovers', 'Hand-harvested in small batches', 'Wild honeycomb in every box'],
    use: 'Best straight from the spoon, or stirred into warm water with ginger and pepper on cold days.',
    packs: JAR, store: HONEY_STORE,
  },
  {
    slug: 'sunflower-honey', name: 'Sunflower Honey', category: 'comb-honey', kind: 'Monofloral', badge: COMB, withComb: true,
    tagline: 'Bright gold, from fields of sunflowers.',
    tone: '#D3E5EF', photo: 'sunflower-main.jpg',
    gallery: [
      { src: 'sunflower-box.jpg', caption: 'Beezy sunflower honey comb, as packed' },
      { src: 'gen-sunflower-bee.jpg', caption: 'A honey bee gathering sunflower pollen' },
      { src: 'gen-sunflower-creamed.jpg', caption: 'Sunflower honey sets soft and creamy' },
      { src: 'sunflower-field.jpg', caption: 'Sunflower fields in bloom' },
    ],
    specs: [['Source', 'Sunflower fields'], ['Colour', 'Bright golden yellow'], ['Taste', 'Mild, fruity, lightly tangy'], ['Texture', 'Sets soft and creamy']],
    colour: [3, 4],
    about: 'Sunflower honey is made from the nectar of sunflower fields in full bloom. It has a sunny golden colour, a mild fruity sweetness and a light tang. It crystallises quickly and naturally, often within a few weeks, turning soft and creamy. That is a sign of real, unprocessed honey, not spoilage.',
    love: ['Sunny colour and a light, fruity taste', 'Sets naturally into a spreadable cream', 'Kids love it on bread and chapati', COMB_LOVE],
    use: 'Spread on toast or chapati. To make it runny again, stand the closed box in warm water for 10 to 15 minutes.',
    packs: JAR, store: HONEY_STORE,
  },
  {
    slug: 'mustard-honey', name: 'Mustard Honey', category: 'comb-honey', kind: 'Monofloral', badge: COMB, withComb: true,
    tagline: 'Creamy white honey from yellow mustard fields.',
    tone: '#E6E5F0', photo: 'mustard-honey-jar.jpg',
    gallery: [
      { src: 'mustard-field.jpg', caption: 'Mustard fields in winter bloom' },
      { src: 'gen-mustard-spread.jpg', caption: 'Creamy set mustard honey on toast' },
      { src: 'gen-mustard-bee.jpg', caption: 'A honey bee on mustard flowers' },
      { src: 'mustard-flower.jpg', caption: 'Mustard flowers' },
    ],
    specs: [['Source', 'Mustard fields'], ['Colour', 'Pale gold, sets creamy white'], ['Taste', 'Mild, with a gentle sharp finish'], ['Texture', 'Thick and creamy']],
    colour: [1, 2],
    about: 'Mustard honey comes from the bright yellow mustard fields that bloom across North India in winter. Fresh from the hive it is pale gold, but within days it sets into a thick, creamy, almost white honey that spreads like butter. The taste is mild and smooth, with a faint sharpness at the end from the mustard plant.',
    love: ['Sets into a smooth, spreadable cream', 'Mild taste with a gentle sharp finish', 'No drips: easy for lunch boxes', COMB_LOVE],
    use: 'Spread on bread, dosa or chapati, or stir into warm milk. Setting solid is natural and does not mean the honey has gone bad.',
    packs: JAR, store: HONEY_STORE,
  },
  {
    slug: 'coriander-honey', name: 'Coriander Honey', category: 'comb-honey', kind: 'Monofloral', badge: COMB, withComb: true,
    tagline: 'Aromatic honey with a gentle spice note.',
    tone: '#DCEBE6', photo: 'coriander.jpg',
    gallery: [
      { src: 'coriander.jpg', caption: 'Coriander honey with coriander flowers' },
      { src: 'gen-coriander-bee.jpg', caption: 'A honey bee on coriander blossoms' },
      { src: 'gen-coriander-seeds-honey.jpg', caption: 'Golden honey with coriander seeds' },
      { src: 'coriander-leaves.jpg', caption: 'Fresh coriander leaves' },
    ],
    specs: [['Source', 'Coriander flowers'], ['Colour', 'Golden amber'], ['Taste', 'Aromatic, hints of citrus and spice'], ['Texture', 'Smooth, may set creamy']],
    colour: [4, 5],
    about: 'Coriander honey is made from the tiny white and pale pink flowers of the coriander plant, grown for its seeds in Rajasthan and Madhya Pradesh. It is golden amber, with a warm, aromatic flavour and light notes of citrus and spice. Over time it may set into a soft cream, which is natural for raw honey.',
    love: ['Unique aroma from coriander blossoms', 'Warm, slightly spicy finish', 'Pairs well with herbal tea and lemon', COMB_LOVE],
    use: 'Stir into herbal or green tea once it cools a little, or drizzle over curd and fruit.',
    packs: JAR, store: HONEY_STORE,
  },
  {
    slug: 'native-honey', name: 'Native Honey', category: 'comb-honey', kind: 'Burrow · Native bee', badge: COMB, withComb: true,
    tagline: 'From India’s own native honey bee.',
    tone: '#DDE6EF', photo: 'native-honey-jar.jpg',
    gallery: [
      { src: 'native-honey-jar.jpg', caption: 'Native honey with fresh comb' },
      { src: 'gen-native-tree-hollow.jpg', caption: 'Indian honey bees at a hollow in an old tree' },
      { src: 'gen-native-frame.jpg', caption: 'Lifting a frame of comb from a native bee box' },
      { src: 'native-box.jpg', caption: 'Burrow (native bee) honey comb, as packed' },
      { src: 'native-shelf.jpg', caption: 'Native bee comb in clear boxes' },
    ],
    specs: [['Bee', 'Indian honey bee'], ['Colour', 'Light amber to amber'], ['Taste', 'Fresh, sweet, gentle tang'], ['Texture', 'Light and flowing']],
    colour: [4, 5],
    about: 'Native honey comes from the Indian honey bee, which has lived alongside our farms and villages for generations and nests in hollows and burrows. Native bees forage on local flowers close to the hive, so the honey carries the true taste of the land around it. It is usually lighter in body, with a fresh sweetness and a gentle tang.',
    love: ['From the indigenous Indian honey bee', 'Local flowers, the true taste of the land', 'Supports native bee-keeping', 'Native honeycomb in every box'],
    use: 'An everyday honey: take a spoon in warm water, or use it in place of sugar in drinks and home remedies.',
    packs: JAR, store: HONEY_STORE,
  },
  {
    slug: 'dammar-honey', name: 'Dammar Honey', category: 'wild-rare', kind: 'Stingless bee', badge: 'Rare · Small harvests', withComb: false,
    tagline: 'Tiny bees, rare honey, a tangy taste.',
    tone: '#EEDCC7', photo: 'dammar-main.jpg',
    gallery: [
      { src: 'dammar-pots.jpg', caption: 'Resin honey pots of the stingless bee' },
      { src: 'stingless-apiary.jpg', caption: 'Stingless bee boxes among the coconut palms' },
      { src: 'dammar-entrance.jpg', caption: 'Stingless bees at their resin entrance tube' },
    ],
    specs: [['Bee', 'Stingless dammar bee'], ['Colour', 'Amber to dark brown'], ['Taste', 'Sweet-sour and tangy'], ['Texture', 'Thin and runny']],
    colour: [4, 6],
    about: 'Dammar honey is made by tiny stingless bees that store their honey in small pots of wax and plant resin instead of combs. A single colony gives only a few hundred grams a year, which makes it one of the rarest honeys in India. It is thin and runny, with a distinct sweet-sour taste and a resin aroma that comes from the hive itself.',
    love: ['From stingless dammar bees', 'Very small harvests: a truly rare honey', 'Distinct sweet-sour taste and resin aroma', 'Prized in traditional home remedies'],
    use: 'Take half to one teaspoon at a time, on its own or in lukewarm water.',
    packs: JAR, store: 'Close tightly and keep in a cool place. Refrigerate after opening to keep it fresh longer.',
  },
  {
    slug: 'kombu-honey', name: 'Kombu Honey', category: 'wild-rare', kind: 'Wild · Dwarf honey bee', badge: 'Wild harvest', withComb: false,
    tagline: 'From single combs hanging on wild branches.',
    tone: '#E8E0D0', photo: 'kombu-main.jpg',
    gallery: [
      { src: 'kombu-comb.jpg', caption: 'A dwarf honey bee comb on its branch' },
      { src: 'gen-kombu-bush.jpg', caption: 'A dwarf honey bee comb hanging in dry scrubland' },
      { src: 'gen-kombu-closeup.jpg', caption: 'Tiny dwarf bees on their single comb' },
      { src: 'kombu-detail.jpg', caption: 'Close-up of the wild comb' },
    ],
    specs: [['Bee', 'Dwarf honey bee'], ['Colour', 'Light amber to amber'], ['Taste', 'Rich wildflower taste'], ['Harvest', 'Small, seasonal, wild']],
    colour: [4, 5],
    about: 'Kombu honey is a wild honey made by the dwarf honey bee, the smallest honey bee in India. These bees build a single palm-sized comb that hangs from a thin branch (kombu) in bushes and small trees. Each comb holds only a little honey, so it is collected from the wild in very small quantities. It has a rich, distinct wildflower taste.',
    love: ['From the wild dwarf honey bee', 'Collected from single combs in the wild', 'Small, seasonal harvests', 'A traditional favourite in Tamil homes'],
    use: 'Take a spoonful on its own, or mix with warm water in the morning.',
    packs: JAR, store: HONEY_STORE,
  },
  {
    slug: 'neela-kurinji-honey', name: 'Neela Kurinji Honey', category: 'wild-rare', kind: 'Rare hill bloom', badge: 'Rare · Small batches', withComb: false,
    tagline: 'Honey from the blue hills of the Western Ghats.',
    tone: '#E3E5F2', photo: 'kurinji-main.jpg',
    gallery: [
      { src: 'kurinji-flower.jpg', caption: 'A honey bee visiting kurinji flowers' },
      { src: 'gen-kurinji-hills.jpg', caption: 'Western Ghats hills in Neelakurinji bloom' },
      { src: 'gen-kurinji-bee.jpg', caption: 'A honey bee on Neelakurinji flowers' },
      { src: 'kurinji-main.jpg', caption: 'Beezy Neela Kurinji honey' },
    ],
    specs: [['Source', 'Neelakurinji and hill flowers'], ['Region', 'Western Ghats hills'], ['Taste', 'Delicate and floral'], ['Harvest', 'Rare, very small batches']],
    about: 'Neela Kurinji honey comes from the hills of the Western Ghats, where the Neelakurinji shrub turns whole slopes blue when it flowers. The shrub blooms together only about once every twelve years, so honey from these hills is rare and comes in very small batches. It has a delicate, floral taste that is best enjoyed simply.',
    love: ['Honey from the Neelakurinji hills of the Western Ghats', 'A rare harvest that comes in very small batches', 'Delicate, floral taste', 'A special gift for honey lovers'],
    use: 'Enjoy it straight from the spoon to taste it at its best, or drizzle a little over fruit or curd. Keep it away from heat so the delicate flavour stays.',
    packs: JAR, store: HONEY_STORE,
  },
  {
    slug: 'beeswax-candles', name: 'Beeswax Candles', category: 'from-the-hive', kind: 'From the hive', badge: 'Paraffin-free · Pollution-free', withComb: false,
    tagline: 'Natural light, without the pollution.',
    tone: '#F3E4C6', photo: 'beeswax-candle-honey.jpg',
    gallery: [
      { src: 'beeswax-candle-honey.jpg', caption: 'A pure beeswax candle with comb honey' },
      { src: 'gen-candles-lit.jpg', caption: 'Beeswax candles glowing at dusk' },
      { src: 'gen-beeswax-raw.jpg', caption: 'Raw beeswax, ready to become candles' },
    ],
    specs: [['Material', 'Pure beeswax'], ['Burn', 'Clean, very little smoke'], ['Scent', 'Light natural honey'], ['Best for', 'Pooja, dining, gifting']],
    about: 'Our candles are made from pure beeswax, the natural wax bees make to build their honeycomb. Unlike paraffin candles, which come from petroleum, they burn slowly and cleanly with very little smoke, giving a warm golden glow and a soft honey scent with no added fragrance.',
    love: ['Made from pure beeswax', 'No paraffin, no chemicals', 'Burns longer than ordinary candles', 'Ideal for pooja, dining and gifting'],
    useHead: 'Candle care',
    use: 'Trim the wick to about 5 mm before lighting and keep away from breeze. A white bloom on the surface is natural; wipe it with a soft cloth.',
    packs: ['Small', 'Medium', 'Large'],
    store: 'Never leave a burning candle unattended. Keep away from children and pets.',
  },
  {
    slug: 'honey-sticks', name: 'Honey Sticks', category: 'from-the-hive', kind: 'Single-serve sachets', badge: '10 g per stick', withComb: false,
    tagline: 'One stick, one serving, no mess.',
    tone: '#FBE6C0', photo: 'honey-sticks-box.jpg',
    gallery: [
      { src: 'honey-sticks-box.jpg', caption: 'Beezy honey sticks: box of 10 × 10 g' },
      { src: 'gen-sticks-pouch.jpg', caption: 'Honey sticks for the tiffin box or the road' },
      { src: 'gen-sticks-tea.jpg', caption: 'Squeeze a stick straight into your tea' },
      { src: 'honey-tea.jpg', caption: 'One stick is just right for a cup of tea' },
    ],
    specs: [['Net weight', '10 g per stick'], ['Serving', 'About 1½ teaspoons'], ['Box', '10 sticks (100 g)'], ['Inside', 'Natural honey']],
    about: 'Honey sticks are single-serve sachets with exactly 10 g of honey, about one and a half teaspoons. No spoon, no sticky jar, no spills: tear the top and squeeze. Keep a few in your handbag, school bag, gym kit or travel pouch for a quick natural sweet whenever you need one. They also make a neat return gift for functions.',
    love: ['Exactly 10 g per stick, no measuring', 'Tear, squeeze, enjoy: no spoon needed', 'Right amount for a cup of tea or coffee', 'Easy to carry anywhere'],
    use: 'Squeeze into tea, coffee or lemon water, or take it straight after a workout.',
    packs: ['1 stick', 'Box of 10 (100 g)'],
    store: 'Store in a cool, dry place away from direct sunlight.',
  },
];

export const productName = (p: Product) => p.name + (p.withComb ? ' with comb' : '');
