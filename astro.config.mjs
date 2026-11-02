import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Pages project site: https://sleostanley.github.io/beezyhoney/
// `base` must match the repository name. For a custom domain later: add public/CNAME,
// set `site` to the domain and `base` to '/'.
export default defineConfig({
  site: 'https://sleostanley.github.io',
  base: '/beezyhoney',
  trailingSlash: 'always',
  compressHTML: true,
  build: { format: 'directory' },
  integrations: [sitemap()],
});
