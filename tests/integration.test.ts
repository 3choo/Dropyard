import { exports } from 'cloudflare:workers';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { S3Storage } from '../src/lib/s3';

/**
 * Full-stack integration over the real Worker: bootstrap admin, login,
 * project + release lifecycle, single-stream upload, publish, machine
 * manifest, streaming download with ranges, deploy tokens and scoping.
 */

const ORIGIN = 'http://localhost';

// Cloudflare.Exports is generic in the generated types; our main worker is
// the Hono app's default export.
const worker = (exports as unknown as { default: { fetch: typeof fetch } }).default;

let adminCookie = '';

async function call(
  path: string,
  init: RequestInit = {},
  cookie = adminCookie,
): Promise<{ res: Response; body: any; text: string }> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await worker.fetch(ORIGIN + path, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null; // raw file downloads pass through this helper too
  }
  return { res, body, text };
}

function captureCookie(res: Response): string {
  const set = res.headers.get('set-cookie');
  expect(set).toBeTruthy();
  return set!.split(';')[0]!;
}

beforeEach(async () => {
  if (!adminCookie) {
    const { res, body } = await call('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ name: 'Root', email: 'root@team.gg', password: 'correct-horse-battery' }),
    });
    expect(res.status).toBe(201);
    adminCookie = captureCookie(res);
    expect(body.user.role).toBe('admin');
  }
});

afterAll(async () => {
  adminCookie = '';
});

describe('auth', () => {
  it('rejects setup once an admin exists', async () => {
    const { res } = await call('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ name: 'X', email: 'x@team.gg', password: 'long-enough-pass' }),
    });
    expect(res.status).toBe(403);
  });

  it('logs in with good credentials and rejects bad ones', async () => {
    const bad = await call(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ email: 'root@team.gg', password: 'wrong-wrong-wrong' }) },
      '',
    );
    expect(bad.res.status).toBe(401);

    const good = await call(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ email: 'root@team.gg', password: 'correct-horse-battery' }) },
      '',
    );
    expect(good.res.status).toBe(200);
    expect(good.body.user.role).toBe('admin');
  });

  it('me reports the session user', async () => {
    const { res, body } = await call('/api/auth/me');
    expect(res.status).toBe(200);
    expect(body.user.email).toBe('root@team.gg');
  });

  it('blocks anonymous access to the API', async () => {
    const { res } = await call('/api/projects', {}, '');
    expect(res.status).toBe(401);
  });
});

