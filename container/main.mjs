// gitctx extraction container.
//
// The Worker wakes one instance of this container per RAR extract job and POSTs
// the job payload to /extract. The container downloads the RAR volume set from
// R2, extracts with 7zz (official 7-Zip: RAR3/RAR5, multi-volume), uploads each
// extracted file back to R2, and reports progress to the Worker via callbacks.
// The Worker owns all state (D1); this process holds nothing durable.

import { createServer } from 'node:http';
import { promises as fs, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AwsClient } from 'aws4fetch';

const execFileAsync = promisify(execFile);
const PORT = 8080;
const MB = 1024 * 1024;
const MULTIPART_THRESHOLD = 32 * MB;
const MULTIPART_PART = 8 * MB;
// Batch planning. Every 7zz pass re-opens the archive and re-decompresses any
// solid block shared with earlier batches, so fewer, bigger batches win — the
// byte budget is clamped to the disk the job actually has (standard-3: 16 GB,
// and the volume set is already on it). Two output dirs alternate so batch
// N-1 uploads to R2 while batch N is still extracting.
const MAX_BATCH_FILES = 4096;
const MAX_BATCH_BYTES = 2 * 1024 * MB;
const MIN_BATCH_BYTES = 256 * MB;
const UPLOAD_CONCURRENCY = 12;
// Per-callback chunk into the Worker; each chunk becomes one D1 batch.
const CALLBACK_FILES = 200;

function fmtBytes(n) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function fmtDur(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function safeRelPath(p) {
  const cleaned = p.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!cleaned || cleaned.length > 900) return null;
  return cleaned.split('/').some((seg) => seg === '' || seg === '.' || seg === '..') ? null : cleaned;
}

class JobClosed extends Error {
  constructor(status, body) {
    super(`worker closed the job (${status} ${String(body).slice(0, 200)})`);
  }
}

let currentJob = null; // { id, cancelled }

async function callback(payload, { callbackUrl, secret }) {
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new JobClosed(res.status, await res.text().catch(() => ''));
}

function objectUrl(r2, key, query = {}) {
  const url = new URL(
    `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
  );
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

/** Content-Length of an R2 object without fetching it; 0 when unknown. */
async function objectSize(client, r2, key) {
  try {
    const res = await client.fetch(objectUrl(r2, key), { method: 'HEAD' });
    return res.ok ? Number(res.headers.get('content-length')) || 0 : 0;
  } catch {
    return 0;
  }
}

async function downloadTo(client, r2, key, destFile, onBytes) {
  const res = await client.fetch(objectUrl(r2, key), { method: 'GET' });
  if (!res.ok || !res.body) throw new Error(`R2 download failed (${res.status}) for ${key}`);
  let count = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      count += chunk.length;
      try {
        onBytes?.(count);
      } catch {} // progress reporting must never kill the download
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(destFile));
  return count;
}

async function uploadFile(client, r2, destKey, srcFile, size) {
  const objectUrl = (query) => {
    const url = new URL(`https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${destKey.split('/').map(encodeURIComponent).join('/')}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  };

  if (size <= MULTIPART_THRESHOLD) {
    const res = await client.fetch(objectUrl({}), {
      method: 'PUT',
      headers: { 'content-length': String(size) },
      body: await fs.readFile(srcFile),
    });
    if (!res.ok) throw new Error(`R2 PUT failed (${res.status}) for ${destKey}`);
    return;
  }

  const init = await client.fetch(objectUrl({ uploads: '' }), { method: 'POST' });
  if (!init.ok) throw new Error(`R2 multipart initiate failed (${init.status})`);
  const uploadId = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(await init.text())?.[1];
  if (!uploadId) throw new Error('R2 multipart initiate returned no UploadId');

  const etags = [];
  const handle = await fs.open(srcFile, 'r');
  try {
    const buf = Buffer.alloc(MULTIPART_PART);
    for (let n = 1, offset = 0; offset < size; n++, offset += buf.length) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - offset), offset);
      const res = await client.fetch(
        objectUrl({ partNumber: String(n), uploadId: decodeURIComponent(uploadId) }),
        { method: 'PUT', headers: { 'content-length': String(bytesRead) }, body: buf.subarray(0, bytesRead) },
      );
      if (!res.ok) throw new Error(`R2 part ${n} failed (${res.status})`);
      etags.push({ n, etag: res.headers.get('etag') });
    }
  } finally {
    await handle.close();
  }

  const xml =
    '<CompleteMultipartUpload>' +
    etags.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('') +
    '</CompleteMultipartUpload>';
  const done = await client.fetch(objectUrl({ uploadId: decodeURIComponent(uploadId) }), {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: xml,
  });
  if (!done.ok) throw new Error(`R2 multipart complete failed (${done.status})`);
}

/** Run `fn` over `items` with at most `limit` concurrent tasks. */
async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/**
 * Extract→upload one planned batch. Uploads run UPLOAD_CONCURRENCY-wide;
 * file notifications are buffered and flushed to the Worker in chunks of
 * CALLBACK_FILES (one D1 batch on the Worker side per chunk). `flushChain`
 * serializes the flushes so chunks never interleave mid-snapshot.
 */
