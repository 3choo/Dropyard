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
import { join, dirname, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AwsClient } from 'aws4fetch';

const execFileAsync = promisify(execFile);
const PORT = 8080;
const MB = 1024 * 1024;
const MULTIPART_THRESHOLD = 32 * MB;
const MULTIPART_PART = 8 * MB;

const MIME = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  lua: 'text/plain; charset=utf-8',
  cfg: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  dds: 'image/vnd-ms.dds',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  ytd: 'application/x-gtav-ytd',
  ydr: 'application/x-gtav-ydr',
  ydd: 'application/x-gtav-ydd',
  yft: 'application/x-gtav-yft',
  ymap: 'application/x-gtav-ymap',
  ymt: 'application/x-gtav-ymt',
  awc: 'application/x-gtav-awc',
  meta: 'application/x-gtav-meta',
};

function contentTypeFor(path) {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return (match && MIME[match[1].toLowerCase()]) || 'application/octet-stream';
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

async function downloadTo(client, r2, key, destFile) {
  const url = new URL(`https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
  const res = await client.fetch(url, { method: 'GET' });
  if (!res.ok || !res.body) throw new Error(`R2 download failed (${res.status}) for ${key}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destFile));
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

async function* walkFiles(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow or ship symlinks
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

async function runJob(payload) {
  const { jobId, volumes, prefix, caps, r2 } = payload;
  const work = join(tmpdir(), `gitctx-${jobId}`);
  const vols = join(work, 'volumes');
  const out = join(work, 'files');
  const client = new AwsClient({
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  try {
    await fs.mkdir(vols, { recursive: true });
    await fs.mkdir(out, { recursive: true });

    // 7zz resolves sibling volumes by filename, so keep their basenames intact.
    for (const volume of volumes) {
      if (currentJob?.cancelled) throw new Error('cancelled');
      await downloadTo(client, r2, volume.r2Key, join(vols, volume.path.split('/').pop()));
    }

    const firstRar = volumes.find((v) => v.path.toLowerCase().endsWith('.rar')) ?? volumes[0];
    let tail = '';
    try {
      const { stderr } = await execFileAsync('7zz', ['x', '-y', `-o${out}`, join(vols, firstRar.path.split('/').pop())], {
        maxBuffer: 16 * MB,
      });
      tail = stderr.split('\n').filter(Boolean).slice(-8).join('\n');
    } catch (err) {
      const message = (err.stderr || err.message || '7zz failed').split('\n').filter(Boolean).slice(-8).join('\n');
      throw new Error(`7zz could not extract this archive: ${message.slice(0, 600)}`);
    }

    let files = 0;
    let bytes = 0;
    for await (const file of walkFiles(out)) {
      if (currentJob?.cancelled) throw new Error('cancelled');
      const stat = await fs.stat(file);
      const rel = safeRelPath(relative(out, file).split(sep).join('/'));
      if (!rel) continue;
      if (files + 1 > caps.files) throw new Error(`Archive exceeds the ${caps.files} file unpack limit`);
      if (stat.size > caps.fileBytes) throw new Error(`File ${rel} exceeds the per-file unpack limit`);
      if (bytes + stat.size > caps.totalBytes) throw new Error('Archive exceeds the total unpack size limit');

      const destKey = prefix + rel;
      await uploadFile(client, r2, destKey, file, stat.size);
      await callback({ jobId, type: 'file', path: rel, size: stat.size, contentType: contentTypeFor(rel) }, payload);
      files++;
      bytes += stat.size;
    }
    if (tail) console.log(`[extract] ${jobId} 7zz notes: ${tail}`);
    await callback({ jobId, type: 'done' }, payload);
    console.log(`[extract] ${jobId} done: ${files} files, ${bytes} bytes`);
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
