# Beezy Honey website

Website and admin portal for Beezy Honey (Abinash Honey Farming), built with [Astro](https://astro.build), GSAP and Lenis, running on a Cloudflare Worker (static pages + D1 + Workers KV). Prices are shown on the site; orders go through WhatsApp and are recorded with a BZ- order code.

## Run locally

```bash
npm install
npm run dev      # http://localhost:4321/
npm run build    # outputs dist/ (runs scripts/sync-catalog.mjs first)
npm test         # unit + Worker tests (Vitest)
```

## Where things live

- `src/data/catalog.snapshot.json`: the catalog: all 16 products (text, packs, prices, photos, colour grade, Honey Finder and bloom data), the shop sections, stock pools, website settings and Know Your Jar batches. The format is described field by field in `src/data/catalog.types.ts`. Before every build, `scripts/sync-catalog.mjs` checks it and copies it to `src/data/generated/catalog.json` (not committed), which `src/data/catalog.ts` loads. Production builds read the live catalog from the admin portal instead (CATALOG_URL), so the snapshot is only the fallback and the local default.
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
`/admin/*` run in the Worker. The owner switches prices on or off with **Show prices** (on since 16 Nov 2026).

- `docs/OWNER-GUIDE.md`: how the owner uses the admin, in plain words.
- `docs/RUNBOOK.md`: local development, tests, Cloudflare setup, deploy, cutover and recovery.
- `docs/DEV-NOTES.md`: Worker, middleware, gates and local-state details.
- `src/server/README.md` (server functions) and `src/admin/README.md` (admin screens).

## Deploy

Live at https://beezyhoney.in/ (also www., which redirects to it), with the admin at https://admin.beezyhoney.in/. Since 16 Nov 2026 the
Cloudflare Worker `beezyhoney` serves everything; the domains are Worker custom domains listed in `wrangler.jsonc`.

- Cloudflare Workers Builds builds and deploys every push to `main` (`npm run build`, then `npm run deploy`).
- Saving in the admin rebuilds the site through a deploy hook (secret `DEPLOY_HOOK_URL`). Price changes show within about a minute, with no rebuild.
- Secrets live only in Cloudflare: `ADMIN_EMAILS`, `ADMIN_ALIASES`, `LOGIN_SECRET`, `IP_HASH_KEY` and `DEPLOY_HOOK_URL`. This repository is public, so never commit them.
- To roll back, go to Cloudflare → Workers & Pages → beezyhoney → Deployments → Rollback. `docs/RUNBOOK.md` has the full steps, including going back to GitHub Pages.

The old GitHub Pages workflow (`.github/workflows/deploy.yml`) and `CNAME` are kept as a fallback for the first two weeks only. They can be removed after 30 Nov 2026.
