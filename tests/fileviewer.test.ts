import { exports, env } from 'cloudflare:workers';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * File viewer/editor: blob endpoint text/binary classification, draft
 * in-place saves, fork-into-new-draft editing, and reference-counted R2
 * deletion (forked releases share objects with their source).
 */

const ORIGIN = 'http://localhost';

const worker = (exports as unknown as { default: { fetch: typeof fetch } }).default;
const bucket = env.BUCKET;

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
    body = null;
  }
  return { res, body, text };
}

function captureCookie(res: Response): string {
  const set = res.headers.get('set-cookie');
  expect(set).toBeTruthy();
  return set!.split(';')[0]!;
}

/** Create a project with a published release holding one text + one binary file. */
async function seedPublishedProject(name: string): Promise<{ slug: string; config: string }> {
  const proj = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
  expect(proj.res.status).toBe(201);
  const slug = proj.body.project.slug as string;
  const rel = await call(`/api/projects/${slug}/releases`, {
    method: 'POST',
    body: JSON.stringify({ version: '1.0.0', title: 'seed', notes: 'seed notes' }),
  });
  const releaseId = rel.body.release.id as string;
  const config = 'client_script "config.lua"\nvalue = 1\n';
  for (const [path, body] of [
    ['config.lua', config],
    ['model.ydr', 'not-really-binary'],
  ] as const) {
    const start = await call('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ releaseId, path, size: body.length }),
    });
    expect(start.res.status).toBe(201);
    const put = await call(`/api/uploads/${start.body.uploadId}/body`, {
      method: 'PUT',
      body,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(put.res.status).toBe(200);
  }
  const publish = await call(`/api/projects/${slug}/releases/1.0.0/publish`, { method: 'POST' });
  expect(publish.res.status).toBe(200);
  return { slug, config };
}

beforeEach(async () => {
  if (!adminCookie) {
    const { res } = await call('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ name: 'Root', email: 'root@team.gg', password: 'correct-horse-battery' }),
    });
    expect(res.status).toBe(201);
    adminCookie = captureCookie(res);
  }
});

afterAll(async () => {
  adminCookie = '';
});

describe('blob endpoint', () => {
  it('serves text inline and classifies binaries by extension', async () => {
    const { slug, config } = await seedPublishedProject('Blob Lab');

    const text = await call(`/api/projects/${slug}/releases/1.0.0/blob?path=${encodeURIComponent('config.lua')}`);
    expect(text.res.status).toBe(200);
    expect(text.body.kind).toBe('text');
    expect(text.body.content).toBe(config);
    expect(text.body.truncated).toBe(false);
    expect(text.body.contentType).toBe('text/plain; charset=utf-8');

    // .ydr is binary per the mime map even though the bytes decode as UTF-8.
    const binary = await call(`/api/projects/${slug}/releases/1.0.0/blob?path=${encodeURIComponent('model.ydr')}`);
    expect(binary.res.status).toBe(200);
    expect(binary.body.kind).toBe('binary');
    expect(binary.body.content).toBeUndefined();
    expect(binary.body.downloadUrl).toBe(`/dl/${slug}/v/1.0.0?path=model.ydr`);

    const missing = await call(`/api/projects/${slug}/releases/1.0.0/blob?path=nope.lua`);
    expect(missing.res.status).toBe(404);

    const bad = await call(`/api/projects/${slug}/releases/1.0.0/blob?path=${encodeURIComponent('../etc.lua')}`);
    expect(bad.res.status).toBe(400);
  });

  it('marks oversize text as truncated and hides drafts from deploy tokens', async () => {
    const { slug } = await seedPublishedProject('Blob Limits');
    const rel = await call(`/api/projects/${slug}/releases`, {
      method: 'POST',
      body: JSON.stringify({ version: '2.0.0' }),
    });
    const releaseId = rel.body.release.id as string;
    const big = 'a'.repeat(1_000_001);
    const start = await call('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ releaseId, path: 'big.log', size: big.length }),
    });
    await call(`/api/uploads/${start.body.uploadId}/body`, {
      method: 'PUT',
      body: big,
      headers: { 'content-type': 'text/plain' },
    });

    const oversize = await call(`/api/projects/${slug}/releases/2.0.0/blob?path=big.log`);
    expect(oversize.res.status).toBe(200);
    expect(oversize.body.kind).toBe('text');
    expect(oversize.body.truncated).toBe(true);
    expect(oversize.body.content).toBeNull();
    expect(oversize.body.size).toBe(big.length);

    // Drafts stay invisible to deploy tokens.
    const tok = await call('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'blob-token' }) });
    const draft = await call(`/api/projects/${slug}/releases/2.0.0/blob?path=big.log`, {
      headers: { authorization: `Bearer ${tok.body.token}` },
    }, '');
    expect(draft.res.status).toBe(404);

    // …but visible to sessions.
    const session = await call(`/api/projects/${slug}/releases/2.0.0/blob?path=big.log`);
    expect(session.res.status).toBe(200);
  });
});

