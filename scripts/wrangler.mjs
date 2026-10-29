// Runs wrangler against wrangler.local.jsonc (written by `npm run setup`) when
// it exists, otherwise against the committed wrangler.jsonc.
//   node scripts/wrangler.mjs deploy
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CONFIG = existsSync('wrangler.local.jsonc') ? 'wrangler.local.jsonc' : 'wrangler.jsonc';

function wrangler(args, options = {}) {
  return spawnSync('npx', ['wrangler', ...args, '-c', CONFIG], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
}

const result = wrangler(process.argv.slice(2));
process.exit(result.status ?? 1);
