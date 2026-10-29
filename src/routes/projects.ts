import { Hono, type Context } from 'hono';
import { audit } from '../lib/audit';
import { retryExtraction, type ExtractJobRow } from '../lib/extract';
import { badRequest, conflict, forbidden, notFound, tooLarge } from '../lib/http';
import { nowMs, randomId, sanitizeFilePath, sha256Hex, slugify } from '../lib/ids';
import { isTextPath, contentTypeForPath, MAX_TEXT_BLOB_BYTES } from '../lib/mime';
import { deleteUnreferencedObjects, writeKeyFor } from '../lib/r2refs';
import { requireAuthAny, requireRole, requireSession, sessionUser, type AppEnv } from '../middleware';
import { MODE_EXEC, MODE_FILE } from '../git/objects';
import { getRef, listFiles, readCommit, resolveCommit, updateRef } from '../git/repo';
import { GitStore } from '../git/store';

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  default_branch: string;
  protect_default: number;
};

/** Pushes and merges into a protected default branch need a pull request (and an approval). */
function isProtectedBranch(project: ProjectRow, branch: string | null): boolean {
  return project.protect_default === 1 && branch === project.default_branch;
}

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
  commit_sha: string | null;
};

const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}(-[a-z0-9.]+)?$/i;

function presentExtraction(job: ExtractJobRow) {
  let archives: string[] = [];
  try {
    const parsed = JSON.parse(job.archive_paths) as Array<{ path: string }>;
    if (Array.isArray(parsed)) archives = parsed.map((v) => v.path);
  } catch {
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
    phase: job.phase,
    detail: job.detail,
    totalFiles: job.total_files,
    totalBytes: job.total_bytes,
    archiveBytes: job.archive_bytes,
    bytesDone: job.bytes_done,
  };
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}

async function getProjectBySlug(db: D1Database, slug: string): Promise<ProjectRow | null> {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first<ProjectRow>();
}

/** Loads the `:slug` project or 404s; a deploy token may only reach its own project. */
async function loadProject(c: Context<AppEnv>): Promise<ProjectRow> {
  const project = await getProjectBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!project) throw notFound('Project not found');
  const auth = c.get('auth');
  if (auth.kind === 'token' && auth.projectId && auth.projectId !== project.id) {
    throw forbidden('This token is scoped to a different project');
  }
  return project;
}

async function getRelease(db: D1Database, projectId: string, version: string): Promise<ReleaseRow | null> {
  return db
    .prepare('SELECT * FROM releases WHERE project_id = ? AND version = ?')
    .bind(projectId, version)
    .first<ReleaseRow>();
}

async function loadRelease(c: Context<AppEnv>, project: ProjectRow): Promise<ReleaseRow> {
  const release = await getRelease(c.env.DB, project.id, c.req.param('version') ?? '');
  if (!release) throw notFound('Release not found');
  return release;
}

/** Normalizes a requested new version and rejects bad or taken ones. */
async function parseNewVersion(db: D1Database, projectId: string, version: string | undefined): Promise<string> {
  if (!version) throw badRequest('A version is required');
  const normalized = normalizeVersion(version);
  if (!VERSION_RE.test(normalized)) {
    throw badRequest('Version must look like 1.2.3 or 1.2.3-beta (max four number groups)');
  }
  if (await getRelease(db, projectId, normalized)) {
    throw conflict(`Version ${normalized} already exists in this project`);
  }
  return normalized;
}

async function commitFiles(store: GitStore, sha: string) {
  return (await listFiles(store, (await readCommit(store, sha)).tree)).filter(
    (f) => f.mode === MODE_FILE || f.mode === MODE_EXEC,
  );
}

function touchProject(db: D1Database, projectId: string) {
  return db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(nowMs(), projectId);
}

/** Puts a web-edited file at (release, path), replacing any file already there. */
function upsertTextFile(db: D1Database, releaseId: string, path: string, r2Key: string, size: number, digest: string, now: number) {
  return db
    .prepare(
      `INSERT INTO release_files (id, release_id, path, r2_key, size, content_type, digest, part_digests, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)
       ON CONFLICT(release_id, path) DO UPDATE SET
         r2_key = excluded.r2_key, size = excluded.size, content_type = excluded.content_type,
         digest = excluded.digest, part_digests = excluded.part_digests, created_at = excluded.created_at`,
    )
    .bind(randomId(12), releaseId, path, r2Key, size, contentTypeForPath(path), digest, now);
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

/** True when a draft cut from a commit still holds exactly that commit's files. */
async function matchesCommit(env: Env, projectId: string, release: ReleaseRow): Promise<boolean> {
  const store = new GitStore(env, projectId);
  const files = await commitFiles(store, release.commit_sha!);
  const rows = await env.DB
    .prepare('SELECT path, digest FROM release_files WHERE release_id = ?')
    .bind(release.id)
    .all<{ path: string; digest: string | null }>();
  if (rows.results.length !== files.length) return false;
  const want = new Map(files.map((f) => [f.path, f.sha]));
  return rows.results.every((r) => want.get(r.path) === r.digest);
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
  const project = await loadProject(c);
  const releases = await c.env.DB.prepare(
    `SELECT r.id, r.version, r.title, r.status, r.is_latest, r.download_count, r.created_at, r.published_at, r.commit_sha,
       (SELECT COUNT(*) FROM release_files f WHERE f.release_id = r.id) AS files_count,
       (SELECT COALESCE(SUM(f.size), 0) FROM release_files f WHERE f.release_id = r.id) AS size
     FROM releases r WHERE r.project_id = ? ORDER BY r.created_at DESC`,
  )
    .bind(project.id)
    .all();
  return c.json({ project, releases: releases.results });
});