describe('draft in-place content save', () => {
  it('updates a draft file and rejects published releases', async () => {
    const { slug } = await seedPublishedProject('Edit Draft');
    const rel = await call(`/api/projects/${slug}/releases`, {
      method: 'POST',
      body: JSON.stringify({ version: '2.0.0' }),
    });
    const releaseId = rel.body.release.id as string;
    const start = await call('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ releaseId, path: 'config.lua', size: 6 }),
    });
    await call(`/api/uploads/${start.body.uploadId}/body`, {
      method: 'PUT',
      body: 'orig = 1',
      headers: { 'content-type': 'text/plain' },
    });

    const save = await call(
      `/api/projects/${slug}/releases/2.0.0/files/content?path=${encodeURIComponent('config.lua')}`,
      { method: 'PUT', body: 'value = 42\n', headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
    expect(save.res.status).toBe(200);
    expect(save.body.size).toBe(11);
    expect(save.body.digest).toMatch(/^[0-9a-f]{64}$/);

    const blob = await call(`/api/projects/${slug}/releases/2.0.0/blob?path=config.lua`);
    expect(blob.body.content).toBe('value = 42\n');

    // In-place save on a published release is immutable-rejected.
    const published = await call(
      `/api/projects/${slug}/releases/1.0.0/files/content?path=config.lua`,
      { method: 'PUT', body: 'nope', headers: { 'content-type': 'text/plain' } },
    );
    expect(published.res.status).toBe(409);

    // Oversize saves are capped.
    const oversize = await call(
      `/api/projects/${slug}/releases/2.0.0/files/content?path=config.lua`,
      { method: 'PUT', body: 'x'.repeat(1_000_001), headers: { 'content-type': 'text/plain' } },
    );
    expect(oversize.res.status).toBe(413);
  });
});

describe('fork editing', () => {
  it('clones a published release into a draft with the edited file', async () => {
    const { slug, config } = await seedPublishedProject('Fork Lab');

    const fork = await call(`/api/projects/${slug}/releases/1.0.0/fork`, {
      method: 'POST',
      body: JSON.stringify({ version: '1.0.1', title: 'tweak', notes: 'note', path: 'config.lua', content: 'value = 2\n' }),
    });
    expect(fork.res.status).toBe(201);
    expect(fork.body.release.status).toBe('draft');
    expect(fork.body.filesCloned).toBe(2);

    const edited = await call(`/api/projects/${slug}/releases/1.0.1/blob?path=config.lua`);
    expect(edited.body.content).toBe('value = 2\n');
    // The edit landed on a fresh object, not the shared one.
    expect(edited.body.digest).not.toBe(
      (await call(`/api/projects/${slug}/releases/1.0.0/blob?path=config.lua`)).body.digest,
    );

    // Cloned binary still reads (shared object) and the source is untouched.
    const binary = await call(`/api/projects/${slug}/releases/1.0.1/blob?path=model.ydr`);
    expect(binary.body.kind).toBe('binary');
    const source = await call(`/api/projects/${slug}/releases/1.0.0/blob?path=config.lua`);
    expect(source.body.content).toBe(config);

    // Forked rows share R2 keys with the source except the edited file.
    const keysFor = async (version: string) => {
      const rel = await call(`/api/projects/${slug}/releases/${version}`);
      const rows = await env.DB
        .prepare('SELECT path, r2_key FROM release_files WHERE release_id = ?')
        .bind(rel.body.release.id)
        .all<{ path: string; r2_key: string }>();
      return new Map(rows.results.map((r) => [r.path, r.r2_key]));
    };
    const paths = await keysFor('1.0.1');
    const sourcePaths = await keysFor('1.0.0');
    expect(paths.get('model.ydr')).toBe(sourcePaths.get('model.ydr'));
    expect(paths.get('config.lua')!.startsWith(`p/`)).toBe(true);
    expect(paths.get('config.lua')).not.toBe(sourcePaths.get('config.lua'));

    // Duplicate version and bad versions are rejected.
    const dup = await call(`/api/projects/${slug}/releases/1.0.0/fork`, {
      method: 'POST',
      body: JSON.stringify({ version: '1.0.1' }),
    });
    expect(dup.res.status).toBe(409);
    const badver = await call(`/api/projects/${slug}/releases/1.0.0/fork`, {
      method: 'POST',
      body: JSON.stringify({ version: 'not a version!' }),
    });
    expect(badver.res.status).toBe(400);

    // The fork is a normal draft: publishable, and the publish digest covers it.
    const publish = await call(`/api/projects/${slug}/releases/1.0.1/publish`, { method: 'POST' });
    expect(publish.res.status).toBe(200);
  });

  it('viewers cannot fork', async () => {
    const { slug } = await seedPublishedProject('Fork ACL');
    const invite = await call('/api/admin/invites', { method: 'POST', body: JSON.stringify({ role: 'viewer' }) });
    const accept = await call('/api/auth/accept', {
      method: 'POST',
      body: JSON.stringify({ code: invite.body.code, name: 'V', email: 'viewer2@team.gg', password: 'long-enough-pass' }),
    }, '');
    const fork = await call(`/api/projects/${slug}/releases/1.0.0/fork`, {
      method: 'POST',
      body: JSON.stringify({ version: '1.0.1' }),
    }, captureCookie(accept.res));
    expect(fork.res.status).toBe(403);
  });
});

describe('reference-counted deletion', () => {
  it('keeps fork objects alive after deleting the source, then GCs them', async () => {
    const { slug } = await seedPublishedProject('Fork GC');
    const fork = await call(`/api/projects/${slug}/releases/1.0.0/fork`, {
      method: 'POST',
      body: JSON.stringify({ version: '1.0.1', path: 'config.lua', content: 'value = 3\n' }),
    });
    expect(fork.res.status).toBe(201);
    // /dl only serves published releases.
    expect((await call(`/api/projects/${slug}/releases/1.0.1/publish`, { method: 'POST' })).res.status).toBe(200);

    // Shared object survives the source's deletion.
    const sourceDetail = await call(`/api/projects/${slug}/releases/1.0.0`);
    const sharedRows = await env.DB
      .prepare('SELECT path, r2_key FROM release_files WHERE release_id = ?')
      .bind(sourceDetail.body.release.id)
      .all<{ path: string; r2_key: string }>();
    const sharedKey = sharedRows.results.find((r) => r.path === 'model.ydr')!.r2_key;
    const delSource = await call(`/api/projects/${slug}/releases/1.0.0`, { method: 'DELETE' });
    expect(delSource.res.status).toBe(200);
    expect(await bucket.head(sharedKey)).toBeTruthy();

    const dl = await call(`/dl/${slug}/v/1.0.1?path=model.ydr`);
    expect(dl.res.status).toBe(200);
    expect(dl.text).toBe('not-really-binary');
    const edited = await call(`/dl/${slug}/v/1.0.1?path=config.lua`);
    expect(edited.text).toBe('value = 3\n');

    // Deleting the fork's edited file's row + release GCs the private object.
    const forkDetail = await call(`/api/projects/${slug}/releases/1.0.1`);
    const forkRows = await env.DB
      .prepare('SELECT path, r2_key FROM release_files WHERE release_id = ?')
      .bind(forkDetail.body.release.id)
      .all<{ path: string; r2_key: string }>();
    const editedKey = forkRows.results.find((r) => r.path === 'config.lua')!.r2_key;
    const delFork = await call(`/api/projects/${slug}/releases/1.0.1`, { method: 'DELETE' });
    expect(delFork.res.status).toBe(200);
    expect(await bucket.head(sharedKey)).toBeNull();
    expect(await bucket.head(editedKey)).toBeNull();
  });
});
