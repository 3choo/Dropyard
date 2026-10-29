import { Hono, type Context } from 'hono';
import { ApiError, attachment, badRequest, notFound } from '../lib/http';
import { pullScript } from '../lib/pullscript';
import { S3Storage } from '../lib/s3';
import { planZip, zipStream } from '../lib/zipstream';
import { requireAuthAny, type AppEnv } from '../middleware';
import { loadProject, type ProjectRow } from './projects';
import { getBucket } from '../lib/storage';

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
dlRoutes.post('/:slug/v/:version/links', requireAuthAny(), (c) => serveLinks(c));
dlRoutes.get('/:slug/pull.sh', requireAuthAny(), async (c) => {
  const { project } = await resolveRelease(c, 'latest');
  const authz = c.req.header('authorization');
  const token = authz?.startsWith('Bearer ') ? authz.slice(7).trim() : (c.req.query('token') ?? '');
  const script = pullScript(new URL(c.req.url).origin, project.slug, c.get('auth').kind === 'token' ? token : '');
  return new Response(script, {
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' },
  });
});

async function resolveRelease(c: Context<AppEnv>, which: string): Promise<{ project: ProjectRow; release: ReleaseRow }> {
  const project = await loadProject(c);
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
    if (files.results.length > 1 || c.req.query('format') === 'zip') {
      return serveZip(c, project, release, files.results);
    }
    file = files.results[0]!;
  }

  const s3 = new S3Storage(c.env);
  if (c.req.query('direct') === '1' && s3.enabled) {
    countFileDownload(c, release.id, file.id);
    return new Response(null, {
      status: 302,
      headers: { location: await s3.presignGet(file.r2_key), 'cache-control': 'no-store' },
    });
  }

  const filename = file.path.split('/').pop() ?? 'download';
  const etag = (await getBucket(c.env).head(file.r2_key))?.httpEtag ?? `"${release.id}-${file.id}"`;
  if (c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const range = parseRange(c.req.header('range'), file.size);
  const obj = await getBucket(c.env).get(
    file.r2_key,
    range ? { range: { offset: range.offset, length: range.length } } : undefined,
  );
  if (!obj) throw notFound('Stored object is missing; contact an admin');

  const headers = new Headers({
    'content-type': file.content_type || 'application/octet-stream',
    'content-disposition': attachment(filename),
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

  countFileDownload(c, release.id, file.id);
  return new Response(obj.body, { status: range ? 206 : 200, headers });
}

function countFileDownload(c: Context<AppEnv>, releaseId: string, fileId: string): void {
  c.executionCtx.waitUntil(
    c.env.DB
      .batch([
        c.env.DB.prepare('UPDATE releases SET download_count = download_count + 1 WHERE id = ?').bind(releaseId),
        c.env.DB.prepare('UPDATE release_files SET download_count = download_count + 1 WHERE id = ?').bind(fileId),
      ])
      .catch(() => {}),
  );
}

function countReleaseDownload(c: Context<AppEnv>, releaseId: string): void {
  c.executionCtx.waitUntil(
    c.env.DB
      .prepare('UPDATE releases SET download_count = download_count + 1 WHERE id = ?')
      .bind(releaseId)
      .run()
      .catch(() => {}),
  );
}

function serveZip(c: Context<AppEnv>, project: ProjectRow, release: ReleaseRow, files: FileRow[]): Response {
  const bucket = getBucket(c.env);
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
  const { readable, writable } = new FixedLengthStream(plan.size);
  c.executionCtx.waitUntil(
    zipStream(plan, new Date(release.published_at ?? Date.now()))
      .pipeTo(writable)
      .catch((err) => console.error('zip stream failed', project.slug, release.version, err)),
  );
  countReleaseDownload(c, release.id);
  return new Response(readable, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': attachment(`${project.slug}-v${release.version}.zip`),
      'cache-control': 'private, max-age=0, must-revalidate',
    },
  });
}

async function serveManifest(c: Context<AppEnv>): Promise<Response> {
  const { project, release } = await resolveRelease(c, 'latest');
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  const cacheKey = `p/${project.id}/r/${release.id}~manifest-v1.txt`;
  const cached = await getBucket(c.env).get(cacheKey);
  if (cached) return new Response(cached.body, { headers });

  const files = await c.env.DB
    .prepare('SELECT path, r2_key, size, digest FROM release_files WHERE release_id = ? ORDER BY path')
    .bind(release.id)
    .all<{ path: string; r2_key: string; size: number; digest: string | null }>();
  const etags = await objectEtags(
    getBucket(c.env),
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
  const text = lines.join('\n') + '\n';
  if (files.results.every((f) => f.digest || etags.has(f.r2_key))) {
    c.executionCtx.waitUntil(getBucket(c.env).put(cacheKey, text).then(() => {}).catch(() => {}));
  }
  return new Response(text, { headers });
}

const MAX_LINKS = 250_000;
const LINK_TTL_SECONDS = 12 * 60 * 60;

async function serveLinks(c: Context<AppEnv>): Promise<Response> {
  const s3 = new S3Storage(c.env);
  if (!s3.enabled) {
    throw new ApiError(501, 'direct_unavailable', 'Direct R2 links need the R2 S3 API credentials on the Worker');
  }
  const { release } = await resolveRelease(c, c.req.param('version') ?? '');
  const wanted = (await c.req.text()).split('\n').filter(Boolean);
  if (wanted.length > MAX_LINKS) throw badRequest(`At most ${MAX_LINKS} paths per request`);

  const files = await c.env.DB
    .prepare('SELECT path, r2_key FROM release_files WHERE release_id = ?')
    .bind(release.id)
    .all<{ path: string; r2_key: string }>();
  const keyByPath = new Map(files.results.map((f) => [f.path, f.r2_key]));

  const out: string[] = [];
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    const signed = await Promise.all(
      chunk.map(async (enc) => {
        let path: string;
        try {
          path = decodeURIComponent(enc);
        } catch {
          return null;
        }
        const key = keyByPath.get(path);
        return key ? `${enc}\t${await s3.presignGet(key, LINK_TTL_SECONDS)}` : null;
      }),
    );
    for (const line of signed) if (line) out.push(line);
  }

  countReleaseDownload(c, release.id);
  return new Response(out.join('\n') + '\n', {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function objectEtags(bucket: R2Bucket, keys: string[]): Promise<Map<string, string>> {
  const wanted = new Set(keys);
  const out = new Map<string, string>();
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
