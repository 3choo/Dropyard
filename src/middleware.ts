import type { Context, MiddlewareHandler } from 'hono';
import {
  type Role,
  type SessionUser,
  SESSION_COOKIE,
  resolveSession,
} from './lib/auth';
import { sha256Hex, nowMs } from './lib/ids';
import { unauthorized, forbidden } from './lib/http';

export type AuthContext =
  | { kind: 'session'; user: SessionUser }
  | { kind: 'token'; tokenId: string; name: string; projectId: string | null };

export type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } };

async function resolveToken(env: Env, raw: string): Promise<AuthContext | null> {
  if (!raw.startsWith('gctx_')) return null;
  const hash = await sha256Hex(raw);
  const row = await env.DB
    .prepare(
      'SELECT id, name, project_id FROM deploy_tokens WHERE token_hash = ?',
    )
    .bind(hash)
    .first<{ id: string; name: string; project_id: string | null }>();
  if (!row) return null;
  void env.DB
    .prepare('UPDATE deploy_tokens SET last_used_at = ? WHERE id = ?')
    .bind(nowMs(), row.id)
    .run()
    .catch(() => {});
  return { kind: 'token', tokenId: row.id, name: row.name, projectId: row.project_id };
}

async function resolveAny(env: Env, req: Request): Promise<AuthContext | null> {
  const authz = req.headers.get('authorization');
  if (authz?.startsWith('Bearer ')) {
    const ctx = await resolveToken(env, authz.slice(7).trim());
    if (ctx) return ctx;
  }
  const queryToken = new URL(req.url).searchParams.get('token');
  if (queryToken) {
    const ctx = await resolveToken(env, queryToken);
    if (ctx) return ctx;
  }
  const cookie = parseCookie(req.headers.get('cookie'));
  if (cookie) {
    const user = await resolveSession(env.DB, cookie);
    if (user) return { kind: 'session', user };
  }
  return null;
}

function parseCookie(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return v.join('=');
  }
  return undefined;
}

/** Session required; deploy tokens are rejected on human endpoints. */
export function requireSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = await resolveAny(c.env, c.req.raw);
    if (!ctx || ctx.kind !== 'session') throw unauthorized();
    c.set('auth', ctx);
    await next();
  };
}

/** Session or deploy token — machine-readable endpoints. */
export function requireAuthAny(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = await resolveAny(c.env, c.req.raw);
    if (!ctx) throw unauthorized('Provide a session or a deploy token');
    c.set('auth', ctx);
    await next();
  };
}

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = await resolveAny(c.env, c.req.raw);
    if (!ctx || ctx.kind !== 'session') throw unauthorized();
    if (!roles.includes(ctx.user.role)) {
      throw forbidden(`This action requires the ${roles.join(' or ')} role`);
    }
    c.set('auth', ctx);
    await next();
  };
}

/**
 * Routes behind requireSession/requireRole always carry a session user, but
 * Hono's Variables type keeps the full AuthContext union; this re-narrows.
 */
export function sessionUser(c: Context<AppEnv>): SessionUser {
  const auth = c.get('auth');
  if (auth.kind !== 'session') throw unauthorized();
  return auth.user;
}
