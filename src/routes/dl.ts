import { Hono, type Context } from 'hono';
import { forbidden, notFound } from '../lib/http';
import { pullScript } from '../lib/pullscript';
import { planZip, zipStream } from '../lib/zipstream';
import { requireAuthAny, type AppEnv } from '../middleware';

type ProjectRow = { id: string; slug: string; name: string };
type ReleaseRow = { id: string; version: string; status: string; published_at: number | null; digest: string | null };
type FileRow = {
  id: string;
  path: string;
  r2_key: string;
  size: number;
  content_type: string;
  download_count: number;
};

export const dlRoutes = new Hono<AppEnv>();

dlRoutes.get('/:slug/latest', requireAuthAny(), (c) => serveRelease(c, 'latest'));
dlRoutes.get('/:slug/v/:version', requireAuthAny(), (c) => serveRelease(c, c.req.param('version')));
dlRoutes.get('/:slug/latest/manifest', requireAuthAny(), (c) => serveManifest(c));
dlRoutes.get('/:slug/pull.sh', requireAuthAny(), async (c) => {
  const { project } = await resolveRelease(c, 'latest');
  // Bake in the deploy token the script was fetched with, so `curl … | bash` is all it takes.
  const authz = c.req.header('authorization');
  const token = authz?.startsWith('Bearer ') ? authz.slice(7).trim() : (c.req.query('token') ?? '');
  const script = pullScript(new URL(c.req.url).origin, project.slug, c.get('auth').kind === 'token' ? token : '');
  return new Response(script, {
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' },
  });
});

async function resolveRelease(c: Context<AppEnv>, which: string): Promise<{ project: ProjectRow; release: ReleaseRow }> {
  const auth = c.get('auth');
  const project = await c.env.DB
    .prepare('SELECT id, slug, name FROM projects WHERE slug = ?')
    .bind(c.req.param('slug'))
    .first<ProjectRow>();
  if (!project) throw notFound('Project not found');
  if (auth.kind === 'token' && auth.projectId && auth.projectId !== project.id) {
    throw forbidden('This token is scoped to a different project');
  }
  const release =
    which === 'latest'
      ? await c.env.DB
          .prepare(
            "SELECT id, version, status, published_at, digest FROM releases WHERE project_id = ? AND status = 'published' ORDER BY is_latest DESC, published_at DESC LIMIT 1",
          )
          .bind(project.id)
          .first<ReleaseRow>()
      : await c.env.DB
          .prepare(
            "SELECT id, version, status, published_at, digest FROM releases WHERE project_id = ? AND version = ? AND status = 'published'",
          )
          .bind(project.id, which)
          .first<ReleaseRow>();
  if (!release) throw notFound('Release not found');
  return { project, release };
}

