import { getContainer, Container } from '@cloudflare/containers';
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from 'fflate';
import { nowMs, randomId, sanitizeFilePath } from './ids';
import { contentTypeForPath } from './mime';
import { R2S3 } from './r2s3';

const MB = 1024 * 1024;
/** Server-side part size when streaming a big entry into R2 multipart. */
const EXTRACT_PART_BYTES = 8 * MB;

export type ArchiveVolume = { path: string; r2Key: string };

export type ExtractJobRow = {
  id: string;
  release_id: string;
  kind: 'zip' | 'rar';
  archive_paths: string; // json: ArchiveVolume[]
  status: 'queued' | 'running' | 'done' | 'failed';
  files_added: number;
  bytes_added: number;
  error: string | null;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
};

type UnpackCaps = { files: number; fileBytes: number; totalBytes: number };

function unpackCaps(env: Env): UnpackCaps {
  const int = (v: string | undefined, fallback: number) => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    files: int(env.MAX_UNPACK_FILES, 20_000),
    fileBytes: int(env.MAX_UNPACK_FILE_MB, 5 * 1024) * MB,
    totalBytes: int(env.MAX_UNPACK_TOTAL_MB, 50 * 1024) * MB,
  };
}

/**
 * What kind of archive is this file?
 * - zip / rar: extract on upload completion
 * - rar-part: a continuation volume (.part2.rar, .r00…); never auto-starts,
 *   it is picked up when the first volume's job runs (or via Retry).
 * - null: not an archive.
 */
export function detectArchive(path: string): 'zip' | 'rar' | 'rar-part' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.rar')) return 'rar';
  if (/\.r\d{2}$/.test(lower)) return 'rar-part';
  if (/\.part\d+\.rar$/.test(lower)) return 'rar-part';
  return null;
}

/** RAR volume family: "pack.part2.rar", "pack.rar" and "pack.r00" all belong to "pack". */
function volumeFamily(path: string): string {
  return path.replace(/\.(part\d+\.rar|r\d{2}|rar)$/i, '');
}

