import { env, exports } from 'cloudflare:workers';
import { zlibSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashObject, serializeCommit, serializeTree, type ObjType } from '../src/git/objects';
import { FLUSH, concatBytes, pkt } from '../src/git/pkt';
import { getStarter, starterStep } from '../src/git/starter';

/**
 * Git hosting: smart-HTTP auth, a hand-built pack pushed through
 * receive-pack, fetch through upload-pack (v0 and v2), the repo browsing API,
 * web commits to a branch, and pull requests against a protected default.
 */

const ORIGIN = 'http://localhost';
const worker = (exports as unknown as { default: { fetch: typeof fetch } }).default;
const enc = new TextEncoder();
const dec = new TextDecoder();

let adminCookie = '';
let reviewerCookie = '';
let pat = '';
let slug = '';

async function call(path: string, init: RequestInit = {}, cookie = adminCookie): Promise<{ res: Response; body: any }> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await worker.fetch(ORIGIN + path, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

function basic(secret: string): string {
  return `Basic ${btoa(`git:${secret}`)}`;
}

async function git(path: string, init: RequestInit = {}, secret = pat): Promise<Response> {
  const headers = new Headers(init.headers);
  if (secret) headers.set('authorization', basic(secret));
  return worker.fetch(`${ORIGIN}/git/${slug}.git${path}`, { ...init, headers });
}

// --- pack builder ------------------------------------------------------------

type Obj = { type: ObjType; data: Uint8Array; sha: string };

async function obj(type: ObjType, data: Uint8Array): Promise<Obj> {
  return { type, data, sha: await hashObject(type, data) };
}

async function buildPack(objects: Obj[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(12);
  head.set(enc.encode('PACK'));
  new DataView(head.buffer).setUint32(4, 2);
  new DataView(head.buffer).setUint32(8, objects.length);
  parts.push(head);
  const code = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;
  for (const o of objects) {
    let size = o.data.length;
    const bytes = [(code[o.type] << 4) | (size & 0x0f)];
    size >>>= 4;
    while (size > 0) {
      bytes[bytes.length - 1]! |= 0x80;
      bytes.push(size & 0x7f);
      size >>>= 7;
    }
    parts.push(Uint8Array.from(bytes), zlibSync(o.data));
  }
  const body = concatBytes(parts);
  const trailer = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
  return concatBytes([body, trailer]);
}

async function makeCommit(files: Record<string, string>, parents: string[], message: string): Promise<{ commit: Obj; all: Obj[] }> {
  const blobs = await Promise.all(Object.values(files).map((s) => obj('blob', enc.encode(s))));
  const names = Object.keys(files);
  const tree = await obj('tree', serializeTree(blobs.map((b, i) => ({ mode: '100644', name: names[i]!, sha: b.sha }))));
  const sig = { name: 'Dev', email: 'dev@team.gg', time: 1_700_000_000 + parents.length, tz: '+0000' };
  const commit = await obj('commit', serializeCommit({ tree: tree.sha, parents, author: sig, committer: sig, message }));
  return { commit, all: [...blobs, tree, commit] };
}

async function push(updates: { old: string; new: string; ref: string }[], objects: Obj[]): Promise<string> {
  const lines = updates.map((u, i) => pkt(`${u.old} ${u.new} ${u.ref}${i === 0 ? '\0report-status' : ''}\n`));
  const pack = objects.length ? await buildPack(objects) : new Uint8Array();
  const res = await git('/git-receive-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: concatBytes([...lines, FLUSH, pack]),
  });
  expect(res.status).toBe(200);
  return dec.decode(await res.arrayBuffer());
}

const ZERO = '0'.repeat(40);

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}
let firstCommit = '';

beforeAll(async () => {
  const setup = await call('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ name: 'Root', email: 'root@team.gg', password: 'correct-horse-battery' }),
  }, '');
  expect(setup.res.status).toBe(201);
  adminCookie = setup.res.headers.get('set-cookie')!.split(';')[0]!;

  const invite = await call('/api/admin/invites', { method: 'POST', body: JSON.stringify({ role: 'uploader' }) });
  const accept = await call('/api/auth/accept', {
    method: 'POST',
    body: JSON.stringify({ code: invite.body.code, name: 'Reviewer', email: 'rev@team.gg', password: 'long-enough-pass' }),
  }, '');
  expect(accept.res.status).toBe(201);
  reviewerCookie = accept.res.headers.get('set-cookie')!.split(';')[0]!;

  const proj = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Git Repo' }) });
  slug = proj.body.project.slug;
  const token = await call('/api/me/tokens', { method: 'POST', body: JSON.stringify({ name: 'Desktop' }) });
  expect(token.res.status).toBe(201);
  pat = token.body.token;
  expect(pat.startsWith('gctp_')).toBe(true);
});

