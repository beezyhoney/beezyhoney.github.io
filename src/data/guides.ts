// The Guides section (/guides/): plain-English articles that answer what people search for.
// Each guide's text lives in src/pages/guides/<slug>.astro; this list holds what the index, the article header,
// the SEO tags, the structured data and the "More guides" links need. Order = order on the index page.
//
// House rules for guide text: English only; warm, plain and honest; no health or cure claims and no disease names;
// no place names and no personal names. Link only to pages on this site.
import { PRODUCT_PAGES } from './products';
import { link } from './site';

export interface Guide {
  /** URL part: /guides/<slug>/ (must match the file name in src/pages/guides/) */
  slug: string;
  /** <title> text; the layout adds " | Beezy Honey" */
  title: string;
  /** the page's one H1 */
  h1: string;
  /** short name for the breadcrumb */
  short: string;
  /** meta description (about 120–160 characters) */
  description: string;
  /** one or two sentences under the H1 and on the index card */
  dek: string;
  eyebrow: string;
  /** main photo, a file in src/assets/img */
  image: string;
  alt: string;
  /** CSS object-position for the main photo */
  position?: string;
  /** ISO dates (YYYY-MM-DD) */
  published: string;
  updated: string;
  /** product slugs suggested at the end of the guide (skipped when the product has no page) */
  products: string[];
}

export const GUIDES: Guide[] = [
  {
    slug: 'murungai-moringa-honey',
    title: 'Murungai (Moringa) Honey: Taste, Colour and Uses',
    h1: 'Murungai honey: taste, colour and uses',
    short: 'Murungai honey',
    description: 'What murungai (moringa) honey tastes like, its colour and texture, easy ways to use it, and how this single-flower honey differs from multifloral honey.',
    dek: 'What honey from drumstick tree blossoms tastes like, how to enjoy it, and how it differs from everyday multifloral honey.',
    eyebrow: 'Single-flower honey',
    image: 'murungai-honey-bowl.jpg',
    alt: 'A bowl of golden murungai honey beside drumstick tree blossoms, with a honey bee in flight',
    position: '50% 55%',
    published: '2026-11-16',
    updated: '2026-11-16',
    products: ['murungai-honey', 'multifloral-honey'],
  },
  {
    slug: 'how-to-check-pure-honey',
    title: 'How to Check if Honey Is Pure at Home',
    h1: 'How to tell if honey is pure at home',
    short: 'Is my honey pure?',
    description: 'Water, thumb, fire and paper tests cannot prove honey is pure. Learn why, why crystallised honey is normal, and what to check on the label instead.',
    dek: 'The water, thumb, fire and paper tests are everywhere. Here is why they cannot settle the question, and what actually helps.',
    eyebrow: 'Buying honey',
    image: 'bulk-jars.jpg',
    alt: 'A stack of Beezy multifloral honey jars on a wooden stand in the garden',
    position: '50% 45%',
    published: '2026-11-16',
    updated: '2026-11-16',
    products: ['multifloral-honey', 'murungai-honey'],
  },
  {
    slug: 'honey-with-comb',
    title: 'Honey with Comb: How to Eat and Store Comb Honey',
    h1: 'Honey with comb: how to eat it and store it',
    short: 'Honey with comb',
    description: 'What comb honey is, how to cut and eat it, why the beeswax is edible, and how to store honey with comb at home so it keeps its taste and texture.',
    dek: 'What comb honey is, how to cut it and eat it, why the beeswax is edible, and how to keep it at its best.',
    eyebrow: 'Comb honey',
    image: 'cat-comb.jpg',
    alt: 'Golden honeycomb packed in a clear box, seen from the side',
    position: '50% 50%',
    published: '2026-11-16',
    updated: '2026-11-16',
    products: ['murungai-honey', 'forest-honey', 'multifloral-honey'],
  },
  {
    slug: 'neela-kurinji-honey',
    title: 'Neela Kurinji Honey: The Rare 12-Year Bloom',
    h1: 'Neela Kurinji honey and the twelve-year bloom',
    short: 'Neela Kurinji honey',
    description: 'Neelakurinji flowers together only about once every twelve years. What that means for Neela Kurinji honey, why it is rare and what it tastes like.',
    dek: 'Why a shrub that flowers together only about once every twelve years gives one of the rarest honeys, and what to expect from a jar.',
    eyebrow: 'Wild & rare',
    image: 'kurinji-flower.jpg',
    alt: 'A honey bee flying towards blue-violet kurinji flowers',
    position: '60% 45%',
    published: '2026-11-16',
    updated: '2026-11-16',
    products: ['neela-kurinji-honey', 'multifloral-honey'],
  },
];

if (new Set(GUIDES.map((g) => g.slug)).size !== GUIDES.length) throw new Error('src/data/guides.ts: two guides share a slug');

/** Address of a guide page */
export const guideHref = (slug: string) => link(`/guides/${slug}/`);

/** Link to a product page, or to the shop when that product has no page (paused or retired products may come and go) */
export const productHref = (slug: string) => link(PRODUCT_PAGES.some((p) => p.slug === slug) ? `/shop/${slug}/` : '/shop/');

/** "16 November 2026" from an ISO date, without depending on the build machine's time zone */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d} ${months[m - 1]} ${y}`;
}