function makeBatchUploader(client, r2, payload, dir, prefix) {
  const { jobId } = payload;
  let pendingFiles = [];
  let flushChain = Promise.resolve();
  let aborted = false;

  const flushFiles = async (force = false) => {
    if (pendingFiles.length === 0 || (!force && pendingFiles.length < CALLBACK_FILES)) return;
    const chunk = pendingFiles;
    pendingFiles = [];
    await callback({ jobId, type: 'files', files: chunk }, payload);
  };

  return {
    async run(entries) {
      await pool(entries, UPLOAD_CONCURRENCY, async (entry) => {
        if (aborted || currentJob?.cancelled) {
          aborted = true;
          return;
        }
        const clean = safeRelPath(entry.path);
        if (!clean) return;
        const file = join(dir, ...clean.split('/'));
        let st;
        try {
          st = await fs.lstat(file);
        } catch {
          return; // 7zz skipped this entry (-spd warns instead of failing)
        }
        if (st.isSymbolicLink()) return; // never follow or ship symlinks
        await uploadFile(client, r2, prefix + clean, file, st.size);
        // Free the disk as soon as the file is safely in R2.
        await fs.rm(file, { force: true });
        await flushChain;
        pendingFiles.push({ path: clean, size: st.size });
        flushChain = flushChain.then(() => flushFiles());
      });
      await flushChain;
      await flushFiles(true);
    },
  };
}

/** Parse `7zz l -slt -ba` output into {path, size} entries, directories dropped. */
function parseListing(stdout) {
  const entries = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.path) entries.push(cur);
    cur = null;
  };
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('Path = ')) {
      flush();
      cur = { path: line.slice(7), size: 0 };
    } else if (cur) {
      if (line.startsWith('Size = ')) cur.size = Number(line.slice(7)) || 0;
      else if (line.startsWith('Folder = +')) cur = null; // directory entry
      else if (line === '') flush();
    }
  }
  flush();
  return entries;
}