describe('git smart HTTP', () => {
  it('asks for credentials and rejects bad ones', async () => {
    const none = await git('/info/refs?service=git-upload-pack', {}, '');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Basic');
    const bad = await git('/info/refs?service=git-upload-pack', {}, 'gctp_nope');
    expect(bad.status).toBe(401);
    const ok = await git('/info/refs?service=git-receive-pack');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/x-git-receive-pack-advertisement');
    expect(dec.decode(await ok.arrayBuffer())).toContain('# service=git-receive-pack');
  });

  it('accepts a pushed pack and serves it through the repo API', async () => {
    const { commit, all } = await makeCommit({ 'README.md': '# Hello\n', 'config.lua': 'x = 1\n' }, [], 'Initial commit');
    firstCommit = commit.sha;
    const report = await push([{ old: ZERO, new: commit.sha, ref: 'refs/heads/main' }], all);
    expect(report).toContain('unpack ok');
    expect(report).toContain('ok refs/heads/main');

    const repo = await call(`/api/projects/${slug}/repo`);
    expect(repo.res.status).toBe(200);
    expect(repo.body.defaultBranch).toBe('main');
    expect(repo.body.head.sha).toBe(commit.sha);

    const blob = await call(`/api/projects/${slug}/repo/blob?ref=main&path=config.lua`);
    expect(blob.body.kind).toBe('text');
    expect(blob.body.content).toBe('x = 1\n');
  });

  it('rejects a non-fast-forward push', async () => {
    const { commit, all } = await makeCommit({ 'README.md': 'rewritten\n' }, [], 'Unrelated root');
    const report = await push([{ old: firstCommit, new: commit.sha, ref: 'refs/heads/main' }], all);
    expect(report).toMatch(/ng refs\/heads\/main/);
    const repo = await call(`/api/projects/${slug}/repo`);
    expect(repo.body.head.sha).toBe(firstCommit);
  });

  it('lists refs over protocol v2 and sends a pack over v0', async () => {
    const v2 = await git('/git-upload-pack', {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
      body: concatBytes([pkt('command=ls-refs\n'), pkt('agent=test\n'), new Uint8Array([0x30, 0x30, 0x30, 0x31]), pkt('symrefs\n'), FLUSH]),
    });
    expect(v2.status).toBe(200);
    expect(dec.decode(await v2.arrayBuffer())).toContain(`${firstCommit} refs/heads/main`);

    const v0 = await git('/git-upload-pack', {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body: concatBytes([pkt(`want ${firstCommit} side-band-64k\n`), FLUSH, pkt('done\n')]),
    });
    expect(v0.status).toBe(200);
    const bytes = new Uint8Array(await v0.arrayBuffer());
    expect(dec.decode(bytes)).toContain('PACK');
  });
});