describe('projects + releases + uploads', () => {
  it('walks the whole lifecycle', async () => {
    // Create a project.
    const created = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Nightcity MLO', description: 'The big one' }),
    });
    expect(created.res.status).toBe(201);
    expect(created.body.project.slug).toBe('nightcity-mlo');

    // Duplicate slug is rejected.
    const dup = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Nightcity MLO' }),
    });
    expect(dup.res.status).toBe(409);

    // Draft release.
    const rel = await call('/api/projects/nightcity-mlo/releases', {
      method: 'POST',
      body: JSON.stringify({ version: 'v1.0.0', title: 'First drop', notes: 'hello' }),
    });
    expect(rel.res.status).toBe(201);
    expect(rel.body.release.version).toBe('1.0.0'); // leading v stripped
    const releaseId = rel.body.release.id as string;

    // Publish without files must fail.
    const earlyPublish = await call('/api/projects/nightcity-mlo/releases/1.0.0/publish', { method: 'POST' });
    expect(earlyPublish.res.status).toBe(400);

    // Small file: single-stream upload through the Worker.
    const payload = 'mlo-bytes-' + 'x'.repeat(2048);
    const start = await call('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ releaseId, path: 'nightcity/model.ydr', size: payload.length, contentType: 'application/octet-stream' }),
    });
    expect(start.res.status).toBe(201);
    expect(start.body.mode).toBe('single');
    const uploadId = start.body.uploadId as string;

    const put = await call(`/api/uploads/${uploadId}/body`, {
      method: 'PUT',
      body: payload,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(put.res.status).toBe(200);

    // Draft files listing.
    const detail = await call('/api/projects/nightcity-mlo/releases/1.0.0');
    expect(detail.res.status).toBe(200);
    expect(detail.body.files).toHaveLength(1);
    expect(detail.body.files[0].path).toBe('nightcity/model.ydr');

    // Publish.
    const publish = await call('/api/projects/nightcity-mlo/releases/1.0.0/publish', { method: 'POST' });
    expect(publish.res.status).toBe(200);
    expect(typeof publish.body.digest).toBe('string');

    // Manifest via machine endpoint (session auth).
    const manifest = await call('/api/projects/nightcity-mlo/releases/latest');
    expect(manifest.res.status).toBe(200);
    expect(manifest.body.version).toBe('1.0.0');
    expect(manifest.body.files[0].size).toBe(payload.length);
    const dlPath = manifest.body.files[0].downloadUrl as string;

    // Streaming download: full + range.
    const full = await call(dlPath);
    expect(full.res.status).toBe(200);
    expect(full.text).toBe(payload);
    expect(full.res.headers.get('accept-ranges')).toBe('bytes');

    const range = await call(dlPath, { headers: { range: 'bytes=0-3' } });
    expect(range.res.status).toBe(206);
    expect(range.text).toBe(payload.slice(0, 4));
    expect(range.res.headers.get('content-range')).toBe(`bytes 0-3/${payload.length}`);

    // 304 on matching ETag.
    const etag = full.res.headers.get('etag')!;
    const cached = await call(dlPath, { headers: { 'if-none-match': etag } });
    expect(cached.res.status).toBe(304);

    // Publish increments and download counts.
    const check = await call('/api/projects/nightcity-mlo/releases/latest/check');
    expect(check.res.status).toBe(200);
    expect(check.body.version).toBe('1.0.0');
    expect(check.body.digest).toBe(publish.body.digest);
  });

  it('refuses presigned uploads when S3 credentials are absent', async () => {
    const proj = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Big Pack' }),
    });
    const slug = proj.body.project.slug as string;
    const rel = await call(`/api/projects/${slug}/releases`, {
      method: 'POST',
      body: JSON.stringify({ version: '1.0.0' }),
    });
    const start = await call('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({
        releaseId: rel.body.release.id,
        path: 'huge.zip',
        size: 6 * 1024 ** 3,
      }),
    });
    expect(start.res.status).toBe(400);
    expect(start.body.error).toBe('bad_request');
    expect(String(start.body.message)).toContain('presigned');
  });

  it('keeps releases immutable once published', async () => {
    const proj = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Immutables' }),
    });
    const slug = proj.body.project.slug as string;
    await call(`/api/projects/${slug}/releases`, {
      method: 'POST',
      body: JSON.stringify({ version: '1.0.0' }),
    });
    const start = await call('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ releaseId: (await call(`/api/projects/${slug}/releases/1.0.0`)).body.release.id, path: 'a.txt', size: 3 }),
    });
    await call(`/api/uploads/${start.body.uploadId}/body`, {
      method: 'PUT',
      body: 'abc',
      headers: { 'content-type': 'text/plain' },
    });
    await call(`/api/projects/${slug}/releases/1.0.0/publish`, { method: 'POST' });

    // New upload into a published release is rejected.
    const lateUpload = await call('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ releaseId: (await call(`/api/projects/${slug}/releases/1.0.0`)).body.release.id, path: 'b.txt', size: 3 }),
    });
    expect(lateUpload.res.status).toBe(409);
  });
});