projectRoutes.patch('/:slug', requireRole('admin', 'uploader'), async (c) => {
  const project = await loadProject(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { name, description, defaultBranch, protectDefault } = (body ?? {}) as {
    name?: string;
    description?: string;
    defaultBranch?: string;
    protectDefault?: boolean;
  };
  if (name !== undefined && (name.trim().length < 2 || name.length > 80)) {
    throw badRequest('Project name must be 2–80 characters');
  }
  if (defaultBranch !== undefined && !(await getRef(c.env.DB, project.id, `refs/heads/${defaultBranch}`))) {
    throw badRequest(`There is no branch named "${defaultBranch}"`);
  }
  if (protectDefault !== undefined && sessionUser(c).role !== 'admin') {
    throw forbidden('Only admins can change branch protection');
  }
  await c.env.DB
    .prepare(
      `UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description),
         default_branch = COALESCE(?, default_branch), protect_default = COALESCE(?, protect_default), updated_at = ? WHERE id = ?`,
    )
    .bind(
      name?.trim() ?? null,
      description !== undefined ? description.slice(0, 2000) : null,
      defaultBranch ?? null,
      protectDefault === undefined ? null : protectDefault ? 1 : 0,
      nowMs(),
      project.id,
    )
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'project.update', `project:${project.slug}`);
  return c.json({ ok: true });
});

