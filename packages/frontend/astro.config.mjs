import { defineConfig } from 'astro/config';

// Static output - no SSR adapter needed.
// The built site deploys to Cloudflare Workers with static assets (wrangler.jsonc).
export default defineConfig({
  output: 'static',
});
