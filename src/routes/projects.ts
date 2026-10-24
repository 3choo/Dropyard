import { Hono, type Context } from 'hono';
import { audit } from '../lib/audit';
import { retryExtraction, type ExtractJobRow } from '../lib/extract';
import { badRequest, conflict, forbidden, notFound } from '../lib/http';
import { nowMs, randomId, sanitizeFilePath, sha256Hex, slugify } from '../lib/ids';
import { requireAuthAny, requireRole, requireSession, sessionUser, type AppEnv } from '../middleware';

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  created_by: string;
  created_at: number;
  updated_at: number;
};

type ReleaseRow = {
  id: string;
  project_id: string;
  version: string;
  title: string;
  notes: string;
  status: 'draft' | 'published';
  is_latest: number;
  digest: string | null;
  download_count: number;
  created_by: string;
  created_at: number;
  published_at: number | null;
};

type FileRow = {
  id: string;
  release_id: string;
  path: string;
  r2_key: string;
  size: number;
  content_type: string;
  digest: string | null;
  download_count: number;
  created_at: number;
};

const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}(-[a-z0-9.]+)?$/i;

function presentExtraction(job: ExtractJobRow) {
  let archives: string[] = [];
  try {
    const parsed = JSON.parse(job.archive_paths) as Array<{ path: string }>;
    if (Array.isArray(parsed)) archives = parsed.map((v) => v.path);
  } catch {
    // keep empty
  }
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    filesAdded: job.files_added,
    bytesAdded: job.bytes_added,
    error: job.error,
    archives,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
  };
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}

async function getProjectBySlug(db: D1Database, slug: string): Promise<ProjectRow | null> {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first<ProjectRow>();
}

async function getRelease(db: D1Database, projectId: string, version: string): Promise<ReleaseRow | null> {
  return db
    .prepare('SELECT * FROM releases WHERE project_id = ? AND version = ?')
    .bind(projectId, version)
    .first<ReleaseRow>();
}