projectRoutes.delete('/:slug', requireRole('admin'), async (c) => {
  const project = await loadProject(c);
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

projectRoutes.post('/:slug/releases', requireRole('admin', 'uploader'), async (c) => {
  const project = await loadProject(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { version, title, notes, ref } = (body ?? {}) as { version?: string; title?: string; notes?: string; ref?: string };
  const normalized = await parseNewVersion(c.env.DB, project.id, version);

  // A release cut from a branch, tag or commit snapshots that commit's files.
  let commitSha: string | null = null;
  let snapshot: { path: string; r2_key: string; size: number; sha: string }[] = [];
  if (ref) {
    const store = new GitStore(c.env, project.id);
    commitSha = await resolveCommit(store, ref);
    if (!commitSha) throw badRequest(`No branch, tag or commit named "${ref}"`);
    const files = await commitFiles(store, commitSha);
    const metas = await store.metas(files.map((f) => f.sha));
    snapshot = files.map((f) => {
      const meta = metas.get(f.sha);
      if (!meta?.r2_key) throw new Error(`blob ${f.sha} has no stored object`);
      return { path: f.path, r2_key: meta.r2_key, size: meta.size, sha: f.sha };
    });
    if (snapshot.length === 0) throw badRequest('That commit has no files to release');
  }

  const id = randomId(9);
  const now = nowMs();
  await c.env.DB
    .prepare('INSERT INTO releases (id, project_id, version, title, notes, status, created_by, created_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, project.id, normalized, (title ?? '').slice(0, 200), (notes ?? '').slice(0, 20000), 'draft', sessionUser(c).id, now, commitSha)
    .run();
  for (let i = 0; i < snapshot.length; i += 50) {
    await c.env.DB.batch(
      snapshot.slice(i, i + 50).map((f) =>
        c.env.DB
          .prepare(
            "INSERT INTO release_files (id, release_id, path, r2_key, size, content_type, digest, part_digests, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)",
          )
          .bind(randomId(12), id, f.path, f.r2_key, f.size, contentTypeForPath(f.path), f.sha, now),
      ),
    );
  }
  await touchProject(c.env.DB, project.id).run();
  await audit(c.env.DB, sessionUser(c).email, 'release.create', `project:${project.slug}/v${normalized}`, commitSha ? { commit: commitSha } : undefined);
  return c.json(
    { release: { id, version: normalized, title: title ?? '', notes: notes ?? '', status: 'draft', commitSha }, filesAdded: snapshot.length },
    201,
  );
});

async function resolveLatestPublished(c: Context<AppEnv>): Promise<{
  project: ProjectRow;
  release: ReleaseRow;
}> {
  const project = await loadProject(c);
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
  const { project, release } = await loadReleaseForRead(c);
  const [files, jobs] = await Promise.all([
    c.env.DB
      .prepare('SELECT id, path, size, content_type, digest, download_count, created_at FROM release_files WHERE release_id = ? ORDER BY path')
      .bind(release.id)
      .all(),
    c.env.DB
      .prepare('SELECT * FROM extract_jobs WHERE release_id = ? ORDER BY created_at DESC')
      .bind(release.id)
      .all<ExtractJobRow>(),
  ]);
  const logJobs = jobs.results.slice(0, 3);
  const logs = await Promise.all(
    logJobs.map((job) =>
      c.env.DB
        .prepare('SELECT seq, line, at FROM extract_log WHERE job_id = ? ORDER BY seq DESC LIMIT 200')
        .bind(job.id)
        .all<{ seq: number; line: string; at: number }>(),
    ),
  );
  const extractLogs: Record<string, { seq: number; line: string; at: number }[]> = {};
  logs.forEach(({ results }, i) => {
    if (results.length > 0) extractLogs[logJobs[i]!.id] = results.reverse();
  });
  return c.json({
    project,
    release,
    files: files.results,
    extractions: jobs.results.map(presentExtraction),
    extractLogs,
  });
});

async function loadReleaseForRead(c: Context<AppEnv>): Promise<{ project: ProjectRow; release: ReleaseRow }> {
  const project = await loadProject(c);
  const release = await loadRelease(c, project);
  if (release.status === 'draft' && c.get('auth').kind === 'token') throw notFound('Release not found');
  return { project, release };
}

projectRoutes.get('/:slug/releases/:version/blob', requireAuthAny(), async (c) => {
  const { project, release } = await loadReleaseForRead(c);
  const path = sanitizeFilePath(c.req.query('path') ?? '');
  if (!path) throw badRequest('A valid file path is required');
  const file = await c.env.DB
    .prepare('SELECT id, path, r2_key, size, digest FROM release_files WHERE release_id = ? AND path = ?')
    .bind(release.id, path)
    .first<{ id: string; path: string; r2_key: string; size: number; digest: string | null }>();
  if (!file) throw notFound('File not found in this release');
  const contentType = contentTypeForPath(path);
  const meta = { path, size: file.size, digest: file.digest, contentType };
  if (isTextPath(path)) {
    if (file.size > MAX_TEXT_BLOB_BYTES) {
      return c.json({ kind: 'text', ...meta, content: null, truncated: true });
    }
    const obj = await c.env.BUCKET.get(file.r2_key);
    if (!obj) throw notFound('Stored object is missing; contact an admin');
    try {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await obj.arrayBuffer());
      return c.json({ kind: 'text', ...meta, content, truncated: false });
    } catch {
    }
  }
  return c.json({
    kind: 'binary',
    ...meta,
    downloadUrl: `/dl/${project.slug}/v/${release.version}?path=${encodeURIComponent(path)}`,
  });
});

projectRoutes.post('/:slug/releases/:version/fork', requireRole('admin', 'uploader'), async (c) => {
  const project = await loadProject(c);
  const release = await loadRelease(c, project);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { version, title, notes, path, content } = (body ?? {}) as {
    version?: string;
    title?: string;
    notes?: string;
    path?: string;
    content?: string;
  };
  const normalized = await parseNewVersion(c.env.DB, project.id, version);
  let editPath: string | null = null;
  let editBytes: Uint8Array | null = null;
  if (path !== undefined || content !== undefined) {
    if (typeof content !== 'string') throw badRequest('content must be a string when editing a file');
    editPath = sanitizeFilePath(path ?? '');
    if (!editPath) throw badRequest('Invalid file path');
    editBytes = new TextEncoder().encode(content);
    if (editBytes.byteLength > MAX_TEXT_BLOB_BYTES) throw tooLarge('Edited files are capped at 1 MB');
  }

  const id = randomId(9);
  const now = nowMs();
  await c.env.DB
    .prepare('INSERT INTO releases (id, project_id, version, title, notes, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, project.id, normalized, (title ?? '').slice(0, 200), (notes ?? '').slice(0, 20000), 'draft', sessionUser(c).id, now)
    .run();
  const clone = await c.env.DB
    .prepare(
      `INSERT INTO release_files (id, release_id, path, r2_key, size, content_type, part_digests, digest, download_count, created_at, extract_job_id)
       SELECT lower(hex(randomblob(12))), ?, path, r2_key, size, content_type, part_digests, digest, 0, ?, NULL
       FROM release_files WHERE release_id = ?`,
    )
    .bind(id, now, release.id)
    .run();
  if (editPath && editBytes) {
    const r2Key = await writeKeyFor(c.env.DB, project.id, id, editPath);
    await c.env.BUCKET.put(r2Key, editBytes, { httpMetadata: { contentType: contentTypeForPath(editPath) } });
    const digest = await sha256Hex(editBytes);
    await upsertTextFile(c.env.DB, id, editPath, r2Key, editBytes.byteLength, digest, now).run();
  }
  await touchProject(c.env.DB, project.id).run();
  await audit(c.env.DB, sessionUser(c).email, 'release.fork', `project:${project.slug}/v${normalized}`, {
    from: release.version,
    edited: editPath,
    filesCloned: clone.meta.changes ?? 0,
  });
  return c.json({ release: { id, version: normalized, status: 'draft' }, filesCloned: clone.meta.changes ?? 0 }, 201);
});

projectRoutes.put('/:slug/releases/:version/files/content', requireRole('admin', 'uploader'), async (c) => {
  const project = await loadProject(c);
  const release = await loadRelease(c, project);
  if (release.status !== 'draft') {
    throw conflict('Published releases are immutable — save this edit into a new draft version');
  }
  const path = sanitizeFilePath(c.req.query('path') ?? '');
  if (!path) throw badRequest('A valid file path is required');
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_TEXT_BLOB_BYTES) throw tooLarge('Edited files are capped at 1 MB');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_TEXT_BLOB_BYTES) throw tooLarge('Edited files are capped at 1 MB');

  const existing = await c.env.DB
    .prepare('SELECT id, r2_key FROM release_files WHERE release_id = ? AND path = ?')
    .bind(release.id, path)
    .first<{ id: string; r2_key: string }>();
  const r2Key = await writeKeyFor(c.env.DB, project.id, release.id, path, existing?.id ?? undefined);
  await c.env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: contentTypeForPath(path) } });
  const digest = await sha256Hex(bytes);
  const now = nowMs();
  await upsertTextFile(c.env.DB, release.id, path, r2Key, bytes.byteLength, digest, now).run();
  if (existing) c.executionCtx.waitUntil(deleteUnreferencedObjects(c.env.DB, c.env.BUCKET, [existing.r2_key]));
  await touchProject(c.env.DB, project.id).run();
  await audit(c.env.DB, sessionUser(c).email, 'file.edit', `project:${project.slug}/v${release.version}/${path}`, {
    size: bytes.byteLength,
    digest,
  });
  return c.json({ ok: true, size: bytes.byteLength, digest });
});

