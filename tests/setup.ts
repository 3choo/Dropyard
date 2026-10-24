import { env } from 'cloudflare:workers';
import schema from '../migrations/0001_init.sql?raw';

// Apply the production schema to the local D1 instance once per test run.
// Setup files execute inside workerd, so the SQL arrives as a bundled import.
// D1's exec groups statements line-wise and a statement must end its line
// with ';': strip every comment and collapse each statement to one line.
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

export {};
