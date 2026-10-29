import { Hono, type Context } from 'hono';
import { audit } from '../lib/audit';
import { maybeStartExtraction } from '../lib/extract';
import { badRequest, conflict, notFound, tooLarge } from '../lib/http';
import { nowMs, randomId, sanitizeFilePath, sha256Hex } from '../lib/ids';
import { MAX_OBJECT_BYTES, S3Storage, partSizeFor } from '../lib/s3';
import { deleteUnreferencedObjects, writeKeyFor } from '../lib/r2refs';
import { requireRole, sessionUser, type AppEnv } from '../middleware';
import { getBucket } from '../lib/storage';

type UploadRow = {
  id: string;
  release_id: string;
  file_id: string | null;
  r2_key: string;
  size: number;
  part_size: number;
  total_parts: number;
  mode: 'presigned' | 'single';
  s3_upload_id: string | null;
  status: 'active' | 'completed' | 'aborted';
  created_by: string;
  created_at: number;
  updated_at: number;
};

async function loadUpload(db: D1Database, id: string): Promise<UploadRow> {
  const row = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?').bind(id).first<UploadRow>();
  if (!row) throw notFound('Upload session not found');
  return row;
}

type PresignedUpload = UploadRow & { mode: 'presigned'; s3_upload_id: string };

async function loadPresignedUpload(db: D1Database, id: string): Promise<PresignedUpload> {
  const upload = await loadUpload(db, id);
  if (upload.status === 'completed') throw conflict('Upload already completed');
  if (upload.status !== 'active') throw conflict(`Upload is ${upload.status}`);
  if (upload.mode !== 'presigned' || !upload.s3_upload_id) throw badRequest('Not a presigned multipart upload');
  return upload as PresignedUpload;
}

/** The release-relative file path; upload keys are `p/<project>/r/<release>/<path>`. */
function uploadPath(r2Key: string): string {
  return r2Key.split('/').slice(4).join('/');
}

async function loadDraftRelease(db: D1Database, releaseId: string) {
  const row = await db
    .prepare(
      `SELECT r.id, r.version, r.status, r.project_id, p.slug FROM releases r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`,
    )
    .bind(releaseId)
    .first<{ id: string; version: string; status: string; project_id: string; slug: string }>();
  if (!row) throw notFound('Release not found');
  if (row.status !== 'draft') throw conflict(`Version ${row.version} is already published and immutable`);
  return row;
}

export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.use('*', requireRole('admin', 'uploader'));

function singleUploadLimit(env: Env): number {
  const mb = parseInt(env.MAX_SINGLE_UPLOAD_MB, 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 90) * 1024 * 1024;
}

uploadRoutes.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { releaseId, path, size, sha256 } = (body ?? {}) as {
    releaseId?: string;
    path?: string;
    size?: number;
    sha256?: string;
  };
  if (!releaseId || !path || typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw badRequest('releaseId, path and integer size are required');
  }
  if (size > MAX_OBJECT_BYTES) throw tooLarge('Files above ~4.4 TiB cannot be stored');
  const cleanPath = sanitizeFilePath(path);
  if (!cleanPath) throw badRequest('Invalid file path');
  const release = await loadDraftRelease(c.env.DB, releaseId);

  const prevFile = await c.env.DB
    .prepare('SELECT id, r2_key FROM release_files WHERE release_id = ? AND path = ?')
    .bind(releaseId, cleanPath)
    .first<{ id: string; r2_key: string }>();
  if (prevFile) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM release_files WHERE id = ?').bind(prevFile.id),
      c.env.DB.prepare('DELETE FROM upload_sessions WHERE file_id = ?').bind(prevFile.id),
    ]);
    c.executionCtx.waitUntil(deleteUnreferencedObjects(c.env.DB, getBucket(c.env), [prevFile.r2_key]));
  }
  const stale = await c.env.DB
    .prepare("SELECT id, mode, s3_upload_id FROM upload_sessions WHERE release_id = ? AND status = 'active' AND r2_key = ?")
    .bind(releaseId, `p/${release.project_id}/r/${release.id}/${cleanPath}`)
    .all<{ id: string; mode: string; s3_upload_id: string | null }>();
  if (stale.results.length > 0) {
    void (async () => {
      for (const s of stale.results) {
        if (s.mode === 'presigned' && s.s3_upload_id) {
          await new S3Storage(c.env).abort(`p/${release.project_id}/r/${release.id}/${cleanPath}`, s.s3_upload_id).catch(() => {});
        }
      }
      await c.env.DB
        .prepare("UPDATE upload_sessions SET status = 'aborted' WHERE id IN (" + stale.results.map(() => '?').join(',') + ")")
        .bind(...stale.results.map((s) => s.id))
        .run()
        .catch(() => {});
    })();
  }

  const id = randomId(12);
  const r2Key = await writeKeyFor(c.env.DB, release.project_id, release.id, cleanPath, id);
  const limit = singleUploadLimit(c.env);
  const s3 = new S3Storage(c.env);
  const now = nowMs();

  if (size <= limit) {
    await c.env.DB
      .prepare('INSERT INTO upload_sessions (id, release_id, r2_key, size, part_size, total_parts, mode, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
      .bind(id, releaseId, r2Key, size, size, 'single', 'active', sessionUser(c).id, now, now)
      .run();
    return c.json({ uploadId: id, mode: 'single' as const, partSize: size, totalParts: 1, sha256: sha256 ?? null }, 201);
  }

  if (!s3.enabled) {
    throw badRequest(
      `Files above ${Math.round(limit / 1024 / 1024)} MB need presigned multipart uploads, which require R2 S3 credentials (R2_S3_ACCOUNT_ID var + R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY secrets). Configure them and redeploy.`,
    );
  }
  const partSize = partSizeFor(size);
  const totalParts = Math.ceil(size / partSize);
  const s3UploadId = await s3.initiate(r2Key);
  await c.env.DB
    .prepare('INSERT INTO upload_sessions (id, release_id, r2_key, size, part_size, total_parts, mode, s3_upload_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, releaseId, r2Key, size, partSize, totalParts, 'presigned', s3UploadId, 'active', sessionUser(c).id, now, now)
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'upload.start', `project:${release.slug}/v${release.version}/${cleanPath}`, { size, mode: 'presigned' });
  return c.json({ uploadId: id, mode: 'presigned' as const, partSize, totalParts }, 201);
});

