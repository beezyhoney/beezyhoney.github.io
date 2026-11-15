# Beezy Honey website

Static site for Beezy Honey (Abinash Honey Farming), built with [Astro](https://astro.build), GSAP and Lenis, hosted on GitHub Pages. Orders go through WhatsApp; there are no prices on the site.

## Run locally

```bash
npm install
npm run dev      # http://localhost:4321/
npm run build    # outputs dist/ (runs scripts/sync-catalog.mjs first)
npm test         # unit + Worker tests (Vitest)
```

## Where things live

- `src/data/catalog.snapshot.json`: the catalog: all 16 products (text, packs, prices, photos, colour grade, Honey Finder and bloom data), the shop sections, stock pools, website settings and Know Your Jar batches. The format is described field by field in `src/data/catalog.types.ts`. Before every build, `scripts/sync-catalog.mjs` checks it and copies it to `src/data/generated/catalog.json` (not committed), which `src/data/catalog.ts` loads. Later the admin portal's catalog replaces the snapshot as the source.
- `src/data/products.ts`, `features.ts`, `batches.ts`: types and helpers; the data itself comes from the catalog. `src/data/prices.ts` holds the starting prices that seeded the catalog.
- `src/data/site.ts`: phone, WhatsApp number, Instagram, FSSAI number and the pre-filled WhatsApp messages.
- `src/assets/img/`: photos. Astro resizes them to WebP at build time. The catalog names a photo by its path inside this folder.
- `src/pages/`: one file per page; `shop/[slug].astro` makes the product pages.
- `src/scripts/`: smooth scroll and reveal animations (`motion.ts`), the order cart (`cart.ts`), menu/cart/page-transition wiring (`site.ts`).
- `scripts/`: `sync-catalog.mjs` (build step), `zero-diff.mjs <dirA> <dirB>` (proves two builds are the same apart from hashed file names), `dist-stats.mjs` (file counts and JavaScript per page), `make-snapshot.mjs` and `capture-legacy.mjs` (one-off move of the product data into the catalog), `prepare-assets.mjs` (one-off photo preparation: `node scripts/prepare-assets.mjs <full-res photo folder>`).
- `test/`: Vitest unit tests; `test/fixtures/legacy-data.json` is the product data as it was in code, used to prove the catalog reproduces it exactly.

## Admin portal and Cloudflare Worker

The admin portal (orders, stock in kg, harvests and batches, prices, sales, invoices, backups) runs in a Cloudflare
Worker next to the static pages, with D1 and Workers KV. Public pages stay prerendered; only `/api/*`, `/media/*` and
`/admin/*` run in the Worker. Prices stay hidden on the site until the owner switches on **Show prices**.

- `docs/OWNER-GUIDE.md`: how the owner uses the admin, in plain words.
- `docs/RUNBOOK.md`: local development, tests, Cloudflare setup, deploy, cutover and recovery.
- `docs/DEV-NOTES.md`: Worker, middleware, gates and local-state details.
- `src/server/README.md` (server functions) and `src/admin/README.md` (admin screens).

Until the cutover described in the runbook, the live site is still the GitHub Pages build below.

## Deploy

Live at https://beezyhoney.in/ (custom domain; repository `beezyhoney/beezyhoney.github.io`, whose own address https://beezyhoney.github.io/ redirects there). Every push to `main` builds the site and deploys it through `.github/workflows/deploy.yml`. In the repository settings, Pages → Source must be **GitHub Actions**. The repository must be named `beezyhoney.github.io` in the `beezyhoney` organization, because the site is served from the root (no `base` in `astro.config.mjs`).

The domain is set in Settings → Pages → Custom domain, with **Enforce HTTPS** ticked. If it ever changes, also update `site` in `astro.config.mjs` and the sitemap line in `public/robots.txt`.