async function releaseDigest(release: ReleaseRow, db: D1Database): Promise<string> {
  const files = await db
    .prepare('SELECT path, size, digest FROM release_files WHERE release_id = ? ORDER BY path')
    .bind(release.id)
    .all<{ path: string; size: number; digest: string | null }>();
  const manifest = [
    release.version,
    ...files.results.map((f) => `${f.path}:${f.size}:${f.digest ?? ''}`),
  ].join('\n');
  return sha256Hex(manifest);
}

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.get('/', requireSession(), async (c) => {
  const results = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.updated_at,
       (SELECT r.version FROM releases r WHERE r.project_id = p.id AND r.status = 'published'
          ORDER BY r.is_latest DESC, r.published_at DESC LIMIT 1) AS latest_version,
       (SELECT r.published_at FROM releases r WHERE r.project_id = p.id AND r.status = 'published'
          ORDER BY r.is_latest DESC, r.published_at DESC LIMIT 1) AS latest_published_at,
       (SELECT COUNT(*) FROM releases r WHERE r.project_id = p.id AND r.status = 'published') AS release_count,
       (SELECT COALESCE(SUM(f.size), 0) FROM release_files f JOIN releases r ON f.release_id = r.id
          WHERE r.project_id = p.id) AS storage_bytes
     FROM projects p
     ORDER BY p.updated_at DESC`,
  ).all();
  return c.json({ projects: results.results });
});

projectRoutes.post('/', requireRole('admin', 'uploader'), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { name, slug, description } = (body ?? {}) as {
    name?: string;
    slug?: string;
    description?: string;
  };
  if (!name || name.trim().length < 2 || name.length > 80) throw badRequest('Project name must be 2–80 characters');
  const finalSlug = slugify(slug || name);
  const existing = await getProjectBySlug(c.env.DB, finalSlug);
  if (existing) throw conflict(`The slug "${finalSlug}" is already taken`);
  const id = randomId(9);
  const now = nowMs();
  await c.env.DB
    .prepare('INSERT INTO projects (id, slug, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, finalSlug, name.trim(), (description ?? '').slice(0, 2000), sessionUser(c).id, now, now)
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'project.create', `project:${finalSlug}`);
  return c.json({ project: { id, slug: finalSlug, name: name.trim(), description: description ?? '' } }, 201);
});

projectRoutes.get('/:slug', requireAuthAny(), async (c) => {
  const auth = c.get('auth');
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  if (auth.kind === 'token' && auth.projectId && auth.projectId !== project.id) {
    throw forbidden('This token is scoped to a different project');
  }
  const releases = await c.env.DB.prepare(
    `SELECT r.id, r.version, r.title, r.status, r.is_latest, r.download_count, r.created_at, r.published_at,
       (SELECT COUNT(*) FROM release_files f WHERE f.release_id = r.id) AS files_count,
       (SELECT COALESCE(SUM(f.size), 0) FROM release_files f WHERE f.release_id = r.id) AS size
     FROM releases r WHERE r.project_id = ? ORDER BY r.created_at DESC`,
  )
    .bind(project.id)
    .all();
  return c.json({ project, releases: releases.results });
});

projectRoutes.patch('/:slug', requireRole('admin', 'uploader'), async (c) => {
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { name, description } = (body ?? {}) as { name?: string; description?: string };
  if (name !== undefined && (name.trim().length < 2 || name.length > 80)) {
    throw badRequest('Project name must be 2–80 characters');
  }
  await c.env.DB
    .prepare('UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ? WHERE id = ?')
    .bind(name?.trim() ?? null, description !== undefined ? description.slice(0, 2000) : null, nowMs(), project.id)
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'project.update', `project:${project.slug}`);
  return c.json({ ok: true });
});

projectRoutes.delete('/:slug', requireRole('admin'), async (c) => {
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  // Remove every stored object, then the rows (cascades releases/files/sessions).
  let cursor: string | undefined;
  do {
    const listing = await c.env.BUCKET.list({ prefix: `p/${project.id}/`, cursor });
    if (listing.objects.length > 0) {
      await c.env.BUCKET.delete(listing.objects.map((o) => o.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  await c.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(project.id).run();
  await audit(c.env.DB, sessionUser(c).email, 'project.delete', `project:${project.slug}`);
  return c.json({ ok: true });
});

// --- Releases ------------------------------------------------------------------

projectRoutes.post('/:slug/releases', requireRole('admin', 'uploader'), async (c) => {
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { version, title, notes } = (body ?? {}) as { version?: string; title?: string; notes?: string };
  if (!version) throw badRequest('A version is required');
  const normalized = normalizeVersion(version);
  if (!VERSION_RE.test(normalized)) {
    throw badRequest('Version must look like 1.2.3 or 1.2.3-beta (max four number groups)');
  }
  const existing = await getRelease(c.env.DB, project.id, normalized);
  if (existing) throw conflict(`Version ${normalized} already exists in this project`);
  const id = randomId(9);
  await c.env.DB
    .prepare('INSERT INTO releases (id, project_id, version, title, notes, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, project.id, normalized, (title ?? '').slice(0, 200), (notes ?? '').slice(0, 20000), 'draft', sessionUser(c).id, nowMs())
    .run();
  await c.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(nowMs(), project.id).run();
  await audit(c.env.DB, sessionUser(c).email, 'release.create', `project:${project.slug}/v${normalized}`);
  return c.json({ release: { id, version: normalized, title: title ?? '', notes: notes ?? '', status: 'draft' } }, 201);
});

// --- Machine endpoints (stable URLs for the FiveM updater) ----------------------
// Registered before /:version so "latest" is not captured as a version.

async function resolveLatestPublished(c: Context<AppEnv>): Promise<{
  project: ProjectRow;
  release: ReleaseRow;
}> {
  const auth = c.get('auth');
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  if (auth.kind === 'token' && auth.projectId && auth.projectId !== project.id) {
    throw forbidden('This token is scoped to a different project');
  }
  const release = await c.env.DB
    .prepare(
      "SELECT * FROM releases WHERE project_id = ? AND status = 'published' ORDER BY is_latest DESC, published_at DESC LIMIT 1",
    )
    .bind(project.id)
    .first<ReleaseRow>();
  if (!release) throw notFound('No published release yet');
  return { project, release };
}

projectRoutes.get('/:slug/releases/latest/check', requireAuthAny(), async (c) => {
  const { release } = await resolveLatestPublished(c);
  return new Response(
    JSON.stringify({ version: release.version, digest: release.digest, publishedAt: release.published_at }),
    { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
});

projectRoutes.get('/:slug/releases/latest', requireAuthAny(), async (c) => {
  const { project, release } = await resolveLatestPublished(c);
  const files = await c.env.DB
    .prepare('SELECT path, size, content_type, digest FROM release_files WHERE release_id = ? ORDER BY path')
    .bind(release.id)
    .all<{ path: string; size: number; content_type: string; digest: string | null }>();
  return c.json({
    project: { slug: project.slug, name: project.name },
    version: release.version,
    title: release.title,
    notes: release.notes,
    digest: release.digest,
    publishedAt: release.published_at,
    files: files.results.map((f) => ({
      path: f.path,
      size: f.size,
      contentType: f.content_type,
      digest: f.digest,
      downloadUrl: `/dl/${project.slug}/v/${release.version}?path=${encodeURIComponent(f.path)}`,
    })),
  });
});

projectRoutes.get('/:slug/releases/:version', requireAuthAny(), async (c) => {
  const auth = c.get('auth');
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  if (auth.kind === 'token' && auth.projectId && auth.projectId !== project.id) {
    throw forbidden('This token is scoped to a different project');
  }
  const release = await getRelease(c.env.DB, project.id, c.req.param('version'));
  if (!release) throw notFound('Release not found');
  if (release.status === 'draft' && auth.kind === 'token') throw notFound('Release not found');
  const files = await c.env.DB
    .prepare('SELECT id, path, size, content_type, digest, download_count, created_at FROM release_files WHERE release_id = ? ORDER BY path')
    .bind(release.id)
    .all();
  const jobs = await c.env.DB
    .prepare('SELECT * FROM extract_jobs WHERE release_id = ? ORDER BY created_at DESC')
    .bind(release.id)
    .all<ExtractJobRow>();
  return c.json({ project, release, files: files.results, extractions: jobs.results.map(presentExtraction) });
});

projectRoutes.patch('/:slug/releases/:version', requireRole('admin', 'uploader'), async (c) => {
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  const release = await getRelease(c.env.DB, project.id, c.req.param('version'));
  if (!release) throw notFound('Release not found');
  const user = sessionUser(c);
  if (release.status === 'published' && user.role !== 'admin') {
    throw forbidden('Only admins can edit a published release');
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { title, notes } = (body ?? {}) as { title?: string; notes?: string };
  await c.env.DB
    .prepare('UPDATE releases SET title = COALESCE(?, title), notes = COALESCE(?, notes) WHERE id = ?')
    .bind(title !== undefined ? title.slice(0, 200) : null, notes !== undefined ? notes.slice(0, 20000) : null, release.id)
    .run();
  await audit(c.env.DB, user.email, 'release.update', `project:${project.slug}/v${release.version}`);
  return c.json({ ok: true });
});

projectRoutes.post('/:slug/releases/:version/publish', requireRole('admin', 'uploader'), async (c) => {
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  const release = await getRelease(c.env.DB, project.id, c.req.param('version'));
  if (!release) throw notFound('Release not found');
  if (release.status === 'published') throw conflict('This release is already published');
  const files = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM release_files WHERE release_id = ?')
    .bind(release.id)
    .first<{ n: number }>();
  if ((files?.n ?? 0) === 0) throw badRequest('Upload at least one file before publishing');
  const pendingJobs = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM extract_jobs WHERE release_id = ? AND status IN ('queued','running')")
    .bind(release.id)
    .first<{ n: number }>();
  if ((pendingJobs?.n ?? 0) > 0) {
    throw conflict('Archives are still unpacking — wait for extraction to finish before publishing');
  }

  const digest = await releaseDigest(release, c.env.DB);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE releases SET is_latest = 0 WHERE project_id = ? AND is_latest = 1').bind(project.id),
    c.env.DB
      .prepare("UPDATE releases SET status = 'published', is_latest = 1, published_at = ?, digest = ? WHERE id = ?")
      .bind(nowMs(), digest, release.id),
    c.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(nowMs(), project.id),
  ]);
  const user = sessionUser(c);
  await audit(c.env.DB, user.email, 'release.publish', `project:${project.slug}/v${release.version}`, { digest });

  // Optional Discord announcement, off unless configured by an admin.
  const webhook = await c.env.DB
    .prepare("SELECT value FROM settings WHERE key = 'discord_webhook_url'")
    .first<{ value: string }>();
  if (webhook?.value) {
    const embed = {
      title: `${project.name} — v${release.version}`,
      description: (release.notes || release.title || 'New release published.').slice(0, 500),
      color: 0xc9f24f,
      footer: { text: `gitctx · ${project.slug}` },
    };
    c.executionCtx.waitUntil(
      fetch(webhook.value, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      }).catch(() => {}),
    );
  }
  return c.json({ ok: true, version: release.version, digest });
});

projectRoutes.post('/:slug/releases/:version/extractions/:jobId/retry', requireRole('admin', 'uploader'), async (c) => {
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  const release = await getRelease(c.env.DB, project.id, c.req.param('version'));
  if (!release) throw notFound('Release not found');
  if (release.status !== 'draft') throw conflict('Published releases are immutable');
  const jobId = c.req.param('jobId') ?? '';
  const job = await c.env.DB
    .prepare('SELECT release_id FROM extract_jobs WHERE id = ?')
    .bind(jobId)
    .first<{ release_id: string }>();
  if (!job || job.release_id !== release.id) throw notFound('Extraction job not found');
  try {
    const next = await retryExtraction(c.env, (p) => c.executionCtx.waitUntil(p), {
      origin: new URL(c.req.url).origin,
      jobId,
    });
    return c.json({ extraction: presentExtraction(next) }, 201);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'Retry failed');
  }
});

projectRoutes.delete('/:slug/releases/:version', requireRole('admin', 'uploader'), async (c) => {
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  const release = await getRelease(c.env.DB, project.id, c.req.param('version'));
  if (!release) throw notFound('Release not found');
  const user = sessionUser(c);
  if (release.status === 'published' && user.role !== 'admin') {
    throw forbidden('Only admins can delete a published release');
  }
  let cursor: string | undefined;
  do {
    const listing = await c.env.BUCKET.list({ prefix: `p/${project.id}/r/${release.id}/`, cursor });
    if (listing.objects.length > 0) {
      await c.env.BUCKET.delete(listing.objects.map((o) => o.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  await c.env.DB.prepare('DELETE FROM releases WHERE id = ?').bind(release.id).run();
  await audit(c.env.DB, user.email, 'release.delete', `project:${project.slug}/v${release.version}`);
  return c.json({ ok: true });
});

export { getProjectBySlug, getRelease, type ProjectRow, type ReleaseRow };