describe('pull requests', () => {
  it('commits from the web to a branch and merges a reviewed pull request', async () => {
    const edit = await call(`/api/projects/${slug}/repo/contents?path=config.lua`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'x = 2\n', branch: 'main', parent: firstCommit, newBranch: 'tweak', message: 'Bump x' }),
    });
    expect(edit.res.status).toBe(200);
    expect(edit.body.branch).toBe('tweak');

    const protect = await call(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify({ protectDefault: true }) });
    expect(protect.res.status).toBe(200);
    const direct = await call(`/api/projects/${slug}/repo/contents?path=config.lua`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'x = 3\n', branch: 'main' }),
    });
    expect(direct.res.status).toBe(409);

    const pr = await call(`/api/projects/${slug}/pulls`, { method: 'POST', body: JSON.stringify({ head: 'tweak', base: 'main', title: 'Bump x' }) });
    expect(pr.res.status).toBe(201);
    const n = pr.body.number;

    const files = await call(`/api/projects/${slug}/pulls/${n}/files`);
    expect(files.res.status).toBe(200);
    expect(JSON.stringify(files.body)).toContain('config.lua');

    const early = await call(`/api/projects/${slug}/pulls/${n}/merge`, { method: 'POST', body: JSON.stringify({}) });
    expect(early.res.status).toBe(403);

    const review = await call(`/api/projects/${slug}/pulls/${n}/reviews`, { method: 'POST', body: JSON.stringify({ state: 'approved' }) }, reviewerCookie);
    expect(review.res.status).toBe(201);

    const merge = await call(`/api/projects/${slug}/pulls/${n}/merge`, { method: 'POST', body: JSON.stringify({ deleteBranch: true }) });
    expect(merge.res.status).toBe(200);

    const issue = await call(`/api/projects/${slug}/issues/${n}`);
    expect(issue.body.issue.state).toBe('merged');
    // The merged PR keeps showing what it merged, not the now-empty range.
    expect(issue.body.pull.commits).toHaveLength(1);
    const after = await call(`/api/projects/${slug}/pulls/${n}/files`);
    expect(after.body.files.map((f: { path: string }) => f.path)).toEqual(['config.lua']);
    const blob = await call(`/api/projects/${slug}/repo/blob?ref=main&path=config.lua`);
    expect(blob.body.content).toBe('x = 2\n');
    const repo = await call(`/api/projects/${slug}/repo`);
    expect(repo.body.branches.map((b: { name: string }) => b.name)).toEqual(['main']);
    expect(repo.body.head.parents).toHaveLength(2);
  });

  it('lets anyone signed in open an issue and comment', async () => {
    const issue = await call(`/api/projects/${slug}/issues`, { method: 'POST', body: JSON.stringify({ title: 'Crash on spawn', body: 'Steps…' }) }, reviewerCookie);
    expect(issue.res.status).toBe(201);
    const comment = await call(`/api/projects/${slug}/issues/${issue.body.number}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Looking' }) });
    expect(comment.res.status).toBe(201);
    const list = await call(`/api/projects/${slug}/issues?state=open`);
    expect(JSON.stringify(list.body)).toContain('Crash on spawn');
  });
});

describe('starter download', () => {
  it('builds a resumable bundle whose ranges stitch into a valid pack', async () => {
    const big = new Uint8Array(9_000_000);
    for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, i + 65536));
    const sig = { name: 'Dev', email: 'dev@team.gg', time: 1_700_000_100, tz: '+0000' };
    const bigBlob = await obj('blob', big);
    const mid = await obj('blob', crypto.getRandomValues(new Uint8Array(65536)).slice(0, 65536));
    const head = (await call(`/api/projects/${slug}/repo`)).body.head.sha as string;
    const headCommit = await call(`/api/projects/${slug}/repo/tree?ref=main&path=`);
    const entries = headCommit.body.entries.filter((e: { type: string }) => e.type === 'blob').map((e: { name: string; sha: string }) => ({ mode: '100644', name: e.name, sha: e.sha }));
    const tree = await obj('tree', serializeTree([...entries, { mode: '100644', name: 'big.bin', sha: bigBlob.sha }, { mode: '100644', name: 'mid.bin', sha: mid.sha }]));
    const commit = await obj('commit', serializeCommit({ tree: tree.sha, parents: [head], author: sig, committer: sig, message: 'Add assets' }));
    const report = await push([{ old: ZERO, new: commit.sha, ref: 'refs/heads/assets' }], [bigBlob, mid, tree, commit]);
    expect(report).toContain('ok refs/heads/assets');

    const start = await call(`/api/projects/${slug}/repo/starter`, { method: 'POST' });
    expect(start.res.status).toBe(201);
    const project = await env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(slug).first<{ id: string }>();
    // A tiny byte budget forces a stop after every chunk, including mid-blob.
    let steps = 0;
    for (;;) {
      const s = await starterStep(env, project!.id, 1);
      steps++;
      if (s.status !== 'building') break;
    }
    expect(steps).toBeGreaterThan(2);
    const state = await getStarter(env.BUCKET, project!.id);
    expect(state!.status).toBe('ready');

    const fullRes = await worker.fetch(`${ORIGIN}/api/projects/${slug}/repo/starter/download`, { headers: { cookie: adminCookie } });
    const bytes = new Uint8Array(await fullRes.arrayBuffer());
    expect(bytes.length).toBe(state!.size);

    const parts: Uint8Array[] = [];
    for (let p = 0; p < bytes.length; p += 3_000_001) {
      const res = await worker.fetch(`${ORIGIN}/api/projects/${slug}/repo/starter/download`, {
        headers: { cookie: adminCookie, range: `bytes=${p}-${Math.min(bytes.length, p + 3_000_001) - 1}`, 'if-range': `"${state!.id}"` },
      });
      expect(res.status).toBe(206);
      parts.push(new Uint8Array(await res.arrayBuffer()));
    }
    expect(firstDiff(concatBytes(parts), bytes)).toBe(-1);

    const text = dec.decode(bytes.subarray(0, 400));
    expect(text.startsWith('# v2 git bundle\n')).toBe(true);
    expect(text).toContain(`${commit.sha} refs/heads/assets`);
    const packAt = text.indexOf('\n\n') + 2;
    const pack = bytes.subarray(packAt);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', pack.subarray(0, pack.length - 20)));
    expect(firstDiff(pack.subarray(pack.length - 20), digest)).toBe(-1);
  });
});