async function runJob(payload) {
  const { jobId, volumes, prefix, caps, r2 } = payload;
  const work = join(tmpdir(), `gitctx-${jobId}`);
  const vols = join(work, 'volumes');
  const client = new AwsClient({
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  try {
    await fs.mkdir(vols, { recursive: true });

    // 7zz resolves sibling volumes by filename, so keep their basenames intact.
    const volumeBase = (v) => v.path.split('/').pop();
    const logLines = (lines) => callback({ jobId, type: 'log', lines }, payload);

    // HEAD the set first so the UI can show a real % while volumes stream down.
    let volumeBytes = 0;
    for (const volume of volumes) volumeBytes += await objectSize(client, r2, volume.r2Key);
    await callback(
      {
        jobId,
        type: 'stage',
        phase: 'download',
        detail: volumeBase(volumes[0]),
        archiveBytes: volumeBytes,
        log: `downloading ${volumes.length} volume${volumes.length > 1 ? 's' : ''} · ${fmtBytes(volumeBytes)}`,
      },
      payload,
    );
    let bytesDown = 0;
    let lastBeat = 0;
    for (const volume of volumes) {
      if (currentJob?.cancelled) throw new Error('cancelled');
      const base = volumeBase(volume);
      const startedAt = Date.now();
      const offset = bytesDown;
      const got = await downloadTo(client, r2, volume.r2Key, join(vols, base), (n) => {
        const now = Date.now();
        if (now - lastBeat < 1000) return; // heartbeat cadence, ~1 stage/s
        lastBeat = now;
        callback({ jobId, type: 'stage', phase: 'download', detail: base, bytesDone: offset + n }, payload).catch(
          () => {},
        );
      });
      bytesDown += got;
      await callback({ jobId, type: 'stage', phase: 'download', detail: base, bytesDone: bytesDown }, payload);
      await logLines([`fetched ${base} · ${fmtBytes(got)} in ${fmtDur(Date.now() - startedAt)}`]);
    }
    await callback(
      { jobId, type: 'stage', phase: 'scan', log: `downloaded ${fmtBytes(bytesDown)} of volumes` },
      payload,
    );

    const firstRar = volumes.find((v) => v.path.toLowerCase().endsWith('.rar')) ?? volumes[0];
    const archive = join(vols, firstRar.path.split('/').pop());

    // List before extracting anything: enforce the caps up front and plan
    // batches, so an oversized archive fails fast instead of filling the disk.
    const { stdout: listing } = await execFileAsync('7zz', ['l', '-slt', '-ba', archive], {
      maxBuffer: 256 * MB,
    });
    const entries = parseListing(listing);
    if (entries.length > caps.files) {
      throw new Error(`Archive contains ${entries.length} files, over the ${caps.files} file unpack limit`);
    }
    let totalBytes = 0;
    for (const e of entries) {
      if (e.size > caps.fileBytes) {
        throw new Error(`File ${e.path} exceeds the per-file unpack limit`);
      }
      totalBytes += e.size;
    }
    if (totalBytes > caps.totalBytes) {
      throw new Error('Archive exceeds the total unpack size limit');
    }
    await callback(
      {
        jobId,
        type: 'stage',
        phase: 'scan',
        totalFiles: entries.length,
        totalBytes,
        archiveBytes: volumeBytes,
        log: `listing: ${entries.length} files, ${fmtBytes(totalBytes)}`,
      },
      payload,
    );

    // Batch budget: how much we can hold on disk per extraction buffer.
    // Two buffers alternate, and the volume set is already on disk, so keep
    // roughly a third of the free space per buffer.
    let batchBytes = MAX_BATCH_BYTES;
    try {
      const s = await fs.statfs(work);
      batchBytes = Math.min(MAX_BATCH_BYTES, Math.max(MIN_BATCH_BYTES, Math.floor((s.bavail * s.bsize) / 3)));
    } catch {} // statfs unavailable: fall back to the static budget

    const batches = [];
    let batch = [];
    let batchBytesUsed = 0;
    for (const e of entries) {
      if (batch.length >= MAX_BATCH_FILES || (batch.length > 0 && batchBytesUsed + e.size > batchBytes)) {
        batches.push(batch);
        batch = [];
        batchBytesUsed = 0;
      }
      batch.push(e);
      batchBytesUsed += e.size;
    }
    if (batch.length > 0) batches.push(batch);

    // Alternate between two output dirs so batch N-1 uploads while batch N
    // extracts; a dir is only wiped once its previous uploads have landed.
    const dirs = [join(work, 'files-a'), join(work, 'files-b')];
    const uploads = [];
    let notes = '';
    try {
      for (let bi = 0; bi < batches.length; bi++) {
        const detail = `batch ${bi + 1}/${batches.length}`;
        if (currentJob?.cancelled) throw new Error('cancelled');

        const dir = dirs[bi % 2];
        const stale = uploads[bi - 2]; // same dir as this batch; must drain first
        if (stale) await stale;
        await fs.rm(dir, { recursive: true, force: true });
        await fs.mkdir(dir, { recursive: true });

        const listFile = join(work, `batch-${bi}.txt`);
        await fs.writeFile(listFile, batches[bi].map((e) => e.path).join('\n'), 'utf8');
        await callback(
          {
            jobId,
            type: 'stage',
            phase: 'extract',
            detail,
            log: `extracting ${detail} · ${batches[bi].length} files · ${fmtBytes(batches[bi].reduce((s, e) => s + e.size, 0))}`,
          },
          payload,
        );
        try {
          const { stderr } = await execFileAsync(
            '7zz',
            // Archive name must come before the @listfile: 7zz treats the first
            // non-switch argument as the archive, so the reversed order makes it
            // try to open the listfile itself (errno=2).
            ['x', '-y', '-spd', '-scsUTF-8', `-o${dir}`, archive, `@${listFile}`],
            { maxBuffer: 16 * MB },
          );
          const noteLines = stderr.split('\n').filter(Boolean).slice(-8).map((l) => l.slice(0, 300));
          notes = noteLines.join('\n');
          if (noteLines.length > 0) await logLines(noteLines);
        } catch (err) {
          const message = (err.stderr || err.message || '7zz failed').split('\n').filter(Boolean).slice(-8).join('\n');
          throw new Error(`7zz could not extract this archive: ${message.slice(0, 600)}`);
        }

        uploads.push(makeBatchUploader(client, r2, payload, dir, prefix).run(batches[bi]));
        // Upload of batch bi runs concurrently with extraction of batch bi+1.
        // Landed bytes arrive via 'files' callbacks (bytes_added worker-side);
        // this stage only marks the phase.
        await callback({ jobId, type: 'stage', phase: 'upload', detail }, payload);
      }
      // Catch the tail batches whose uploads the loop never awaited.
      await Promise.all(uploads);

      if (notes) console.log(`[extract] ${jobId} 7zz notes: ${notes}`);
      await callback({ jobId, type: 'stage', phase: 'finish', log: 'all uploads settled' }, payload);
      await callback({ jobId, type: 'done' }, payload);
      console.log(`[extract] ${jobId} done: ${entries.length} files, ${totalBytes} bytes`);
    } catch (err) {
      if (currentJob) currentJob.cancelled = true; // stop in-flight batch uploads
      throw err;
    } finally {
      // Never race tmpdir cleanup against still-running R2 writes.
      await Promise.allSettled(uploads);
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/ping') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/extract') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(202).end('accepted');
      const payload = JSON.parse(raw);
      currentJob = { id: payload.jobId, cancelled: false };
      runJob(payload)
        .then(() => process.exit(0))
        .catch(async (err) => {
          console.error(`[extract] ${payload.jobId} failed:`, err);
          if (!(err instanceof JobClosed)) {
            await callback({ jobId: payload.jobId, type: 'failed', error: err.message }, payload).catch(() => {});
          }
          process.exit(1);
        });
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => console.log(`[extract] listening on ${PORT}`));
