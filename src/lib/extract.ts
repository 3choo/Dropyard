import { getContainer, Container } from '@cloudflare/containers';
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from 'fflate';
import { nowMs, randomId, sanitizeFilePath } from './ids';
import { contentTypeForPath } from './mime';
import { R2S3 } from './r2s3';
import { deleteUnreferencedObjects } from './r2refs';

const MB = 1024 * 1024;
const EXTRACT_PART_BYTES = 8 * MB;

export type ArchiveVolume = { path: string; r2Key: string };

export type ExtractJobRow = {
  id: string;
  release_id: string;
  kind: 'zip' | 'rar';
  archive_paths: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  files_added: number;
  bytes_added: number;
  error: string | null;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
  phase: ExtractPhase | null;
  detail: string | null;
  total_files: number | null;
  total_bytes: number | null;
  archive_bytes: number | null;
  bytes_done: number;
};

export type ExtractPhase = 'download' | 'scan' | 'extract' | 'upload' | 'finish';

const PHASES: ExtractPhase[] = ['download', 'scan', 'extract', 'upload', 'finish'];

export function isExtractPhase(v: unknown): v is ExtractPhase {
  return typeof v === 'string' && PHASES.includes(v as ExtractPhase);
}

const LOG_CAP = 400;

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

export function detectArchive(path: string): 'zip' | 'rar' | 'rar-part' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.rar')) return 'rar';
  if (/\.r\d{2}$/.test(lower)) return 'rar-part';
  if (/\.part\d+\.rar$/.test(lower)) return 'rar-part';
  return null;
}

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

