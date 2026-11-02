# Beezy Honey website

Static site for Beezy Honey (Abinash Honey Farming), built with [Astro](https://astro.build), GSAP and Lenis, hosted on GitHub Pages. Orders go through WhatsApp; there are no prices on the site.

## Run locally

```bash
npm install
npm run dev      # http://localhost:4321/
npm run build    # outputs dist/
```

## Where things live

- `src/data/products.ts`: all 11 products (text, pack sizes, photos, colour grade). The shop, product pages and home carousel are built from this file.
- `src/data/site.ts`: phone, WhatsApp number, Instagram, FSSAI number and the pre-filled WhatsApp messages.
- `src/assets/img/`: photos. Astro resizes them to WebP at build time. Reference a photo in `products.ts` by its file name.
- `src/pages/`: one file per page; `shop/[slug].astro` makes the product pages.
- `src/scripts/`: smooth scroll and reveal animations (`motion.ts`), the order cart (`cart.ts`), menu/cart/page-transition wiring (`site.ts`).

## Deploy

Live at https://beezyhoney.github.io/ (repository `beezyhoney/beezyhoney.github.io`). Every push to `main` builds the site and deploys it through `.github/workflows/deploy.yml`. In the repository settings, Pages → Source must be **GitHub Actions**. The repository must be named `beezyhoney.github.io` in the `beezyhoney` organization, because the site is served from the root (no `base` in `astro.config.mjs`).

For a custom domain: add `public/CNAME` with the domain, set `site` to `https://your-domain` and `base` to `'/'` in `astro.config.mjs`, and update `public/robots.txt`.