function parseVolumes(json: string): ArchiveVolume[] {
  try {
    const parsed = JSON.parse(json) as ArchiveVolume[];
    return Array.isArray(parsed)
      ? parsed.filter((v) => v && typeof v.path === 'string' && typeof v.r2Key === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The release's R2 key prefix, derived from a volume key: p/<project>/r/<release>/. */
function prefixFromVolume(volume: ArchiveVolume): string {
  return volume.r2Key.slice(0, volume.r2Key.length - volume.path.length);
}

function prefixFromKey(r2Key: string, path: string): string {
  return r2Key.slice(0, r2Key.length - path.length);
}

async function loadJob(db: D1Database, jobId: string): Promise<ExtractJobRow | null> {
  return db.prepare('SELECT * FROM extract_jobs WHERE id = ?').bind(jobId).first<ExtractJobRow>();
}

async function loadDraftReleaseRow(db: D1Database, releaseId: string) {
  return db
    .prepare('SELECT id, project_id, status FROM releases WHERE id = ?')
    .bind(releaseId)
    .first<{ id: string; project_id: string; status: string }>();
}

/**
 * Called after an upload is finalized. Creates an extract job for archives and
 * kicks off the right engine; returns what the API should report to the client.
 */
export async function maybeStartExtraction(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  opts: { origin: string; releaseId: string; path: string; r2Key: string; userId: string | null },
): Promise<{ id: string; kind: 'zip' | 'rar' } | null> {
  const detected = detectArchive(opts.path);
  if (!detected || detected === 'rar-part') return null;
  const kind = detected;

  // A re-upload replaces an archive that may still be extracting: kill that job.
  const active = await env.DB
    .prepare("SELECT id, archive_paths FROM extract_jobs WHERE release_id = ? AND status IN ('queued','running')")
    .bind(opts.releaseId)
    .all<{ id: string; archive_paths: string }>();
  for (const job of active.results) {
    if (parseVolumes(job.archive_paths).some((v) => v.r2Key === opts.r2Key)) {
      await failJob(env, job.id, 'The archive was replaced by a re-upload');
    }
  }

  const volumes: ArchiveVolume[] = [{ path: opts.path, r2Key: opts.r2Key }];
  if (kind === 'rar') {
    // Pick up every sibling volume already uploaded to this release.
    const rows = await env.DB
      .prepare('SELECT path, r2_key FROM release_files WHERE release_id = ?')
      .bind(opts.releaseId)
      .all<{ path: string; r2_key: string }>();
    const family = volumeFamily(opts.path);
    for (const row of rows.results) {
      if (row.path !== opts.path && volumeFamily(row.path) === family && detectArchive(row.path) === 'rar-part') {
        volumes.push({ path: row.path, r2Key: row.r2_key });
      }
    }
    volumes.sort((a, b) => a.path.localeCompare(b.path));
  }

  const jobId = randomId(12);
  await env.DB
    .prepare(
      'INSERT INTO extract_jobs (id, release_id, kind, archive_paths, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(jobId, opts.releaseId, kind, JSON.stringify(volumes), 'queued', opts.userId, nowMs())
    .run();

  const prefix = prefixFromKey(opts.r2Key, opts.path);
  if (kind === 'zip') {
    waitUntil(runZipExtraction(env, jobId, opts.releaseId, volumes, prefix).catch(() => {}));
  } else {
    waitUntil(runRarExtraction(env, jobId, volumes, prefix, opts.origin).catch(() => {}));
  }
  return { id: jobId, kind };
}

/** Re-run a failed job (Retry button): fresh job, fresh volume scan. */
export async function retryExtraction(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  opts: { origin: string; jobId: string },
): Promise<ExtractJobRow> {
  const old = await loadJob(env.DB, opts.jobId);
  if (!old) throw new Error('Extraction job not found');
  if (old.status !== 'failed') throw new Error('Only failed extractions can be retried');
  const release = await loadDraftReleaseRow(env.DB, old.release_id);
  if (!release || release.status !== 'draft') throw new Error('The release is no longer a draft');

  const oldVolumes = parseVolumes(old.archive_paths);
  if (oldVolumes.length === 0) throw new Error('The original archive is gone; re-upload it');
  const archivePath = oldVolumes[0]!.path;

  let volumes: ArchiveVolume[];
  if (old.kind === 'zip') {
    volumes = oldVolumes;
  } else {
    const rows = await env.DB
      .prepare('SELECT path, r2_key FROM release_files WHERE release_id = ?')
      .bind(old.release_id)
      .all<{ path: string; r2_key: string }>();
    const family = volumeFamily(archivePath);
    volumes = rows.results
      .filter((r) => volumeFamily(r.path) === family && detectArchive(r.path) !== null)
      .map((r) => ({ path: r.path, r2Key: r.r2_key }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (!volumes.some((v) => v.path === archivePath)) {
      throw new Error('The first RAR volume is gone; re-upload the archive');
    }
  }

  const jobId = randomId(12);
  const prefix = prefixFromVolume(volumes[0]!);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM extract_jobs WHERE id = ?').bind(old.id),
    env.DB.prepare(
      'INSERT INTO extract_jobs (id, release_id, kind, archive_paths, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(jobId, old.release_id, old.kind, JSON.stringify(volumes), 'queued', old.created_by, nowMs()),
  ]);

  if (old.kind === 'zip') {
    waitUntil(runZipExtraction(env, jobId, old.release_id, volumes, prefix).catch(() => {}));
  } else {
    waitUntil(runRarExtraction(env, jobId, volumes, prefix, opts.origin).catch(() => {}));
  }
  return (await loadJob(env.DB, jobId))!;
}

// --- Job lifecycle ---------------------------------------------------------------

async function markRunning(db: D1Database, jobId: string): Promise<void> {
  await db.prepare("UPDATE extract_jobs SET status = 'running' WHERE id = ? AND status = 'queued'").bind(jobId).run();
}

async function completeJob(env: Env, jobId: string): Promise<void> {
  const job = await loadJob(env.DB, jobId);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
  // The user chose to drop the archive once its contents are in the release.
  for (const volume of parseVolumes(job.archive_paths)) {
    await env.DB
      .prepare('DELETE FROM release_files WHERE release_id = ? AND path = ?')
      .bind(job.release_id, volume.path)
      .run();
    await env.BUCKET.delete(volume.r2Key);
  }
  await env.DB
    .prepare("UPDATE extract_jobs SET status = 'done', finished_at = ? WHERE id = ?")
    .bind(nowMs(), jobId)
    .run();
}

/** Remove every file a job produced, then mark it failed. No-op unless the job was live. */
export async function failJob(env: Env, jobId: string, message: string): Promise<void> {
  const job = await loadJob(env.DB, jobId);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
  await cleanupExtractedFiles(env, jobId);
  await env.DB
    .prepare("UPDATE extract_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
    .bind(message.slice(0, 1000), nowMs(), jobId)
    .run();
}

async function cleanupExtractedFiles(env: Env, jobId: string): Promise<void> {
  const rows = await env.DB
    .prepare('SELECT id, r2_key FROM release_files WHERE extract_job_id = ?')
    .bind(jobId)
    .all<{ id: string; r2_key: string }>();
  if (rows.results.length > 0) {
    await env.BUCKET.delete(rows.results.map((r) => r.r2_key));
    await env.DB.prepare('DELETE FROM release_files WHERE extract_job_id = ?').bind(jobId).run();
  }
  await env.DB.prepare('UPDATE extract_jobs SET files_added = 0, bytes_added = 0 WHERE id = ?').bind(jobId).run();
}

/** Insert one extracted file row; replaces any previous file at the same path. */
async function insertExtractedFile(
  env: Env,
  jobId: string,
  releaseId: string,
  r2Key: string,
  path: string,
  size: number,
  contentType: string,
  caps: UnpackCaps,
): Promise<void> {
  const stats = await env.DB
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM release_files WHERE extract_job_id = ?')
    .bind(jobId)
    .first<{ n: number; bytes: number }>();
  if ((stats?.n ?? 0) + 1 > caps.files) {
    throw new Error(`Archive exceeds the ${caps.files} file unpack limit (MAX_UNPACK_FILES)`);
  }
  if (size > caps.fileBytes) {
    throw new Error(`File ${path} exceeds the per-file unpack limit (MAX_UNPACK_FILE_MB)`);
  }
  if ((stats?.bytes ?? 0) + size > caps.totalBytes) {
    throw new Error('Archive exceeds the total unpack size limit (MAX_UNPACK_TOTAL_MB)');
  }
  const now = nowMs();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM release_files WHERE release_id = ? AND path = ?').bind(releaseId, path),
    env.DB
      .prepare(
        "INSERT INTO release_files (id, release_id, path, r2_key, size, content_type, part_digests, created_at, extract_job_id) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)",
      )
      .bind(randomId(12), releaseId, path, r2Key, size, contentType, now, jobId),
    env.DB
      .prepare('UPDATE extract_jobs SET files_added = files_added + 1, bytes_added = bytes_added + ? WHERE id = ?')
      .bind(size, jobId),
  ]);
}

// --- ZIP: stream-extract inside the Worker ----------------------------------------

class CapError extends Error {}

type EntrySink = { write: (data: Uint8Array) => Promise<void>; end: () => Promise<void> };

function noopSink(): EntrySink {
  return { write: async () => {}, end: async () => {} };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function runZipExtraction(
  env: Env,
  jobId: string,
  releaseId: string,
  volumes: ArchiveVolume[],
  prefix: string,
): Promise<void> {
  await markRunning(env.DB, jobId);
  const archive = volumes[0]!;
  const caps = unpackCaps(env);
  const s3 = new R2S3(env);
  // Multipart state of the entry currently in flight, so a failure can abort it.
  let liveUploadId: string | null = null;
  let liveKey: string | null = null;

  try {
    const obj = await env.BUCKET.get(archive.r2Key);
    if (!obj) throw new Error('The zip object is no longer in storage');

    let chain: Promise<void> = Promise.resolve();
    let streamError: unknown = null;

    const unzipper = new Unzip((file) => {
      const sink = openEntrySink(file);
      file.ondata = (err, data, final) => {
        const next = chain
          .then(async () => {
            if (err) throw err;
            if (streamError) throw streamError;
            if (data && data.length > 0) await sink.write(data);
            if (final) await sink.end();
          })
          .catch((e) => {
            streamError = streamError ?? e;
          });
        chain = next;
      };
      file.start();
    });
    unzipper.register(UnzipInflate);
    unzipper.register(UnzipPassThrough);

    // Push the R2 stream through the unzipper; awaiting `chain` after each chunk
    // keeps decompression from outrunning the R2 writes (bounded memory).
    const reader = obj.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      unzipper.push(value, false);
      await chain;
      if (streamError) throw streamError;
    }
    unzipper.push(new Uint8Array(0), true);
    await chain;
    if (streamError) throw streamError;

    await completeJob(env, jobId);
    return;

    function openEntrySink(file: UnzipFile): EntrySink {
      const isDir = file.name.endsWith('/');
      const clean = isDir ? null : sanitizeFilePath(file.name);
      if (!clean) return noopSink(); // directory marker or unsafe path: drain and drop

      if (file.originalSize !== undefined && file.originalSize > caps.fileBytes) {
        throw new CapError(`File ${clean} exceeds the per-file unpack limit (MAX_UNPACK_FILE_MB)`);
      }
      const destKey = prefix + clean;
      const contentType = contentTypeForPath(clean);
      let uploadId: string | null = null;
      const etags: Array<{ n: number; etag: string }> = [];
      let pending: Uint8Array[] = [];
      let pendingLen = 0;
      let entryBytes = 0;
      let ended = false;

      const trackUpload = (id: string | null): void => {
        uploadId = id;
        liveUploadId = id;
        liveKey = id ? destKey : null;
      };

      const ensureUpload = async (): Promise<void> => {
        if (uploadId === null) trackUpload(await s3.initiate(destKey));
      };

      const flush = async (final: boolean): Promise<void> => {
        const chunk = concat(pending, pendingLen);
        pending = [];
        pendingLen = 0;
        if (final && uploadId === null) {
          // Entire entry fit in the buffer: one plain put.
          await env.BUCKET.put(destKey, chunk, { httpMetadata: { contentType } });
          await insertExtractedFile(env, jobId, releaseId, destKey, clean, chunk.length, contentType, caps);
          return;
        }
        if (chunk.length > 0) {
          await ensureUpload();
          const n = etags.length + 1;
          const etag = await s3.uploadPart(destKey, uploadId!, n, toArrayBuffer(chunk));
          etags.push({ n, etag });
        }
        if (final) {
          // Entry sizes that are exact multiples of the part size arrive here
          // with no remainder; complete with the parts collected so far.
          await ensureUpload();
          await s3.complete(destKey, uploadId!, etags);
          liveUploadId = null;
          liveKey = null;
          await insertExtractedFile(env, jobId, releaseId, destKey, clean, entryBytes, contentType, caps);
        }
      };

      return {
        async write(data) {
          if (ended) throw new Error('entry already ended');
          entryBytes += data.length;
          if (entryBytes > caps.fileBytes) {
            throw new CapError(`File ${clean} exceeds the per-file unpack limit (MAX_UNPACK_FILE_MB)`);
          }
          pending.push(data);
          pendingLen += data.length;
          if (pendingLen >= EXTRACT_PART_BYTES) {
            await ensureUpload();
            await flush(false);
          }
        },
        async end() {
          if (ended) return;
          ended = true;
          if (entryBytes === 0) {
            await env.BUCKET.put(destKey, new Uint8Array(0), { httpMetadata: { contentType } });
            await insertExtractedFile(env, jobId, releaseId, destKey, clean, 0, contentType, caps);
            return;
          }
          await flush(true);
        },
      };
    }
  } catch (err) {
    if (liveUploadId && liveKey) await s3.abort(liveKey, liveUploadId).catch(() => {});
    await failJob(env, jobId, err instanceof Error ? err.message : 'ZIP extraction failed').catch(() => {});
  }
}

// --- RAR: hand off to the extraction container ------------------------------------

async function runRarExtraction(
  env: Env,
  jobId: string,
  volumes: ArchiveVolume[],
  prefix: string,
  origin: string,
): Promise<void> {
  await markRunning(env.DB, jobId);
  try {
    const secret = env.EXTRACT_CALLBACK_SECRET;
    if (!secret) throw new Error('EXTRACT_CALLBACK_SECRET is not configured; RAR extraction is unavailable');
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      throw new Error(
        'RAR extraction needs the R2 S3 credentials (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) so the container can read and write storage',
      );
    }

    const runner = getContainer(env.EXTRACT_RUNNER, jobId);
    await runner.start();
    const payload = {
      jobId,
      prefix,
      volumes,
      caps: unpackCaps(env),
      callbackUrl: `${origin}/api/internal/extract`,
      secret,
      r2: {
        accountId: env.R2_S3_ACCOUNT_ID,
        bucket: env.R2_BUCKET_NAME,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    };
    const res = await runner.fetch('http://gitctx-extract/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Extraction container rejected the job: ${res.status} ${text.slice(0, 300)}`);
    }
    // The container reports progress via /api/internal/extract and finishes the job.
  } catch (err) {
    await failJob(env, jobId, err instanceof Error ? err.message : 'RAR extraction failed').catch(() => {});
  }
}

// --- Container durable object -------------------------------------------------------

/**
 * One instance per extract job (idFromName(jobId)). When the container exits —
 * crash, OOM or idle shutdown — any job still marked running has died with it.
 */
export class ExtractRunner extends Container {
  defaultPort = 8080;
  sleepAfter = '30m';

  override async onStop(): Promise<void> {
    const jobId = this.ctx.id.name;
    if (!jobId) return;
    await failJob(this.env, jobId, 'The extraction container stopped unexpectedly').catch(() => {});
  }
}

// --- Callback handlers (wired to POST /api/internal/extract) ------------------------

export type ExtractCallback =
  | { jobId: string; type: 'file'; path: string; size: number; contentType?: string }
  | { jobId: string; type: 'done' }
  | { jobId: string; type: 'failed'; error: string };

export async function handleExtractCallback(env: Env, event: ExtractCallback): Promise<{ ok: true }> {
  const job = await loadJob(env.DB, event.jobId);
  if (!job) throw new Error('unknown_job');
  if (job.status !== 'queued' && job.status !== 'running') throw new Error('job_closed');
  const volumes = parseVolumes(job.archive_paths);
  if (volumes.length === 0) throw new Error('job_corrupt');
  const prefix = prefixFromVolume(volumes[0]!);

  if (event.type === 'file') {
    const release = await loadDraftReleaseRow(env.DB, job.release_id);
    if (!release || release.status !== 'draft') throw new Error('release_not_draft');
    const clean = sanitizeFilePath(event.path);
    if (!clean) throw new Error('bad_path');
    if (typeof event.size !== 'number' || event.size < 0 || !Number.isInteger(event.size)) throw new Error('bad_size');
    await insertExtractedFile(
      env,
      job.id,
      job.release_id,
      prefix + clean,
      clean,
      event.size,
      event.contentType || contentTypeForPath(clean),
      unpackCaps(env),
    );
    return { ok: true };
  }
  if (event.type === 'done') {
    await completeJob(env, job.id);
    return { ok: true };
  }
  await failJob(env, job.id, event.error || 'Extraction failed inside the container');
  return { ok: true };
}
