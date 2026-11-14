// Product details the interactive pages need in the browser (quiz, gift box, batch lookup),
// with a small WebP thumbnail made at build time. Rendered into a JSON <script> on the page.
import { getImage } from 'astro:assets';
import { PRODUCTS, productName } from '../data/products';
import { FINDER_PROFILES, BLOOM } from '../data/features';
import { link } from '../data/site';
import { img } from './images';

export interface ClientProduct {
  slug: string; name: string; short: string; kind: string; tagline: string; tone: string;
  href: string; packs: string[]; taste: string; source: string; colour: [number, number] | null;
  honey: boolean; thumb: string; profile: (typeof FINDER_PROFILES)[string] | null; bloom: number[] | 'all' | null;
}

export async function clientProducts(): Promise<ClientProduct[]> {
  return Promise.all(PRODUCTS.map(async (p) => {
    const spec = (k: string) => p.specs.find(([key]) => key === k)?.[1] ?? '';
    return {
      slug: p.slug,
      name: productName(p),
      short: p.name,
      kind: p.kind,
      tagline: p.tagline,
      tone: p.tone,
      href: link(`/shop/${p.slug}/`),
      packs: p.packs,
      taste: spec('Taste'),
      source: spec('Source') || spec('Bee'),
      colour: p.colour ?? null,
      honey: p.category !== 'from-the-hive',
      thumb: (await getImage({ src: img(p.photo), width: 520, format: 'webp' })).src,
      profile: FINDER_PROFILES[p.slug] ?? null,
      bloom: BLOOM[p.slug] ?? null,
    };
  }));
}

/** JSON for a <script type="application/json">, safe against "</script>" inside text */
export const toJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
