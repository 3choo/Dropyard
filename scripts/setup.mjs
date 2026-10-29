// Interactive setup: creates storage + database, writes wrangler.local.jsonc,
// stores secrets, applies CORS and migrations.   npm run setup
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;
const run = (args, input) =>
  spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    input,
    stdio: input === undefined ? ['inherit', 'pipe', 'inherit'] : ['pipe', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });

const OUT = 'wrangler.local.jsonc';
console.log('dropyard setup — requires `npx wrangler login` to have been run.\n');

const backend = (await ask('Storage backend: r2 (Cloudflare R2) or s3 (AWS S3, MinIO, Backblaze, ...)', 'r2')).toLowerCase();
const isS3 = backend === 's3';
const bucket = await ask('Bucket name', 'dropyard');
const dbName = await ask('D1 database name', 'dropyard');

let cfg = readFileSync('wrangler.jsonc', 'utf8');
const setVar = (name, value) => {
  const re = new RegExp(`("${name}"\\s*:\\s*)"[^"]*"`);
  cfg = re.test(cfg) ? cfg.replace(re, `$1${JSON.stringify(value)}`) : cfg.replace(/"vars"\s*:\s*\{/, `$&\n    ${JSON.stringify(name)}: ${JSON.stringify(value)},`);
};

console.log('\nCreating D1 database...');
const db = run(['d1', 'create', dbName]);
const id = /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/.exec(db.stdout ?? '')?.[1];
if (!id) {
  console.error(db.stdout);
  console.error('Could not read the database id. If the database already exists, run `npx wrangler d1 list` and paste its id below.');
}
const dbId = id ?? (await ask('D1 database id'));
cfg = cfg.replace(/"database_name"\s*:\s*"[^"]*"/, `"database_name": "${dbName}"`).replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${dbId}"`);

const secrets = {};
if (isS3) {
  setVar('STORAGE_BACKEND', 's3');
  setVar('S3_ENDPOINT', await ask('S3 endpoint URL (e.g. https://s3.eu-central-1.amazonaws.com or https://minio.example.com)'));
  setVar('S3_REGION', await ask('Region', 'us-east-1'));
  setVar('S3_BUCKET', bucket);
  setVar('S3_FORCE_PATH_STYLE', (await ask('Path-style URLs (needed for MinIO, optional for AWS)', 'y')).toLowerCase().startsWith('y') ? 'true' : 'false');
  cfg = cfg.replace(/\s*"r2_buckets"\s*:\s*\[[^\]]*\],?/, '');
  secrets.S3_ACCESS_KEY_ID = await ask('Access key id');
  secrets.S3_SECRET_ACCESS_KEY = await ask('Secret access key');
} else {
  console.log('\nCreating R2 bucket...');
  run(['r2', 'bucket', 'create', bucket]);
  cfg = cfg.replace(/"bucket_name"\s*:\s*"[^"]*"/, `"bucket_name": "${bucket}"`);
  setVar('R2_BUCKET_NAME', bucket);
  setVar('R2_S3_ACCOUNT_ID', await ask('Cloudflare account id (dashboard → R2 → Overview)'));
  console.log('\nCreate an R2 API token (Object Read & Write, scoped to the bucket): dashboard → R2 → Manage API tokens.');
  secrets.R2_ACCESS_KEY_ID = await ask('Access key id');
  secrets.R2_SECRET_ACCESS_KEY = await ask('Secret access key');
}
secrets.EXTRACT_CALLBACK_SECRET = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
try {
  writeFileSync(OUT, cfg, { flag: 'wx' });
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  if ((await ask(`${OUT} exists. Overwrite?`, 'n')).toLowerCase() !== 'y') {
    console.log('Keeping existing config. Delete it to start over.');
    process.exit(0);
  }
  writeFileSync(OUT, cfg);
}
console.log(`\nWrote ${OUT} (gitignored).`);

const origins = (await ask('Browser origins allowed to upload directly to storage, comma separated (your workers.dev URL or custom domain)', 'http://localhost:5173')).split(',').map((s) => s.trim()).filter(Boolean);
const cors = { rules: [{ allowed: { origins, methods: ['GET', 'PUT', 'HEAD'], headers: ['x-amz-checksum-sha256', 'content-type'] }, exposeHeaders: ['ETag', 'x-amz-checksum-sha256', 'x-amz-version-id'], maxAgeSeconds: 3600 }] };
writeFileSync('r2-cors.local.json', JSON.stringify(cors, null, 2));

console.log('\nStoring secrets...');
for (const [name, value] of Object.entries(secrets)) {
  const r = run(['secret', 'put', name, '-c', OUT], value);
  if (r.status !== 0) console.error(`Failed to set ${name}; run: npx wrangler secret put ${name} -c ${OUT}`);
}

if (isS3) {
  console.log(`\nApply this CORS policy to the bucket yourself (provider specific; AWS example: aws s3api put-bucket-cors):\n${JSON.stringify({ CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }] }, null, 2)}`);
} else {
  run(['r2', 'bucket', 'cors', 'put', bucket, '--file', 'r2-cors.local.json', '-c', OUT]);
}

console.log('\nApplying database migrations...');
run(['d1', 'migrations', 'apply', dbName, '--remote', '-c', OUT]);
console.log('\nDone. Run `npm run deploy`, open the printed URL and create the first admin account.');
rl.close();