uploadRoutes.post('/:id/parts', async (c) => {
  const upload = await loadPresignedUpload(c.env.DB, c.req.param('id'));
  const body = await c.req
    .json<{ parts?: Array<{ n?: number; sha256?: string }>; contentType?: unknown }>()
    .catch(() => null);
  const parts = body?.parts;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 1000) {
    throw badRequest('Provide 1–1000 parts per batch');
  }
  const contentType =
    typeof body?.contentType === 'string' && body.contentType.length > 0 && body.contentType.length <= 255
      ? body.contentType
      : 'application/octet-stream';
  for (const p of parts) {
    if (typeof p.n !== 'number' || p.n < 1 || p.n > upload.total_parts || typeof p.sha256 !== 'string') {
      throw badRequest('Each part needs a number within range and a base64 SHA-256');
    }
  }
  const s3 = new S3Storage(c.env);
  const urls = await Promise.all(
    parts.map(async (p) => ({ n: p.n!, url: await s3.presignPart(upload.r2_key, upload.s3_upload_id, p.n!, contentType) })),
  );
  return c.json({ urls });
});

uploadRoutes.put('/:id/body', async (c) => {
  const upload = await loadUpload(c.env.DB, c.req.param('id'));
  if (upload.status !== 'active') throw conflict(`Upload is ${upload.status}`);
  if (upload.mode !== 'single') throw badRequest('This session expects multipart parts, not a single body');
  if (!c.req.raw.body) throw badRequest('A request body is required');
  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  await getBucket(c.env).put(upload.r2_key, c.req.raw.body, {
    httpMetadata: { contentType },
  });
  const extraction = await completeUpload(c, upload, null, []);
  return c.json({ ok: true, size: upload.size, extraction });
});

uploadRoutes.post('/:id/complete', async (c) => {
  const upload = await loadPresignedUpload(c.env.DB, c.req.param('id'));
  const body = await c.req.json<{ parts?: Array<{ n?: number; etag?: string; sha256?: string }> }>().catch(() => null);
  const parts = body?.parts;
  if (!Array.isArray(parts) || parts.length !== upload.total_parts) {
    throw badRequest(`Expected ${upload.total_parts} parts, got ${parts?.length ?? 0}`);
  }
  const sorted = [...parts].sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (p.n !== i + 1 || typeof p.etag !== 'string' || !p.etag) {
      throw badRequest(`Part ${i + 1} is missing or out of order`);
    }
    if (typeof p.sha256 !== 'string') throw badRequest(`Part ${i + 1} is missing its SHA-256`);
  }
  const s3 = new S3Storage(c.env);
  await s3.complete(
    upload.r2_key,
    upload.s3_upload_id,
    sorted.map((p) => ({ n: p.n!, etag: p.etag! })),
  );
  const head = await getBucket(c.env).head(upload.r2_key);
  if (!head) throw badRequest('R2 did not retain the assembled object; retry the upload');
  if (head.size !== upload.size) {
    await getBucket(c.env).delete(upload.r2_key);
    throw badRequest(`Assembled size ${head.size} does not match the declared ${upload.size}; retry the upload`);
  }
  const partDigests = sorted.map((p) => ({ n: p.n!, sha256: p.sha256! }));
  const digest = await sha256Hex(partDigests.map((p) => p.sha256).join(''));
  const extraction = await completeUpload(c, upload, digest, partDigests);
  return c.json({ ok: true, size: upload.size, digest, extraction });
});

