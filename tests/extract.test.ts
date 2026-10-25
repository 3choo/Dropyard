import { exports, env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Archive auto-unpacking: upload a .zip through the single-stream path and the
 * Worker must stream-extract it into the draft release, drop the archive row,
 * skip unsafe paths, and gate publishing while a job is live. The container
 * (RAR) path needs real Docker and is exercised manually, not here.
 */

const ORIGIN = 'http://localhost';
const worker = (exports as unknown as { default: { fetch: typeof fetch } }).default;

let adminCookie = '';

async function call(
  path: string,
  init: RequestInit = {},
  cookie = adminCookie,
): Promise<{ res: Response; body: any; text: string }> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.body && !(init.body instanceof Uint8Array) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await worker.fetch(ORIGIN + path, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { res, body, text };
}

beforeEach(async () => {
  if (!adminCookie) {
    const { res, body } = await call('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ name: 'Root', email: 'root@team.gg', password: 'correct-horse-battery' }),
    });
    expect(res.status).toBe(201);
    adminCookie = res.headers.get('set-cookie')!.split(';')[0]!;
  }
});

// --- stored-zip builder ------------------------------------------------------

let crcTable: number[] | null = null;
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Handcraft a store-method (no compression) ZIP so tests control entry names. */
function makeStoredZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, entry.data);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + entry.data.length;
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return concatBytes([...chunks, ...central, eocd]);
}

const enc = new TextEncoder();