async function serveRelease(c: Context<AppEnv>, which: string): Promise<Response> {
  const { project, release } = await resolveRelease(c, which);
  const path = c.req.query('path');
  let file: FileRow;
  if (path) {
    const row = await c.env.DB
      .prepare('SELECT id, path, r2_key, size, content_type, download_count FROM release_files WHERE release_id = ? AND path = ?')
      .bind(release.id, path)
      .first<FileRow>();
    if (!row) throw notFound('File not found in this release');
    file = row;
  } else {
    const files = await c.env.DB
      .prepare('SELECT id, path, r2_key, size, content_type, download_count FROM release_files WHERE release_id = ? ORDER BY path')
      .bind(release.id)
      .all<FileRow>();
    if (files.results.length === 0) throw notFound('This release has no files');
    // Several files (or ?format=zip): the whole release as one streamed zip.
    if (files.results.length > 1 || c.req.query('format') === 'zip') {
      return serveZip(c, project, release, files.results);
    }
    file = files.results[0]!;
  }

  const filename = file.path.split('/').pop() ?? 'download';
  const etag = (await c.env.BUCKET.head(file.r2_key))?.httpEtag ?? `"${release.id}-${file.id}"`;
  if (c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const range = parseRange(c.req.header('range'), file.size);
  const obj = await c.env.BUCKET.get(
    file.r2_key,
    range ? { range: { offset: range.offset, length: range.length } } : undefined,
  );
  if (!obj) throw notFound('Stored object is missing; contact an admin');

  const headers = new Headers({
    'content-type': file.content_type || 'application/octet-stream',
    'content-disposition': `attachment; filename="${filename.replaceAll('"', '').replaceAll('\\', '')}"`,
    etag,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
  });
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`);
    headers.set('content-length', String(range.length));
  } else {
    headers.set('content-length', String(file.size));
  }

  const releaseId = release.id;
  const fileId = file.id;
  c.executionCtx.waitUntil(
    c.env.DB
      .batch([
        c.env.DB.prepare('UPDATE releases SET download_count = download_count + 1 WHERE id = ?').bind(releaseId),
        c.env.DB.prepare('UPDATE release_files SET download_count = download_count + 1 WHERE id = ?').bind(fileId),
      ])
      .then(() => {})
      .catch(() => {}),
  );

  return new Response(obj.body, { status: range ? 206 : 200, headers });
}

function serveZip(c: Context<AppEnv>, project: ProjectRow, release: ReleaseRow, files: FileRow[]): Response {
  const bucket = c.env.BUCKET;
  const plan = planZip(
    files.map((f) => ({
      name: f.path,
      size: f.size,
      open: async () => {
        const obj = await bucket.get(f.r2_key);
        if (!obj) throw new Error(`stored object missing for ${f.path}`);
        return obj.body;
      },
    })),
  );
  // FixedLengthStream lets the response carry content-length (curl shows real
  // progress) and aborts the transfer if the bytes ever disagree with the plan.
  const { readable, writable } = new FixedLengthStream(plan.size);
  c.executionCtx.waitUntil(
    zipStream(plan, new Date(release.published_at ?? Date.now()))
      .pipeTo(writable)
      .catch((err) => console.error('zip stream failed', project.slug, release.version, err)),
  );
  c.executionCtx.waitUntil(
    c.env.DB
      .prepare('UPDATE releases SET download_count = download_count + 1 WHERE id = ?')
      .bind(release.id)
      .run()
      .then(() => {})
      .catch(() => {}),
  );
  return new Response(readable, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${project.slug}-v${release.version}.zip"`,
      'cache-control': 'private, max-age=0, must-revalidate',
    },
  });
}

/**
 * Plain-text manifest for the curl-only pull script: "#key value" headers, then
 * one "<fingerprint>\t<size>\t<url-encoded path>" line per file. The fingerprint
 * is the upload digest, or for extracted files (no digest) the R2 ETag — content
 * derived, so a re-extracted but identical file isn't downloaded again.
 */
async function serveManifest(c: Context<AppEnv>): Promise<Response> {
  const { project, release } = await resolveRelease(c, 'latest');
  const files = await c.env.DB
    .prepare('SELECT path, r2_key, size, digest FROM release_files WHERE release_id = ? ORDER BY path')
    .bind(release.id)
    .all<{ path: string; r2_key: string; size: number; digest: string | null }>();
  const etags = await objectEtags(
    c.env.BUCKET,
    files.results.filter((f) => !f.digest).map((f) => f.r2_key),
  );
  const lines = [
    '#gitctx-manifest 1',
    `#project ${project.slug}`,
    `#version ${release.version}`,
    `#digest ${release.digest ?? ''}`,
  ];
  for (const f of files.results) {
    const etag = etags.get(f.r2_key);
    const fp = f.digest ? `sha:${f.digest}` : etag ? `etag:${etag}` : `size:${f.size}`;
    lines.push(`${fp}\t${f.size}\t${encodeURIComponent(f.path)}`);
  }
  return new Response(lines.join('\n') + '\n', {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** ETags for many keys via prefix listings — one call per 1000 objects, not one per key. */
async function objectEtags(bucket: R2Bucket, keys: string[]): Promise<Map<string, string>> {
  const wanted = new Set(keys);
  const out = new Map<string, string>();
  // Keys look like p/<pid>/r/<rid>[~sfx]/<path>; list each release prefix once.
  const prefixes = new Set(keys.map((k) => k.split('/').slice(0, 4).join('/') + '/'));
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) {
        if (wanted.has(obj.key)) out.set(obj.key, obj.etag);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return out;
}

function parseRange(header: string | null | undefined, size: number): { offset: number; length: number } | undefined {
  if (!header) return undefined;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd !== '') {
    const suffix = parseInt(rawEnd, 10);
    if (suffix <= 0) return undefined;
    return { offset: Math.max(0, size - suffix), length: Math.min(suffix, size) };
  }
  if (rawStart !== '') {
    const start = parseInt(rawStart, 10);
    if (start >= size) return undefined;
    const end = rawEnd !== '' ? Math.min(parseInt(rawEnd, 10), size - 1) : size - 1;
    if (end < start) return undefined;
    return { offset: start, length: end - start + 1 };
  }
  return undefined;
}
