import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Live at the custom domain https://beezyhoney.in (set in the repository's Pages settings),
// deployed from the `beezyhoney/beezyhoney.github.io` repository. Served from the root, so no `base`.
// `site` makes the canonical links, social previews and sitemap use the real address.
export default defineConfig({
  site: 'https://beezyhoney.in',
  trailingSlash: 'always',
  compressHTML: true,
  build: { format: 'directory' },
  integrations: [sitemap()],
});