async function makeProjectAndRelease(): Promise<{ slug: string; version: string; releaseId: string }> {
  const slug = `zip-${Math.random().toString(36).slice(2, 8)}`;
  const created = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Zip ${slug}` }),
  });
  expect(created.res.status).toBe(201);
  const release = await call(`/api/projects/${created.body.project.slug}/releases`, {
    method: 'POST',
    body: JSON.stringify({ version: '1.0.0' }),
  });
  expect(release.res.status).toBe(201);
  return { slug: created.body.project.slug, version: '1.0.0', releaseId: release.body.release.id };
}

async function uploadZip(releaseId: string, zip: Uint8Array): Promise<{ body: any; res: Response }> {
  const session = await call('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ releaseId, path: 'build.zip', size: zip.length, contentType: 'application/zip' }),
  });
  expect(session.res.status).toBe(201);
  expect(session.body.mode).toBe('single');
  return call(`/api/uploads/${session.body.uploadId}/body`, {
    method: 'PUT',
    headers: { 'content-type': 'application/zip' },
    body: zip,
  });
}

async function waitForExtraction(slug: string, version: string): Promise<any> {
  for (let i = 0; i < 60; i++) {
    const detail = await call(`/api/projects/${slug}/releases/${version}`);
    const job = detail.body.extractions?.[0];
    if (job && (job.status === 'done' || job.status === 'failed')) return job;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('extraction did not settle in time');
}

describe('zip extraction', () => {
  it('unpacks the archive into the release and removes the archive file', async () => {
    const { slug, version, releaseId } = await makeProjectAndRelease();
    const zip = makeStoredZip([
      { name: 'resources/', data: new Uint8Array(0) },
      { name: 'resources/fxmain.lua', data: enc.encode('print("hi")\n') },
      { name: 'resources/stream/cars.ytd', data: new Uint8Array(300_000).map((_, i) => i & 0xff) },
    ]);
    const up = await uploadZip(releaseId, zip);
    expect(up.res.status).toBe(200);
    expect(up.body.extraction).toEqual({ id: expect.any(String), kind: 'zip' });

    const job = await waitForExtraction(slug, version);
    expect(job.status).toBe('done');
    expect(job.filesAdded).toBe(2);
    // Live-status surface: the zip path reports its read position and a
    // console trail even after the job settles.
    expect(job.phase).toBe('finish');
    expect(job.archiveBytes).toBe(zip.length);

    const detail = await call(`/api/projects/${slug}/releases/${version}`);
    const paths = detail.body.files.map((f: any) => f.path);
    expect(paths).toContain('resources/fxmain.lua');
    expect(paths).toContain('resources/stream/cars.ytd');
    expect(paths).not.toContain('build.zip'); // archive deleted after success

    const lua = detail.body.files.find((f: any) => f.path === 'resources/fxmain.lua');
    expect(lua.content_type).toBe('text/plain; charset=utf-8');
    const ytd = detail.body.files.find((f: any) => f.path === 'resources/stream/cars.ytd');
    expect(ytd.size).toBe(300_000);

    // Done jobs keep their console lines (start + closing line, at minimum).
    const logLines: string[] = (detail.body.extractLogs?.[job.id] ?? []).map((l: any) => l.line);
    expect(logLines.some((l) => l.startsWith('unzipping build.zip'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('done in'))).toBe(true);

    // /dl serves published releases only — publish, then pull the file back.
    const publish = await call(`/api/projects/${slug}/releases/${version}/publish`, { method: 'POST' });
    expect(publish.res.status).toBe(200);
    const dl = await call(`/dl/${slug}/v/${version}?path=${encodeURIComponent('resources/fxmain.lua')}`);
    expect(dl.res.status).toBe(200);
    expect(dl.text).toBe('print("hi")\n');
  }, 30_000);

  it('skips unsafe entry paths but extracts the rest', async () => {
    const { slug, version, releaseId } = await makeProjectAndRelease();
    const zip = makeStoredZip([
      { name: 'good.txt', data: enc.encode('fine') },
      { name: '../evil.txt', data: enc.encode('nope') },
      { name: 'a/../../escape.bin', data: enc.encode('nope') },
    ]);
    const up = await uploadZip(releaseId, zip);
    expect(up.res.status).toBe(200);
    const job = await waitForExtraction(slug, version);
    expect(job.status).toBe('done');
    expect(job.filesAdded).toBe(1);

    const detail = await call(`/api/projects/${slug}/releases/${version}`);
    const paths = detail.body.files.map((f: any) => f.path);
    expect(paths).toEqual(['good.txt']);
  }, 30_000);

  it('marks the job failed and keeps the archive for a corrupt zip', async () => {
    const { slug, version, releaseId } = await makeProjectAndRelease();
    const zip = makeStoredZip([{ name: 'x.txt', data: enc.encode('x') }]);
    // Lie about the entry's stored size so the stream parser overruns the data
    // into the central directory — the unzipper must reject the archive.
    new DataView(zip.buffer).setUint32(18, 500, true);
    const up = await uploadZip(releaseId, zip);
    expect(up.res.status).toBe(200);
    const job = await waitForExtraction(slug, version);
    expect(job.status).toBe('failed');
    expect(job.error).toBeTruthy();

    const detail = await call(`/api/projects/${slug}/releases/${version}`);
    const paths = detail.body.files.map((f: any) => f.path);
    expect(paths).toContain('build.zip'); // archive kept on failure
    expect(detail.body.extractions[0].status).toBe('failed');
    // Failed jobs keep their console trail — that's where 7zz/unzipper errors land.
    const failLines: string[] = (detail.body.extractLogs?.[job.id] ?? []).map((l: any) => l.line);
    expect(failLines.some((l) => l.startsWith('failed after'))).toBe(true);
  }, 30_000);
});

describe('live progress callbacks', () => {
  const secret = 'test-extract-secret';

  async function postCallback(payload: unknown, token = secret): Promise<{ res: Response; body: any }> {
    const res = await worker.fetch(`${ORIGIN}/api/internal/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    return { res, body: await res.json().catch(() => null) };
  }

  async function seedRunningJob(jobId: string, releaseId: string, status = 'running'): Promise<void> {
    await env.DB
      .prepare(
        "INSERT INTO extract_jobs (id, release_id, kind, archive_paths, status, created_at) VALUES (?, ?, 'rar', ?, ?, ?)",
      )
      .bind(
        jobId,
        releaseId,
        JSON.stringify([{ path: 'pack.part1.rar', r2Key: 'p/x/r/y/pack.part1.rar' }]),
        status,
        Date.now(),
      )
      .run();
  }

  it('persists stage updates and console lines for a live job', async () => {
    const { slug, version, releaseId } = await makeProjectAndRelease();
    await seedRunningJob('jprog', releaseId);

    const stage1 = await postCallback({
      jobId: 'jprog',
      type: 'stage',
      phase: 'download',
      detail: 'pack.part1.rar',
      archiveBytes: 1000,
      bytesDone: 400,
      log: 'downloading 1 volume · 1000 B',
    });
    expect(stage1.res.status).toBe(200);
    const logs = await postCallback({ jobId: 'jprog', type: 'log', lines: ['fetched pack.part1.rar · 1000 B in 2s'] });
    expect(logs.res.status).toBe(200);

    const detail = await call(`/api/projects/${slug}/releases/${version}`);
    const job = detail.body.extractions.find((j: any) => j.id === 'jprog');
    expect(job.phase).toBe('download');
    expect(job.detail).toBe('pack.part1.rar');
    expect(job.archiveBytes).toBe(1000);
    expect(job.bytesDone).toBe(400);
    expect(detail.body.extractLogs.jprog.map((l: any) => l.line)).toEqual([
      'downloading 1 volume · 1000 B',
      'fetched pack.part1.rar · 1000 B in 2s',
    ]);

    // Totals arrive with the listing stage; earlier counters must survive it.
    await postCallback({ jobId: 'jprog', type: 'stage', phase: 'extract', detail: 'batch 1/2', totalFiles: 12, totalBytes: 5000 });
    const detail2 = await call(`/api/projects/${slug}/releases/${version}`);
    const job2 = detail2.body.extractions.find((j: any) => j.id === 'jprog');
    expect(job2.phase).toBe('extract');
    expect(job2.detail).toBe('batch 1/2');
    expect(job2.totalFiles).toBe(12);
    expect(job2.totalBytes).toBe(5000);
    expect(job2.archiveBytes).toBe(1000);
  });

  it('inserts batched file callbacks as release files', async () => {
    const { slug, version, releaseId } = await makeProjectAndRelease();
    await seedRunningJob('jfiles', releaseId);
    const ok = await postCallback({
      jobId: 'jfiles',
      type: 'files',
      files: [
        { path: 'a.txt', size: 3 },
        { path: 'b/lua.txt', size: 5, contentType: 'text/plain; charset=utf-8' },
      ],
    });
    expect(ok.res.status).toBe(200);
    const detail = await call(`/api/projects/${slug}/releases/${version}`);
    const paths = detail.body.files.map((f: any) => f.path);
    expect(paths).toContain('a.txt');
    expect(paths).toContain('b/lua.txt');
    const job = detail.body.extractions.find((j: any) => j.id === 'jfiles');
    expect(job.filesAdded).toBe(2);
    expect(job.bytesAdded).toBe(8);
  });

  it('validates stage phases and log batches', async () => {
    const { releaseId } = await makeProjectAndRelease();
    await seedRunningJob('jbad', releaseId);
    expect((await postCallback({ jobId: 'jbad', type: 'stage', phase: 'warp' })).res.status).toBe(400);
    expect(
      (await postCallback({ jobId: 'jbad', type: 'log', lines: Array.from({ length: 201 }, (_, i) => `l${i}`) })).res
        .status,
    ).toBe(400);
    expect((await postCallback({ jobId: 'jbad', type: 'log', lines: ['ok', 5] })).res.status).toBe(400);
    expect((await postCallback({ jobId: 'jbad', type: 'stage', phase: 'upload', bytesDone: -1 })).res.status).toBe(200); // negative counters are dropped, not fatal
  });

  it('rejects progress callbacks for closed jobs', async () => {
    const { releaseId } = await makeProjectAndRelease();
    await seedRunningJob('jdone', releaseId, 'done');
    const res = await postCallback({ jobId: 'jdone', type: 'stage', phase: 'upload' });
    expect(res.res.status).toBe(410);
  });
});

