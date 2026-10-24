import { Hono, type Context } from 'hono';
import { forbidden, notFound } from '../lib/http';
import { requireAuthAny, type AppEnv } from '../middleware';

type ProjectRow = { id: string; slug: string; name: string };
type ReleaseRow = { id: string; version: string; status: string; published_at: number | null };
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

async function serveRelease(c: Context<AppEnv>, which: string): Promise<Response> {
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
            "SELECT id, version, status, published_at FROM releases WHERE project_id = ? AND status = 'published' ORDER BY is_latest DESC, published_at DESC LIMIT 1",
          )
          .bind(project.id)
          .first<ReleaseRow>()
      : await c.env.DB
          .prepare(
            "SELECT id, version, status, published_at FROM releases WHERE project_id = ? AND version = ? AND status = 'published'",
          )
          .bind(project.id, which)
          .first<ReleaseRow>();
  if (!release) throw notFound('Release not found');

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
    if (files.results.length > 1) {
      return Response.json(
        {
          error: 'release_has_multiple_files',
          message:
            `This release contains several files. Download one with ?path=<file>, or fetch the manifest at ` +
            `/api/projects/${project.slug}/releases/latest for the full list.`,
          files: files.results.map((f) => f.path),
        },
        { status: 409 },
      );
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