uploadRoutes.post('/:id/resume', async (c) => {
  const upload = await loadPresignedUpload(c.env.DB, c.req.param('id'));
  const s3 = new S3Storage(c.env);
  const parts = await s3.listParts(upload.r2_key, upload.s3_upload_id);
  return c.json({ parts, partSize: upload.part_size, totalParts: upload.total_parts });
});

uploadRoutes.post('/:id/abort', async (c) => {
  const upload = await loadUpload(c.env.DB, c.req.param('id'));
  if (upload.status === 'active') {
    if (upload.mode === 'presigned' && upload.s3_upload_id) {
      await new S3Storage(c.env).abort(upload.r2_key, upload.s3_upload_id).catch(() => {});
    } else {
      await getBucket(c.env).delete(upload.r2_key);
    }
    await c.env.DB.prepare("UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?").bind(nowMs(), upload.id).run();
  }
  return c.json({ ok: true });
});

uploadRoutes.get('/', async (c) => {
  const releaseId = c.req.query('releaseId');
  if (!releaseId) throw badRequest('releaseId query parameter is required');
  await loadDraftRelease(c.env.DB, releaseId);
  const rows = await c.env.DB
    .prepare(
      "SELECT id, release_id, r2_key, size, part_size, total_parts, mode, status, created_at FROM upload_sessions WHERE release_id = ? AND status = 'active' ORDER BY created_at",
    )
    .bind(releaseId)
    .all();
  return c.json({
    uploads: rows.results.map((u) => ({
      ...u,
      path: uploadPath((u as { r2_key: string }).r2_key),
    })),
  });
});

/** Records the stored object as a release file, audits it and starts extraction for archives. */
async function completeUpload(
  c: Context<AppEnv>,
  upload: UploadRow,
  digest: string | null,
  partDigests: Array<{ n: number; sha256: string }>,
) {
  await finalizeFile(c.env, upload, digest, partDigests);
  await audit(c.env.DB, sessionUser(c).email, 'upload.complete', upload.r2_key, { size: upload.size, mode: upload.mode });
  return maybeStartExtraction(c.env, (p) => c.executionCtx.waitUntil(p), {
    origin: new URL(c.req.url).origin,
    releaseId: upload.release_id,
    path: uploadPath(upload.r2_key),
    r2Key: upload.r2_key,
    userId: sessionUser(c).id,
  });
}

async function finalizeFile(
  env: Env,
  upload: UploadRow,
  digest: string | null,
  partDigests: Array<{ n: number; sha256: string }>,
): Promise<void> {
  const path = uploadPath(upload.r2_key);
  const fileRow = await env.DB
    .prepare('SELECT id FROM release_files WHERE release_id = ? AND path = ?')
    .bind(upload.release_id, path)
    .first<{ id: string }>();
  const now = nowMs();
  if (fileRow) {
    await env.DB.batch([
      env.DB
        .prepare('UPDATE release_files SET r2_key = ?, size = ?, digest = ?, part_digests = ?, created_at = ? WHERE id = ?')
        .bind(upload.r2_key, upload.size, digest, JSON.stringify(partDigests), now, fileRow.id),
      env.DB
        .prepare("UPDATE upload_sessions SET status = 'completed', file_id = ?, updated_at = ? WHERE id = ?")
        .bind(fileRow.id, now, upload.id),
    ]);
  } else {
    const fileId = randomId(12);
    await env.DB.batch([
      env.DB
        .prepare('INSERT INTO release_files (id, release_id, path, r2_key, size, content_type, digest, part_digests, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(fileId, upload.release_id, path, upload.r2_key, upload.size, 'application/octet-stream', digest, JSON.stringify(partDigests), now),
      env.DB
        .prepare("UPDATE upload_sessions SET status = 'completed', file_id = ?, updated_at = ? WHERE id = ?")
        .bind(fileId, now, upload.id),
    ]);
  }
}