describe('publish gate and callback auth', () => {
  it('refuses to publish while an extraction job is live', async () => {
    const { slug, version, releaseId } = await makeProjectAndRelease();
    const file = await call('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ releaseId, path: 'plain.txt', size: 4, contentType: 'text/plain' }),
    });
    await call(`/api/uploads/${file.body.uploadId}/body`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: enc.encode('data'),
    });
    await env.DB
      .prepare(
        "INSERT INTO extract_jobs (id, release_id, kind, archive_paths, status, created_at) VALUES ('jlive', ?, 'zip', '[{\"path\":\"a.zip\",\"r2Key\":\"p/x/r/y/a.zip\"}]', 'running', ?)",
      )
      .bind(releaseId, Date.now())
      .run();
    const publish = await call(`/api/projects/${slug}/releases/${version}/publish`, { method: 'POST' });
    expect(publish.res.status).toBe(409);
  });

  it('rejects extraction callbacks without the shared secret', async () => {
    const res = await worker.fetch(`${ORIGIN}/api/internal/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'nope', type: 'done' }),
    });
    expect(res.status).toBe(401);
    const wrong = await worker.fetch(`${ORIGIN}/api/internal/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({ jobId: 'nope', type: 'done' }),
    });
    expect(wrong.status).toBe(401);
  });
});
