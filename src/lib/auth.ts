import type { Context } from 'hono';
import { randomToken, sha256Hex, nowMs } from './ids';

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const SESSION_COOKIE = 'gctx_session';

const encoder = new TextEncoder();

export type Role = 'admin' | 'uploader' | 'viewer';
export type SessionUser = { id: string; email: string; name: string; role: Role };

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1]!, 10);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  const salt = fromB64(parts[2]!);
  const expected = fromB64(parts[3]!);
  const actual = await deriveBits(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = nowMs();
  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

export async function resolveSession(db: D1Database, token: string): Promise<SessionUser | null> {
  const id = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.expires_at, u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .bind(id)
    .first<{ expires_at: number; id: string; email: string; name: string; role: Role }>();
  if (!row) return null;
  if (row.expires_at < nowMs()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  const id = await sha256Hex(token);
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function setCookie(c: Context, header: string): void {
  c.header('set-cookie', header, { append: true });
}

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 8;

export async function loginBlocked(db: D1Database, email: string, ip: string): Promise<boolean> {
  const key = await sha256Hex(`${email}|${ip}`);
  const row = await db
    .prepare('SELECT blocked_until FROM login_attempts WHERE key = ?')
    .bind(key)
    .first<{ blocked_until: number }>();
  return !!row?.blocked_until && row.blocked_until > nowMs();
}

export async function recordLoginFailure(db: D1Database, email: string, ip: string): Promise<void> {
  const key = await sha256Hex(`${email}|${ip}`);
  const now = nowMs();
  const row = await db
    .prepare('SELECT count, window_start FROM login_attempts WHERE key = ?')
    .bind(key)
    .first<{ count: number; window_start: number }>();
  if (!row) {
    await db
      .prepare('INSERT INTO login_attempts (key, count, window_start) VALUES (?, 1, ?)')
      .bind(key, now)
      .run();
    return;
  }
  const count = now - row.window_start > RATE_WINDOW_MS ? 1 : row.count + 1;
  const windowStart = now - row.window_start > RATE_WINDOW_MS ? now : row.window_start;
  const blockedUntil = count >= RATE_MAX_FAILURES ? now + RATE_WINDOW_MS : null;
  await db
    .prepare('UPDATE login_attempts SET count = ?, window_start = ?, blocked_until = ? WHERE key = ?')
    .bind(count, windowStart, blockedUntil, key)
    .run();
}

export async function clearLoginAttempts(db: D1Database, email: string, ip: string): Promise<void> {
  const key = await sha256Hex(`${email}|${ip}`);
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

export const PAT_PREFIX = 'gctp_';

/** Resolves a personal access token (what git / GitHub Desktop send as the password). */
export async function resolveUserToken(db: D1Database, raw: string): Promise<SessionUser | null> {
  if (!raw.startsWith(PAT_PREFIX)) return null;
  const row = await db
    .prepare(
      `SELECT t.id AS token_id, u.id, u.email, u.name, u.role
       FROM user_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`,
    )
    .bind(await sha256Hex(raw))
    .first<{ token_id: string; id: string; email: string; name: string; role: Role }>();
  if (!row) return null;
  void db
    .prepare('UPDATE user_tokens SET last_used_at = ? WHERE id = ?')
    .bind(nowMs(), row.token_id)
    .run()
    .catch(() => {});
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}