describe('deploy tokens', () => {
  it('works machine-to-machine and honors project scoping', async () => {
    // Two projects, one release each.
    const setupProject = async (name: string) => {
      const proj = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
      const slug = proj.body.project.slug as string;
      const rel = await call(`/api/projects/${slug}/releases`, {
        method: 'POST',
        body: JSON.stringify({ version: '1.0.0' }),
      });
      const start = await call('/api/uploads', {
        method: 'POST',
        body: JSON.stringify({ releaseId: rel.body.release.id, path: 'f.bin', size: 5 }),
      });
      await call(`/api/uploads/${start.body.uploadId}/body`, {
        method: 'PUT',
        body: 'tokep',
        headers: { 'content-type': 'application/octet-stream' },
      });
      await call(`/api/projects/${slug}/releases/1.0.0/publish`, { method: 'POST' });
      return { slug, id: proj.body.project.id as string };
    };
    const scoped = await setupProject('Scoped One');
    const other = await setupProject('Scoped Two');

    // Global token sees both; scoped token only its project.
    const globalTok = await call('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'fivem-prod' }),
    });
    expect(globalTok.res.status).toBe(201);
    const g = globalTok.body.token as string;

    const scopedTok = await call('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'only-scoped', projectId: scoped.id }),
    });
    const s = scopedTok.body.token as string;

    const gCheck = await call(`/api/projects/${other.slug}/releases/latest/check`, {
      headers: { authorization: `Bearer ${g}` },
    }, '');
    expect(gCheck.res.status).toBe(200);

    const sOk = await call(`/api/projects/${scoped.slug}/releases/latest/check`, {
      headers: { authorization: `Bearer ${s}` },
    }, '');
    expect(sOk.res.status).toBe(200);

    const sDenied = await call(`/api/projects/${other.slug}/releases/latest/check`, {
      headers: { authorization: `Bearer ${s}` },
    }, '');
    expect(sDenied.res.status).toBe(403);

    // Token also works on /dl via query param.
    const dl = await worker.fetch(`${ORIGIN}/dl/${scoped.slug}/latest?token=${encodeURIComponent(s)}`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('tokep');

    // Tokens cannot manage the instance.
    const forbidden = await call('/api/admin/users', {
      headers: { authorization: `Bearer ${g}` },
    }, '');
    expect(forbidden.res.status).toBe(401);

    // Wrong-shaped tokens are rejected.
    const garbage = await call('/api/projects', {
      headers: { authorization: 'Bearer gctx_nope' },
    }, '');
    expect(garbage.res.status).toBe(401);
  });
});

