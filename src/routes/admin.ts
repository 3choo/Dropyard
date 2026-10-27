import { Hono } from 'hono';
import { audit } from '../lib/audit';
import type { Role } from '../lib/auth';
import { badRequest, conflict, notFound } from '../lib/http';
import { nowMs, randomToken } from '../lib/ids';
import { requireRole, sessionUser, type AppEnv } from '../middleware';

const ROLES: Role[] = ['admin', 'uploader', 'viewer'];

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireRole('admin'));

adminRoutes.get('/users', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, email, name, role, created_at, last_login_at FROM users ORDER BY created_at',
  ).all();
  return c.json({ users: rows.results });
});

adminRoutes.patch('/users/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(c.req.param('id')).first<{ id: string; email: string }>();
  if (!row) throw notFound('User not found');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { role, name } = (body ?? {}) as { role?: string; name?: string };
  if (role !== undefined && !ROLES.includes(role as Role)) throw badRequest('Invalid role');
  if (name !== undefined && (name.trim().length < 2 || name.length > 80)) throw badRequest('Name must be 2–80 characters');
  await c.env.DB
    .prepare('UPDATE users SET role = COALESCE(?, role), name = COALESCE(?, name) WHERE id = ?')
    .bind(role ?? null, name !== undefined ? name.trim() : null, row.id)
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'user.update', `user:${row.id}`, { role, name });
  return c.json({ ok: true });
});

adminRoutes.delete('/users/:id', async (c) => {
  if (c.req.param('id') === sessionUser(c).id) throw badRequest('You cannot remove your own account');
  const row = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(c.req.param('id')).first<{ id: string; email: string }>();
  if (!row) throw notFound('User not found');
  const admins = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?")
    .bind(row.id)
    .first<{ n: number }>();
  if ((admins?.n ?? 0) === 0) throw conflict('At least one admin must remain');
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(row.id).run();
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id).run();
  await audit(c.env.DB, sessionUser(c).email, 'user.delete', `user:${row.id}`, { email: row.email });
  return c.json({ ok: true });
});

adminRoutes.get('/invites', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT code, email, role, created_at, expires_at, used_at FROM invites ORDER BY created_at DESC LIMIT 100',
  ).all();
  return c.json({ invites: rows.results });
});

adminRoutes.post('/invites', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { role, email } = (body ?? {}) as { role?: string; email?: string };
  if (!role || !ROLES.includes(role as Role)) throw badRequest('Choose a valid role: admin, uploader or viewer');
  const code = randomToken(18);
  await c.env.DB
    .prepare('INSERT INTO invites (code, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(code, email ? String(email).toLowerCase() : null, role, sessionUser(c).id, nowMs(), nowMs() + 48 * 3600 * 1000)
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'invite.create', `invite:${code.slice(0, 8)}`, { role });
  return c.json({ code, role, expiresInSeconds: 48 * 3600 }, 201);
});

adminRoutes.delete('/invites/:code', async (c) => {
  await c.env.DB.prepare('DELETE FROM invites WHERE code = ?').bind(c.req.param('code')).run();
  return c.json({ ok: true });
});

adminRoutes.get('/audit', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '80', 10) || 80, 300);
  const before = parseInt(c.req.query('before') ?? '0', 10) || Number.MAX_SAFE_INTEGER;
  const rows = await c.env.DB
    .prepare('SELECT id, actor, action, target, meta, created_at FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?')
    .bind(before, limit)
    .all();
  return c.json({ entries: rows.results });
});

adminRoutes.get('/settings', async (c) => {
  const row = await c.env.DB
    .prepare("SELECT value FROM settings WHERE key = 'discord_webhook_url'")
    .first<{ value: string }>();
  return c.json({ discordWebhookUrl: row?.value ?? '' });
});

adminRoutes.put('/settings', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { discordWebhookUrl } = (body ?? {}) as { discordWebhookUrl?: string };
  const value = (discordWebhookUrl ?? '').trim();
  if (value && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(value)) {
    throw badRequest('That does not look like a Discord webhook URL');
  }
  await c.env.DB
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('discord_webhook_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(value)
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'settings.update', 'settings:discord_webhook', { enabled: !!value });
  return c.json({ ok: true });
});
