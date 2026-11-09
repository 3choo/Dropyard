import { Hono } from 'hono';
import { audit } from '../lib/audit';
import type { Role } from '../lib/auth';
import { badRequest, conflict, notFound } from '../lib/http';
import { nowMs, randomToken } from '../lib/ids';
import { requireRole, sessionUser, type AppEnv } from '../middleware';
import { deleteUnreferencedObjects } from '../lib/r2refs';
import { getBucket } from '../lib/storage';

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

adminRoutes.post('/storage/dedupe', async (c) => {
  const slug = c.req.query('project') ?? '';
  const dryRun = c.req.query('dryRun') === '1' || c.req.query('dryRun') === 'true';
  const project = await c.env.DB.prepare('SELECT id, slug FROM projects WHERE slug = ?').bind(slug).first<{ id: string; slug: string }>();
  if (!project) throw notFound('Project not found');
  const bucket = getBucket(c.env);
  const started = Date.now();
  let cursor = c.req.query('cursor') ?? '';
  let more = true;
  let paths = 0;
  let merged = 0;
  let bytes = 0;
  const spare: string[] = [];

  while (more && Date.now() - started < 20_000) {
    const page = await c.env.DB
      .prepare(
        `SELECT DISTINCT f.path FROM release_files f JOIN releases r ON r.id = f.release_id
         WHERE r.project_id = ? AND f.path > ? ORDER BY f.path LIMIT 40`,
      )
      .bind(project.id, cursor)
      .all<{ path: string }>();
    if (page.results.length === 0) {
      more = false;
      break;
    }
    for (const { path } of page.results) {
      cursor = path;
      paths++;
      const rows = await c.env.DB
        .prepare(
          `SELECT f.r2_key, f.size, f.digest, MIN(r.created_at) AS first_seen
           FROM release_files f JOIN releases r ON r.id = f.release_id
           WHERE r.project_id = ? AND f.path = ? GROUP BY f.r2_key, f.size, f.digest ORDER BY first_seen`,
        )
        .bind(project.id, path)
        .all<{ r2_key: string; size: number; digest: string | null }>();
      if (rows.results.length < 2) continue;
      const keepers: Array<{ key: string; size: number; digest: string | null; etag: string }> = [];
      for (const row of rows.results) {
        const head = await bucket.head(row.r2_key);
        if (!head || !head.httpEtag || head.size !== row.size) continue;
        const twin = keepers.find(
          (k) => k.size === row.size && k.etag === head.httpEtag && (k.digest === null || row.digest === null || k.digest === row.digest),
        );
        if (!twin) {
          keepers.push({ key: row.r2_key, size: row.size, digest: row.digest, etag: head.httpEtag });
          continue;
        }
        if (twin.key === row.r2_key) continue;
        merged++;
        bytes += row.size;
        if (dryRun) continue;
        await c.env.DB.batch([
          c.env.DB
            .prepare('UPDATE release_files SET r2_key = ? WHERE r2_key = ? AND release_id IN (SELECT id FROM releases WHERE project_id = ?)')
            .bind(twin.key, row.r2_key, project.id),
          c.env.DB.prepare('UPDATE git_objects SET r2_key = ? WHERE project_id = ? AND r2_key = ?').bind(twin.key, project.id, row.r2_key),
        ]);
        spare.push(row.r2_key);
      }
    }
  }
  if (!dryRun) await deleteUnreferencedObjects(c.env.DB, bucket, spare);
  if (!dryRun && merged > 0) {
    await audit(c.env.DB, sessionUser(c).email, 'storage.dedupe', `project:${project.slug}`, { merged, bytesFreed: bytes });
  }
  return c.json({ project: project.slug, dryRun, pathsChecked: paths, duplicatesMerged: merged, bytesFreed: bytes, cursor: more ? cursor : null });
});

/**
 * Finds release files whose stored object no longer exists (for example after
 * deleting objects straight from the bucket). Read-only by default:
 *   POST /api/admin/storage/missing?project=<slug>&cursor=<key>
 * Add &remove=1 to also drop those rows, so releases list only what is really
 * stored and the files can be uploaded again. Repeat with the returned cursor.
 */
adminRoutes.post('/storage/missing', async (c) => {
  const slug = c.req.query('project') ?? '';
  const remove = c.req.query('remove') === '1';
  const project = await c.env.DB.prepare('SELECT id, slug FROM projects WHERE slug = ?').bind(slug).first<{ id: string; slug: string }>();
  if (!project) throw notFound('Project not found');
  const bucket = getBucket(c.env);
  const started = Date.now();
  let cursor = c.req.query('cursor') ?? '';
  let checked = 0;
  let more = true;
  const gone: string[] = [];
  const byRelease = new Map<string, number>();

  while (more && Date.now() - started < 20_000) {
    const page = await c.env.DB
      .prepare(
        `SELECT DISTINCT f.r2_key FROM release_files f JOIN releases r ON r.id = f.release_id
         WHERE r.project_id = ? AND f.r2_key > ? ORDER BY f.r2_key LIMIT 100`,
      )
      .bind(project.id, cursor)
      .all<{ r2_key: string }>();
    if (page.results.length === 0) {
      more = false;
      break;
    }
    for (let i = 0; i < page.results.length; i += 20) {
      const part = page.results.slice(i, i + 20);
      const heads = await Promise.all(part.map((r) => bucket.head(r.r2_key).catch(() => undefined)));
      part.forEach((r, j) => {
        cursor = r.r2_key;
        checked++;
        if (heads[j] === null) gone.push(r.r2_key);
      });
    }
  }
  for (const key of gone) {
    const rows = await c.env.DB
      .prepare('SELECT r.version FROM release_files f JOIN releases r ON r.id = f.release_id WHERE r.project_id = ? AND f.r2_key = ?')
      .bind(project.id, key)
      .all<{ version: string }>();
    for (const row of rows.results) byRelease.set(row.version, (byRelease.get(row.version) ?? 0) + 1);
  }
  if (remove && gone.length > 0) {
    for (let i = 0; i < gone.length; i += 40) {
      const part = gone.slice(i, i + 40);
      await c.env.DB
        .prepare(`DELETE FROM release_files WHERE r2_key IN (${part.map(() => '?').join(',')}) AND release_id IN (SELECT id FROM releases WHERE project_id = ?)`)
        .bind(...part, project.id)
        .run();
    }
    await audit(c.env.DB, sessionUser(c).email, 'storage.missing.remove', `project:${project.slug}`, { objects: gone.length });
  }
  return c.json({
    project: project.slug,
    objectsChecked: checked,
    missingObjects: gone.length,
    removedRows: remove,
    affectedFilesByVersion: Object.fromEntries(byRelease),
    sample: gone.slice(0, 5),
    cursor: more ? cursor : null,
  });
});
