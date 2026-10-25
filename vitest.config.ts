import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // miniflare 5 betas bind R2 buckets by bucket name; remap to the
      // binding name our Worker expects (BUCKET -> bucket "gitctx").
      miniflare: {
        r2Buckets: { BUCKET: 'gitctx' },
        // Test-only callback secret so container→Worker events can be exercised
        // without touching real dev secrets (.dev.vars stays absent locally).
        bindings: { EXTRACT_CALLBACK_SECRET: 'test-extract-secret' },
      },
    }),
  ],
  test: {
    setupFiles: ['./tests/setup.ts'],
  },
});
