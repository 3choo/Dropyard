import { Hono } from 'hono';
import { audit } from '../lib/audit';
import { PAT_PREFIX } from '../lib/auth';
import { badRequest, notFound } from '../lib/http';
import { nowMs, randomId, randomToken, sha256Hex } from '../lib/ids';
import { requireSession, sessionUser, type AppEnv } from '../middleware';

/** The signed-in user's own settings: personal access tokens for git. */
export const meRoutes = new Hono<AppEnv>();
meRoutes.use('*', requireSession());

meRoutes.get('/tokens', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, name, prefix, created_at, last_used_at FROM user_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .bind(sessionUser(c).id)
    .all();
  return c.json({ tokens: rows.results });
});

meRoutes.post('/tokens', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 80) throw badRequest('Give the token a recognizable name (2–80 characters)');
  const user = sessionUser(c);
  const plaintext = `${PAT_PREFIX}${randomToken(30)}`;
  const id = randomId(9);
  await c.env.DB
    .prepare('INSERT INTO user_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, name, await sha256Hex(plaintext), plaintext.slice(0, 12), nowMs())
    .run();
  await audit(c.env.DB, user.email, 'pat.create', `pat:${id}`, { name });
  return c.json({ id, name, token: plaintext }, 201);
});

meRoutes.delete('/tokens/:id', async (c) => {
  const user = sessionUser(c);
  const res = await c.env.DB
    .prepare('DELETE FROM user_tokens WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  if (!res.meta.changes) throw notFound('Token not found');
  await audit(c.env.DB, user.email, 'pat.delete', `pat:${c.req.param('id')}`);
  return c.json({ ok: true });
});