async function extractionPrefix(
  db: D1Database,
  releaseId: string,
  jobId: string,
  archiveKey: string,
): Promise<string> {
  const rel = await db
    .prepare('SELECT project_id FROM releases WHERE id = ?')
    .bind(releaseId)
    .first<{ project_id: string }>();
  const own = `p/${rel?.project_id ?? '?'}/r/${releaseId}/`;
  return archiveKey.startsWith(own) ? own : `${own}${jobId}/`;
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

export async function maybeStartExtraction(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  opts: { origin: string; releaseId: string; path: string; r2Key: string; userId: string | null },
): Promise<{ id: string; kind: 'zip' | 'rar' } | null> {
  const detected = detectArchive(opts.path);
  if (!detected || detected === 'rar-part') return null;
  const kind = detected;

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

  const prefix = await extractionPrefix(env.DB, opts.releaseId, jobId, opts.r2Key);
  if (kind === 'zip') {
    waitUntil(runZipExtraction(env, jobId, opts.releaseId, volumes, prefix).catch(() => {}));
  } else {
    waitUntil(runRarExtraction(env, jobId, volumes, prefix, opts.origin).catch(() => {}));
  }
  return { id: jobId, kind };
}

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
  const prefix = await extractionPrefix(env.DB, old.release_id, jobId, volumes[0]!.r2Key);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM extract_log WHERE job_id = ?').bind(old.id),
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

function fmtDur(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function fmtBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export async function appendJobLog(env: Env, jobId: string, lines: string[]): Promise<void> {
  const clean = lines
    .map((l) => String(l ?? '').trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(0, 500));
  if (clean.length === 0) return;
  const max = await env.DB
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM extract_log WHERE job_id = ?')
    .bind(jobId)
    .first<{ m: number }>();
  let seq = max?.m ?? 0;
  const now = nowMs();
  const stmts = clean.map((line, i) =>
    env.DB.prepare('INSERT INTO extract_log (job_id, seq, line, at) VALUES (?, ?, ?, ?)').bind(jobId, seq + 1 + i, line, now),
  );
  seq += clean.length;
  if (seq > LOG_CAP) {
    stmts.push(env.DB.prepare('DELETE FROM extract_log WHERE job_id = ? AND seq <= ?').bind(jobId, seq - LOG_CAP));
  }
  await env.DB.batch(stmts);
}

async function markRunning(db: D1Database, jobId: string): Promise<void> {
  await db.prepare("UPDATE extract_jobs SET status = 'running' WHERE id = ? AND status = 'queued'").bind(jobId).run();
}

async function completeJob(env: Env, jobId: string): Promise<void> {
  const job = await loadJob(env.DB, jobId);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
  await appendJobLog(env, jobId, [
    `done in ${fmtDur(nowMs() - job.created_at)} · ${job.files_added} files · ${fmtBytes(job.bytes_added)}`,
  ]);
  const volumeKeys: string[] = [];
  for (const volume of parseVolumes(job.archive_paths)) {
    await env.DB
      .prepare('DELETE FROM release_files WHERE release_id = ? AND path = ?')
      .bind(job.release_id, volume.path)
      .run();
    volumeKeys.push(volume.r2Key);
  }
  await deleteUnreferencedObjects(env.DB, env.BUCKET, volumeKeys);
  await env.DB
    .prepare("UPDATE extract_jobs SET status = 'done', phase = 'finish', finished_at = ? WHERE id = ?")
    .bind(nowMs(), jobId)
    .run();
}

export async function failJob(env: Env, jobId: string, message: string): Promise<void> {
  const job = await loadJob(env.DB, jobId);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
  await appendJobLog(env, jobId, [`failed after ${fmtDur(nowMs() - job.created_at)}: ${message.slice(0, 300)}`]);
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
  let liveUploadId: string | null = null;
  let liveKey: string | null = null;

  const progress = { bytesRead: 0, entries: 0, lastUpdateBytes: 0, lastLogBytes: 0 };
  const maybeReportProgress = async (): Promise<void> => {
    if (progress.bytesRead - progress.lastUpdateBytes < 16 * MB) return;
    progress.lastUpdateBytes = progress.bytesRead;
    const log =
      progress.bytesRead - progress.lastLogBytes >= 128 * MB
        ? `read ${fmtBytes(progress.bytesRead)} of ${fmtBytes(archiveSize)} · ${progress.entries} files`
        : null;
    if (log) progress.lastLogBytes = progress.bytesRead;
    await env.DB
      .prepare('UPDATE extract_jobs SET bytes_done = ?, phase = ? WHERE id = ?')
      .bind(progress.bytesRead, 'extract', jobId)
      .run();
    if (log) await appendJobLog(env, jobId, [log]);
  };

  let archiveSize = 0;
  try {
    const obj = await env.BUCKET.get(archive.r2Key);
    if (!obj) throw new Error('The zip object is no longer in storage');
    archiveSize = obj.size;
    const base = archive.path.split('/').pop() ?? archive.path;
    await env.DB
      .prepare('UPDATE extract_jobs SET phase = ?, detail = ?, archive_bytes = ?, bytes_done = 0 WHERE id = ?')
      .bind('extract', base, archiveSize, jobId)
      .run();
    await appendJobLog(env, jobId, [`unzipping ${base} (${fmtBytes(archiveSize)})`]);

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

    const reader = obj.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      progress.bytesRead += value.length;
      unzipper.push(value, false);
      await chain;
      if (streamError) throw streamError;
      await maybeReportProgress();
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
          await env.BUCKET.put(destKey, chunk, { httpMetadata: { contentType } });
          await insertExtractedFile(env, jobId, releaseId, destKey, clean, chunk.length, contentType, caps);
          progress.entries += 1;
          return;
        }
        if (chunk.length > 0) {
          await ensureUpload();
          const n = etags.length + 1;
          const etag = await s3.uploadPart(destKey, uploadId!, n, toArrayBuffer(chunk));
          etags.push({ n, etag });
        }
        if (final) {
          await ensureUpload();
          await s3.complete(destKey, uploadId!, etags);
          liveUploadId = null;
          liveKey = null;
          await insertExtractedFile(env, jobId, releaseId, destKey, clean, entryBytes, contentType, caps);
          progress.entries += 1;
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
            progress.entries += 1;
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
    await env.DB
      .prepare("UPDATE extract_jobs SET phase = 'download', detail = 'starting container' WHERE id = ?")
      .bind(jobId)
      .run();
    await appendJobLog(env, jobId, [
      `unraring ${volumes.map((v) => v.path.split('/').pop()).join(', ')} via extraction container`,
    ]);

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
  } catch (err) {
    await failJob(env, jobId, err instanceof Error ? err.message : 'RAR extraction failed').catch(() => {});
  }
}

export class ExtractRunner extends Container {
  defaultPort = 8080;
  sleepAfter = '30m';

  override async onStop(): Promise<void> {
    const jobId = this.ctx.id.name;
    if (!jobId) return;
    await failJob(this.env, jobId, 'The extraction container stopped unexpectedly').catch(() => {});
  }
}

export type ExtractCallback =
  | { jobId: string; type: 'file'; path: string; size: number; contentType?: string }
  | { jobId: string; type: 'files'; files: { path: string; size: number; contentType?: string }[] }
  | { jobId: string; type: 'done' }
  | { jobId: string; type: 'failed'; error: string }
  | {
      jobId: string;
      type: 'stage';
      phase: ExtractPhase;
      detail?: string;
      log?: string;
      totalFiles?: number;
      totalBytes?: number;
      archiveBytes?: number;
      bytesDone?: number;
    }
  | { jobId: string; type: 'log'; lines: string[] };

function optCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

async function applyStage(
  env: Env,
  jobId: string,
  ev: ExtractCallback & { type: 'stage' },
): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE extract_jobs SET
         phase = ?,
         detail = COALESCE(?, detail),
         total_files = COALESCE(?, total_files),
         total_bytes = COALESCE(?, total_bytes),
         archive_bytes = COALESCE(?, archive_bytes),
         bytes_done = COALESCE(?, bytes_done)
       WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .bind(
      ev.phase,
      ev.detail ?? null,
      optCount(ev.totalFiles) ?? null,
      optCount(ev.totalBytes) ?? null,
      optCount(ev.archiveBytes) ?? null,
      optCount(ev.bytesDone) ?? null,
      jobId,
    )
    .run();
}

const MAX_CALLBACK_FILES = 1000;

async function insertExtractedFiles(
  env: Env,
  job: ExtractJobRow,
  prefix: string,
  files: { path: string; size: number; contentType?: string }[],
): Promise<void> {
  const release = await loadDraftReleaseRow(env.DB, job.release_id);
  if (!release || release.status !== 'draft') throw new Error('release_not_draft');
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_CALLBACK_FILES) throw new Error('bad_files');
  const caps = unpackCaps(env);
  if (job.files_added + files.length > caps.files) {
    throw new Error(`Archive exceeds the ${caps.files} file unpack limit (MAX_UNPACK_FILES)`);
  }
  const now = nowMs();
  const byPath = new Map<string, { size: number; contentType: string }>();
  let bytes = 0;
  for (const f of files) {
    const clean = sanitizeFilePath(f.path);
    if (!clean) throw new Error('bad_path');
    if (typeof f.size !== 'number' || f.size < 0 || !Number.isInteger(f.size)) throw new Error('bad_size');
    if (f.size > caps.fileBytes) {
      throw new Error(`File ${clean} exceeds the per-file unpack limit (MAX_UNPACK_FILE_MB)`);
    }
    bytes += f.size;
    byPath.set(clean, { size: f.size, contentType: f.contentType || contentTypeForPath(clean) });
  }
  if (job.bytes_added + bytes > caps.totalBytes) {
    throw new Error('Archive exceeds the total unpack size limit (MAX_UNPACK_TOTAL_MB)');
  }
  const stmts: D1PreparedStatement[] = [];
  for (const [clean, f] of byPath) {
    stmts.push(env.DB.prepare('DELETE FROM release_files WHERE release_id = ? AND path = ?').bind(job.release_id, clean));
    stmts.push(
      env.DB
        .prepare(
          "INSERT INTO release_files (id, release_id, path, r2_key, size, content_type, part_digests, created_at, extract_job_id) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)",
        )
        .bind(randomId(12), job.release_id, clean, prefix + clean, f.size, f.contentType, now, job.id),
    );
  }
  stmts.push(
    env.DB
      .prepare('UPDATE extract_jobs SET files_added = files_added + ?, bytes_added = bytes_added + ? WHERE id = ?')
      .bind(byPath.size, bytes, job.id),
  );
  await env.DB.batch(stmts);
}

export async function handleExtractCallback(env: Env, event: ExtractCallback): Promise<{ ok: true }> {
  const job = await loadJob(env.DB, event.jobId);
  if (!job) throw new Error('unknown_job');
  if (job.status !== 'queued' && job.status !== 'running') throw new Error('job_closed');
  const volumes = parseVolumes(job.archive_paths);
  if (volumes.length === 0) throw new Error('job_corrupt');
  const prefix = await extractionPrefix(env.DB, job.release_id, job.id, volumes[0]!.r2Key);

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
  if (event.type === 'files') {
    await insertExtractedFiles(env, job, prefix, event.files);
    return { ok: true };
  }
  if (event.type === 'stage') {
    if (!isExtractPhase(event.phase)) throw new Error('bad_phase');
    await applyStage(env, job.id, event);
    if (typeof event.log === 'string' && event.log.length > 0) await appendJobLog(env, job.id, [event.log]);
    return { ok: true };
  }
  if (event.type === 'log') {
    await appendJobLog(env, job.id, event.lines);
    return { ok: true };
  }
  if (event.type === 'done') {
    await completeJob(env, job.id);
    return { ok: true };
  }
  await failJob(env, job.id, event.error || 'Extraction failed inside the container');
  return { ok: true };
}
