import { Hono } from 'hono';
import {
  checkPassword,
  clearSessionCookie,
  clientIp,
  createSession,
  deleteSession,
  hashPassword,
  parseSessionCookie,
  resolveSession,
  sessionCookie,
  setCookie,
  type Role,
} from '../lib/auth';
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/http';
import { nowMs } from '../lib/ids';
import { audit } from '../lib/audit';
import { requireSession, sessionUser, type AppEnv } from '../middleware';

const ROLES: Role[] = ['admin', 'uploader', 'viewer'];

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

function validPassword(pw: string): boolean {
  return typeof pw === 'string' && pw.length >= 10 && pw.length <= 200;
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/status', async (c) => {
  const users = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  const needsSetup = (users?.n ?? 0) === 0;
  const token = parseSessionCookie(c.req.header('cookie'));
  const user = token ? await resolveSession(c.env.DB, token) : null;
  return c.json({ needsSetup, user });
});

authRoutes.post('/setup', async (c) => {
  const users = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if ((users?.n ?? 0) > 0) throw forbidden('Setup is already complete');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) throw badRequest('Invalid JSON body');
  const { name, email, password } = body as { name?: string; email?: string; password?: string };
  if (!name || name.length > 80) throw badRequest('A display name is required');
  if (!email || !validEmail(email)) throw badRequest('A valid email is required');
  if (!password || !validPassword(password)) throw badRequest('Password must be at least 10 characters');

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  await c.env.DB
    .prepare('INSERT INTO users (id, email, name, password_hash, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, email.toLowerCase(), name, passwordHash, 'admin', nowMs(), nowMs())
    .run();
  await audit(c.env.DB, email.toLowerCase(), 'user.setup', `user:${id}`);
  const token = await createSession(c.env.DB, id);
  setCookie(c, sessionCookie(token));
  return c.json({ user: { id, email: email.toLowerCase(), name, role: 'admin' } }, 201);
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { email, password } = (body ?? {}) as { email?: string; password?: string };
  if (!email || !password) throw badRequest('Email and password are required');
  const normalized = email.toLowerCase();
  const ip = clientIp(c.req.raw);
  const user = await checkPassword(c.env.DB, normalized, password, ip);
  if (user === 'blocked') {
    throw new ApiError(429, 'rate_limited', 'Too many failed attempts. Try again in a few minutes.');
  }
  if (!user) {
    await audit(c.env.DB, normalized, 'user.login_failed', `ip:${ip}`);
    throw unauthorized('Email or password is incorrect');
  }
  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowMs(), user.id).run();
  const token = await createSession(c.env.DB, user.id);
  await audit(c.env.DB, user.email, 'user.login', `user:${user.id}`, { ip });
  setCookie(c, sessionCookie(token));
  return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

authRoutes.post('/logout', async (c) => {
  const token = parseSessionCookie(c.req.header('cookie'));
  if (token) await deleteSession(c.env.DB, token);
  setCookie(c, clearSessionCookie());
  return c.json({ ok: true });
});

authRoutes.post('/accept', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { code, name, password, email } = (body ?? {}) as {
    code?: string;
    name?: string;
    password?: string;
    email?: string;
  };
  if (!code || !name || name.length > 80) throw badRequest('Invite code and display name are required');
  if (!password || !validPassword(password)) throw badRequest('Password must be at least 10 characters');
  const invite = await c.env.DB
    .prepare('SELECT code, email, role, expires_at, used_at FROM invites WHERE code = ?')
    .bind(code)
    .first<{ code: string; email: string | null; role: Role; expires_at: number; used_at: number | null }>();
  if (!invite) throw notFound('That invite code does not exist');
  if (invite.used_at) throw conflict('That invite code has already been used');
  if (invite.expires_at < nowMs()) throw conflict('That invite has expired');
  const finalEmail = (email ?? invite.email ?? '').toLowerCase();
  if (!validEmail(finalEmail)) throw badRequest('A valid email is required');
  if (!ROLES.includes(invite.role)) throw badRequest('Invite has an invalid role');
  const existing = await c.env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(finalEmail)
    .first();
  if (existing) throw conflict('An account with that email already exists');

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  await c.env.DB.batch([
    c.env.DB
      .prepare('INSERT INTO users (id, email, name, password_hash, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, finalEmail, name, passwordHash, invite.role, nowMs(), nowMs()),
    c.env.DB.prepare('UPDATE invites SET used_at = ? WHERE code = ?').bind(nowMs(), code),
  ]);
  await audit(c.env.DB, finalEmail, 'user.accepted_invite', `user:${id}`, { role: invite.role });
  const token = await createSession(c.env.DB, id);
  setCookie(c, sessionCookie(token));
  return c.json({ user: { id, email: finalEmail, name, role: invite.role } }, 201);
});

authRoutes.get('/me', requireSession(), (c) => {
  return c.json({ user: sessionUser(c) });
});