describe('server pull', () => {
  const files: Record<string, string> = {
    'fxmanifest.lua': "fx_version 'cerulean'\n",
    'stream/big map.ytd': 'y'.repeat(70_000),
    'html/ü/index.html': '<p>hi</p>',
  };

  async function publishMultiFile(name: string) {
    const proj = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
    const slug = proj.body.project.slug as string;
    const rel = await call(`/api/projects/${slug}/releases`, { method: 'POST', body: JSON.stringify({ version: '2.0.0' }) });
    for (const [path, body] of Object.entries(files)) {
      const start = await call('/api/uploads', {
        method: 'POST',
        body: JSON.stringify({ releaseId: rel.body.release.id, path, size: new TextEncoder().encode(body).length }),
      });
      await call(`/api/uploads/${start.body.uploadId}/body`, {
        method: 'PUT',
        body,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    const pub = await call(`/api/projects/${slug}/releases/2.0.0/publish`, { method: 'POST' });
    expect(pub.res.status).toBe(200);
    return slug;
  }

  it('streams a multi-file release as a valid zip', async () => {
    const slug = await publishMultiFile('Zip Me');
    const res = await worker.fetch(`${ORIGIN}/dl/${slug}/latest`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length') ?? bytes.length)).toBe(bytes.length);
    const entries = unzipSync(bytes);
    expect(Object.keys(entries).sort()).toEqual(Object.keys(files).sort());
    for (const [path, body] of Object.entries(files)) {
      expect(strFromU8(entries[path]!)).toBe(body);
    }
  });

  it('zips a single-file release on ?format=zip', async () => {
    const proj = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Solo Zip' }) });
    const slug = proj.body.project.slug as string;
    const rel = await call(`/api/projects/${slug}/releases`, { method: 'POST', body: JSON.stringify({ version: '1.0.0' }) });
    const start = await call('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ releaseId: rel.body.release.id, path: 'only.txt', size: 4 }),
    });
    await call(`/api/uploads/${start.body.uploadId}/body`, {
      method: 'PUT',
      body: 'solo',
      headers: { 'content-type': 'application/octet-stream' },
    });
    await call(`/api/projects/${slug}/releases/1.0.0/publish`, { method: 'POST' });

    const raw = await call(`/dl/${slug}/latest`);
    expect(raw.text).toBe('solo');
    const zipped = await worker.fetch(`${ORIGIN}/dl/${slug}/latest?format=zip`, { headers: { cookie: adminCookie } });
    const entries = unzipSync(new Uint8Array(await zipped.arrayBuffer()));
    expect(strFromU8(entries['only.txt']!)).toBe('solo');
  });

  it('serves a plain manifest and a pull script with the token baked in', async () => {
    const slug = await publishMultiFile('Pull Me');
    const tok = await call('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'linux-box' }) });
    const token = tok.body.token as string;
    const auth = { authorization: `Bearer ${token}` };

    const manifest = await call(`/dl/${slug}/latest/manifest`, { headers: auth }, '');
    expect(manifest.res.status).toBe(200);
    const lines = manifest.text.trimEnd().split('\n');
    expect(lines).toContain('#version 2.0.0');
    expect(lines.find((l) => l.startsWith('#digest '))).toMatch(/^#digest [0-9a-f]{64}$/);
    const entries = lines.filter((l) => !l.startsWith('#')).map((l) => l.split('\t'));
    expect(entries.map((e) => decodeURIComponent(e[2]!)).sort()).toEqual(Object.keys(files).sort());
    for (const [fp, size, enc] of entries) {
      expect(fp).toMatch(/^(sha|etag):/);
      expect(Number(size)).toBe(new TextEncoder().encode(files[decodeURIComponent(enc!)]!).length);
      // ?direct=1 redirects to R2 when S3 credentials exist; without them (as here) it streams.
      const one = await call(`/dl/${slug}/v/2.0.0?direct=1&path=${enc}`, { headers: auth }, '');
      expect(one.text).toBe(files[decodeURIComponent(enc!)]);
    }

    // A published release never changes, so the manifest is cached and served as-is.
    const again = await call(`/dl/${slug}/latest/manifest`, { headers: auth }, '');
    expect(again.text).toBe(manifest.text);

    // Bulk links need S3 credentials; without them the script falls back per file.
    const links = await call(`/dl/${slug}/v/2.0.0/links`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'text/plain' },
      body: entries.map((e) => e[2]).join('\n'),
    }, '');
    expect(links.res.status).toBe(501);
    expect(links.body.error).toBe('direct_unavailable');

    const script = await call(`/dl/${slug}/pull.sh`, { headers: auth }, '');
    expect(script.res.status).toBe(200);
    expect(script.text.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script.text).toContain(`SLUG='${slug}'`);
    expect(script.text).toContain(`TOKEN=\${GITCTX_TOKEN:-'${token}'}`);
    expect(script.text).not.toContain('__BASE__');
  });
});

describe('invites', () => {
  it('creates a viewer invite that accepts and gets read-only powers', async () => {
    const invite = await call('/api/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ role: 'viewer' }),
    });
    expect(invite.res.status).toBe(201);
    const code = invite.body.code as string;

    const accept = await call('/api/auth/accept', {
      method: 'POST',
      body: JSON.stringify({ code, name: 'Watcher', email: 'watch@team.gg', password: 'long-enough-pass' }),
    }, '');
    expect(accept.res.status).toBe(201);
    const viewerCookie = captureCookie(accept.res);

    // Viewer can read projects but not create them.
    const read = await call('/api/projects', {}, viewerCookie);
    expect(read.res.status).toBe(200);

    const write = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Nope' }),
    }, viewerCookie);
    expect(write.res.status).toBe(403);

    // Invite code is single use.
    const reuse = await call('/api/auth/accept', {
      method: 'POST',
      body: JSON.stringify({ code, name: 'Again', email: 'again@team.gg', password: 'long-enough-pass' }),
    }, '');
    expect(reuse.res.status).toBe(409);
  });
});

describe('health', () => {
  it('answers', async () => {
    const res = await worker.fetch('https://example.com/api/health');
    expect(res.status).toBe(200);
  });
});

describe('R2 presigned downloads', () => {
  it('signs a short-lived GET for the object key', async () => {
    const s3 = new S3Storage({
      S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: 'gitctx',
      R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      R2_SECRET_ACCESS_KEY: 'secret',
    } as unknown as Env);
    const url = new URL(await s3.presignGet('p/x/r/y/stream/a b.ytd'));
    expect(url.origin).toBe('https://acct.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/gitctx/p/x/r/y/stream/a%20b.ytd');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});