projectRoutes.patch('/:slug/releases/:version', requireRole('admin', 'uploader'), async (c) => {
  const project = await loadProject(c);
  const release = await loadRelease(c, project);
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
  const project = await loadProject(c);
  const release = await loadRelease(c, project);
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
    touchProject(c.env.DB, project.id),
  ]);
  const user = sessionUser(c);
  await audit(c.env.DB, user.email, 'release.publish', `project:${project.slug}/v${release.version}`, { digest });
  if (release.commit_sha && (await matchesCommit(c.env, project.id, release))) {
    // Mirror GitHub: a published release tags its commit (unless the tag exists already).
    const tag = `refs/tags/v${release.version}`;
    if (!(await getRef(c.env.DB, project.id, tag))) {
      await updateRef(c.env.DB, project.id, tag, null, release.commit_sha, user.id);
    }
  }

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
  const project = await loadProject(c);
  const release = await loadRelease(c, project);
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
  const project = await loadProject(c);
  const release = await loadRelease(c, project);
  const user = sessionUser(c);
  if (release.status === 'published' && user.role !== 'admin') {
    throw forbidden('Only admins can delete a published release');
  }
  const rows = await c.env.DB
    .prepare('SELECT DISTINCT r2_key FROM release_files WHERE release_id = ?')
    .bind(release.id)
    .all<{ r2_key: string }>();
  const keys = rows.results.map((r) => r.r2_key);
  await c.env.DB.prepare('DELETE FROM releases WHERE id = ?').bind(release.id).run();
  let cursor: string | undefined;
  do {
    const listing = await c.env.BUCKET.list({ prefix: `p/${project.id}/r/${release.id}`, cursor });
    for (const o of listing.objects) keys.push(o.key);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  await deleteUnreferencedObjects(c.env.DB, c.env.BUCKET, keys);
  await audit(c.env.DB, user.email, 'release.delete', `project:${project.slug}/v${release.version}`);
  return c.json({ ok: true });
});

export { getProjectBySlug, getRelease, isProtectedBranch, loadProject, type ProjectRow, type ReleaseRow };
