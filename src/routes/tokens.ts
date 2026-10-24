import { Hono } from 'hono';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/http';
import { nowMs, randomToken, sha256Hex } from '../lib/ids';
import { requireRole, sessionUser, type AppEnv } from '../middleware';

export const tokenRoutes = new Hono<AppEnv>();
tokenRoutes.use('*', requireRole('admin'));

tokenRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.prefix, t.project_id, p.slug AS project_slug, t.last_used_at, t.created_at
     FROM deploy_tokens t LEFT JOIN projects p ON p.id = t.project_id
     ORDER BY t.created_at DESC`,
  ).all();
  return c.json({ tokens: rows.results });
});

/** Created token plaintext is shown exactly once, in this response. */
tokenRoutes.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { name, projectId } = (body ?? {}) as { name?: string; projectId?: string };
  if (!name || name.trim().length < 2 || name.length > 80) throw badRequest('Give the token a recognizable name');
  if (projectId) {
    const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
    if (!project) throw badRequest('Unknown project for token scoping');
  }
  const plaintext = `gctx_${randomToken(32)}`;
  const id = crypto.randomUUID();
  await c.env.DB
    .prepare('INSERT INTO deploy_tokens (id, name, token_hash, prefix, project_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name.trim(), await sha256Hex(plaintext), plaintext.slice(0, 12), projectId ?? null, sessionUser(c).id, nowMs())
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'token.create', `token:${id}`, { name, projectId: projectId ?? null });
  return c.json({ id, token: plaintext, name: name.trim(), projectId: projectId ?? null }, 201);
});

tokenRoutes.delete('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT id FROM deploy_tokens WHERE id = ?').bind(c.req.param('id')).first();
  if (!row) throw notFound('Token not found');
  await c.env.DB.prepare('DELETE FROM deploy_tokens WHERE id = ?').bind(row.id).run();
  await audit(c.env.DB, sessionUser(c).email, 'token.delete', `token:${row.id}`);
  return c.json({ ok: true });
});
