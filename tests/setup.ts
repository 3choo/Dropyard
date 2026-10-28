import { env } from 'cloudflare:workers';
import schema1 from '../migrations/0001_init.sql?raw';
import schema2 from '../migrations/0002_extract_jobs.sql?raw';
import schema3 from '../migrations/0003_extract_progress.sql?raw';
import schema4 from '../migrations/0004_git.sql?raw';
import schema5 from '../migrations/0005_collab.sql?raw';

// Apply the production schema to the local D1 instance once per test run.
// Setup files execute inside workerd, so the SQL arrives as a bundled import.
// D1's exec groups statements line-wise and a statement must end its line
// with ';': strip every comment and collapse each statement to one line.
for (const schema of [schema1, schema2, schema3, schema4, schema5]) {
  const sql = schema
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s};`)
    .join('\n');
  await env.DB.exec(sql);
}

export {};
