import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Pages organization site: https://beezyhoney.github.io/
// It is served from the root, so there is no `base`. This only works while the repository
// is named `beezyhoney.github.io` inside the `beezyhoney` organization.
// For a custom domain later: add public/CNAME and set `site` to the domain.
export default defineConfig({
  site: 'https://beezyhoney.github.io',
  trailingSlash: 'always',
  compressHTML: true,
  build: { format: 'directory' },
  integrations: [sitemap()],
});
