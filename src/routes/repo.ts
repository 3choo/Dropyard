import { Hono, type Context } from 'hono';
import { audit } from '../lib/audit';
import { attachment, badRequest, conflict, notFound, tooLarge } from '../lib/http';
import { nowMs, sanitizeFilePath } from '../lib/ids';
import { contentTypeForPath, MAX_TEXT_BLOB_BYTES } from '../lib/mime';
import { requireRole, requireSession, sessionUser, type AppEnv } from '../middleware';
import { asText, readBlobBytes, withPatches } from '../git/diffs';
import { ImportError, getImport, importStep, presentImport, startImport } from '../git/importer';
import {
  MODE_EXEC,
  MODE_FILE,
  MODE_GITLINK,
  MODE_SYMLINK,
  commitSubject,
  hashObject,
  isTreeMode,
  signatureNow,
} from '../git/objects';
import {
  countCommits,
  createCommit,
  diffTrees,
  getCommitRow,
  getRef,
  isAncestor,
  listRefs,
  logCommits,
  lookupPath,
  mergeBase,
  readCommit,
  readTree,
  resolveCommit,
  updateRef,
  updateTree,
  validRefName,
  type CommitRow,
} from '../git/repo';
import { StarterError, getStarter, parseRange, presentStarter, startStarter, starterStep, starterStream } from '../git/starter';
import { GitStore } from '../git/store';
import { isProtectedBranch, loadProject as loadProjectRow, type ProjectRow } from './projects';
import { getBucket } from '../lib/storage';

/** Web API over each project's Git repository: browse, history, diffs, web edits. */
export const repoRoutes = new Hono<AppEnv>();

async function loadProject(c: Context<AppEnv>): Promise<{ project: ProjectRow; store: GitStore }> {
  const project = await loadProjectRow(c);
  return { project, store: new GitStore(c.env, project.id) };
}

export function presentCommit(r: CommitRow) {
  return {
    sha: r.sha,
    tree: r.tree,
    parents: r.parents,
    authorName: r.author_name,
    authorEmail: r.author_email,
    authoredAt: r.author_time * 1000,
    committedAt: r.committer_time * 1000,
    subject: commitSubject(r.message),
    message: r.message,
  };
}

async function resolveOr404(store: GitStore, ref: string): Promise<string> {
  const sha = await resolveCommit(store, ref);
  if (!sha) throw notFound(`No branch, tag or commit named "${ref}"`);
  return sha;
}

function entryKind(mode: string): 'tree' | 'blob' | 'symlink' | 'submodule' {
  if (isTreeMode(mode)) return 'tree';
  if (mode === MODE_SYMLINK) return 'symlink';
  if (mode === MODE_GITLINK) return 'submodule';
  return 'blob';
}

const README_RE = /^readme(\.(md|markdown|txt))?$/i;

repoRoutes.get('/:slug/repo', requireSession(), async (c) => {
  const { project } = await loadProject(c);
  const refs = await listRefs(c.env.DB, project.id);
  const branches = refs.filter((r) => r.name.startsWith('refs/heads/'));
  const tags = refs.filter((r) => r.name.startsWith('refs/tags/'));
  const headIndex = branches.findIndex((b) => b.name === `refs/heads/${project.default_branch}`);
  const headSha = branches[headIndex]?.sha ?? null;
  const [tipRows, published, commitCount, importRow] = await Promise.all([
    Promise.all(branches.map((b) => getCommitRow(c.env.DB, project.id, b.sha))),
    c.env.DB
      .prepare("SELECT COUNT(*) AS n FROM releases WHERE project_id = ? AND status = 'published'")
      .bind(project.id)
      .first<{ n: number }>(),
    headSha ? countCommits(c.env.DB, project.id, headSha) : 0,
    getImport(c.env.DB, project.id),
  ]);
  const head = tipRows[headIndex] ?? null;
  const origin = new URL(c.req.url).origin;
  return c.json({
    defaultBranch: project.default_branch,
    protectDefault: project.protect_default === 1,
    empty: refs.length === 0,
    cloneUrl: `${origin}/git/${project.slug}.git`,
    head: head ? presentCommit(head) : null,
    commitCount,
    branches: branches.map((b, i) => ({
      name: b.name.slice('refs/heads/'.length),
      sha: b.sha,
      commit: tipRows[i] ? presentCommit(tipRows[i]!) : null,
    })),
    tags: tags.map((t) => ({ name: t.name.slice('refs/tags/'.length), sha: t.sha })),
    import: presentImport(importRow),
    canImport: refs.length === 0 && (published?.n ?? 0) > 0,
  });
});

repoRoutes.get('/:slug/repo/tree', requireSession(), async (c) => {
  const { project, store } = await loadProject(c);
  const ref = c.req.query('ref') || project.default_branch;
  const rawPath = (c.req.query('path') ?? '').replace(/^\/+|\/+$/g, '');
  const path = rawPath === '' ? '' : sanitizeFilePath(rawPath);
  if (path === null) throw badRequest('Invalid path');
  const sha = await resolveOr404(store, ref);
  const commit = await readCommit(store, sha);
  const entry = await lookupPath(store, commit.tree, path);
  if (!entry) throw notFound('Path not found at this ref');
  if (!isTreeMode(entry.mode)) return c.json({ kind: 'blob', ref, commit: sha, path });
  const entries = await readTree(store, entry.sha);
  const metas = await store.metas(entries.filter((e) => !isTreeMode(e.mode)).map((e) => e.sha));
  const list = entries
    .map((e) => ({
      name: e.name,
      path: path ? `${path}/${e.name}` : e.name,
      type: entryKind(e.mode),
      sha: e.sha,
      size: isTreeMode(e.mode) ? null : metas.get(e.sha)?.size ?? null,
    }))
    .sort((a, b) => (a.type === 'tree') === (b.type === 'tree') ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1);
  let readme: { path: string; content: string } | null = null;
  const readmeEntry = entries.find((e) => !isTreeMode(e.mode) && README_RE.test(e.name));
  const readmeMeta = readmeEntry ? metas.get(readmeEntry.sha) : undefined;
  if (readmeEntry && readmeMeta && readmeMeta.size <= 512 * 1024) {
    const text = asText(await readBlobBytes(store, readmeMeta));
    if (text !== null) readme = { path: path ? `${path}/${readmeEntry.name}` : readmeEntry.name, content: text };
  }
  const last = await getCommitRow(c.env.DB, project.id, sha);
  return c.json({ kind: 'tree', ref, commit: sha, path, entries: list, readme, lastCommit: last ? presentCommit(last) : null });
});

repoRoutes.get('/:slug/repo/blob', requireSession(), async (c) => {
  const { project, store } = await loadProject(c);
  const ref = c.req.query('ref') || project.default_branch;
  const path = sanitizeFilePath(c.req.query('path') ?? '');
  if (!path) throw badRequest('A valid file path is required');
  const sha = await resolveOr404(store, ref);
  const commit = await readCommit(store, sha);
  const entry = await lookupPath(store, commit.tree, path);
  if (!entry || isTreeMode(entry.mode)) throw notFound('File not found at this ref');
  const meta = await store.meta(entry.sha);
  if (!meta) throw notFound('Stored object is missing; contact an admin');
  const rawUrl = `/api/projects/${project.slug}/repo/raw?ref=${sha}&path=${encodeURIComponent(path)}`;
  const base = { path, ref, commit: sha, sha: entry.sha, mode: entry.mode, size: meta.size, contentType: contentTypeForPath(path), rawUrl };
  if (meta.size <= MAX_TEXT_BLOB_BYTES) {
    const text = asText(await readBlobBytes(store, meta));
    if (text !== null) return c.json({ kind: 'text', ...base, content: text });
  }
  return c.json({ kind: 'binary', ...base });
});

repoRoutes.get('/:slug/repo/raw', requireSession(), async (c) => {
  const { project, store } = await loadProject(c);
  const ref = c.req.query('ref') || project.default_branch;
  const path = sanitizeFilePath(c.req.query('path') ?? '');
  if (!path) throw badRequest('A valid file path is required');
  const sha = await resolveOr404(store, ref);
  const entry = await lookupPath(store, (await readCommit(store, sha)).tree, path);
  if (!entry || isTreeMode(entry.mode)) throw notFound('File not found at this ref');
  const meta = await store.meta(entry.sha);
  if (!meta) throw notFound('Stored object is missing; contact an admin');
  const headers = new Headers({
    'content-type': contentTypeForPath(path),
    'content-disposition': attachment(path.split('/').pop()!),
    'content-length': String(meta.size),
    'cache-control': 'private, max-age=0, must-revalidate',
    etag: `"${entry.sha}"`,
  });
  if (!meta.r2_key) return new Response(await readBlobBytes(store, meta), { headers });
  const obj = await getBucket(c.env).get(meta.r2_key);
  if (!obj) throw notFound('Stored object is missing; contact an admin');
  return new Response(obj.body, { headers });
});

repoRoutes.get('/:slug/repo/commits', requireSession(), async (c) => {
  const { project, store } = await loadProject(c);
  const ref = c.req.query('ref') || project.default_branch;
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const perPage = 30;
  const sha = await resolveOr404(store, ref);
  const rows = await logCommits(c.env.DB, project.id, sha, { limit: perPage + 1, offset: (page - 1) * perPage });
  const releases = await c.env.DB
    .prepare('SELECT version, commit_sha, status FROM releases WHERE project_id = ? AND commit_sha IS NOT NULL')
    .bind(project.id)
    .all<{ version: string; commit_sha: string; status: string }>();
  const byCommit = new Map<string, string[]>();
  for (const r of releases.results) byCommit.set(r.commit_sha, [...(byCommit.get(r.commit_sha) ?? []), r.version]);
  return c.json({
    ref,
    commits: rows.slice(0, perPage).map((r) => ({ ...presentCommit(r), releases: byCommit.get(r.sha) ?? [] })),
    hasMore: rows.length > perPage,
    page,
  });
});

repoRoutes.get('/:slug/repo/commits/:sha', requireSession(), async (c) => {
  const { project, store } = await loadProject(c);
  const sha = await resolveOr404(store, c.req.param('sha') ?? '');
  const row = await getCommitRow(c.env.DB, project.id, sha);
  if (!row) throw notFound('Commit not found');
  const parentTree = row.parents[0] ? (await readCommit(store, row.parents[0])).tree : null;
  const files = await withPatches(store, await diffTrees(store, parentTree, row.tree));
  const branches = (await listRefs(c.env.DB, project.id)).filter((r) => r.name.startsWith('refs/heads/'));
  const containing: string[] = [];
  for (const b of branches) {
    if (await isAncestor(c.env.DB, project.id, sha, b.sha)) containing.push(b.name.slice('refs/heads/'.length));
  }
  return c.json({ commit: presentCommit(row), files, branches: containing });
});

repoRoutes.get('/:slug/repo/compare', requireSession(), async (c) => {
  const { project, store } = await loadProject(c);
  const baseRef = c.req.query('base') || project.default_branch;
  const headRef = c.req.query('head') ?? '';
  if (!headRef) throw badRequest('Choose something to compare');
  const base = await resolveOr404(store, baseRef);
  const head = await resolveOr404(store, headRef);
  const mb = await mergeBase(c.env.DB, project.id, base, head);
  const fromTree = mb ? (await readCommit(store, mb)).tree : null;
  const toTree = (await readCommit(store, head)).tree;
  const commits = await logCommits(c.env.DB, project.id, head, { limit: 250, exclude: mb });
  const files = await withPatches(store, await diffTrees(store, fromTree, toTree));
  return c.json({
    base: { ref: baseRef, sha: base },
    head: { ref: headRef, sha: head },
    mergeBase: mb,
    commits: commits.map(presentCommit),
    files,
  });
});

// ------------------------------------------------------------- web commits

async function branchTip(store: GitStore, branch: string): Promise<string | null> {
  return getRef(store.db, store.projectId, `refs/heads/${branch}`);
}

repoRoutes.put('/:slug/repo/contents', requireRole('admin', 'uploader'), async (c) => {
  const { project, store } = await loadProject(c);
  const user = sessionUser(c);
  const path = sanitizeFilePath(c.req.query('path') ?? '');
  if (!path) throw badRequest('A valid file path is required');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { content, message, branch: rawBranch, parent, previousPath, newBranch } = (body ?? {}) as {
    content?: string;
    message?: string;
    branch?: string;
    parent?: string;
    previousPath?: string;
    newBranch?: string;
  };
  if (typeof content !== 'string') throw badRequest('content must be a string');
  const branch = rawBranch || project.default_branch;
  if (!validRefName(`refs/heads/${branch}`)) throw badRequest('Invalid branch name');
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_TEXT_BLOB_BYTES) throw tooLarge('Files edited in the browser are capped at 1 MB');

  // Committing to a new branch (GitHub's "create a new branch and start a pull request").
  const target = newBranch?.trim() || branch;
  if (target !== branch) {
    if (!validRefName(`refs/heads/${target}`)) throw badRequest('Invalid new branch name');
    if (await branchTip(store, target)) throw conflict(`A branch named "${target}" already exists`);
  }
  if (isProtectedBranch(project, target)) {
    throw conflict(`${target} is protected: commit to a new branch and open a pull request`);
  }
  const tip = await branchTip(store, branch);
  if (parent && tip && parent !== tip) {
    throw conflict('The branch moved since you opened this file — reload to get the latest version, then edit again');
  }
  const blobSha = await hashObject('blob', bytes);
  if (!(await store.meta(blobSha))) await store.putObject(blobSha, 'blob', bytes);
  const baseTree = tip ? (await readCommit(store, tip)).tree : null;
  const existing = baseTree ? await lookupPath(store, baseTree, path) : null;
  const changes = new Map<string, { mode: string; sha: string } | null>();
  changes.set(path, { mode: existing?.mode === MODE_EXEC ? MODE_EXEC : MODE_FILE, sha: blobSha });
  const prev = previousPath ? sanitizeFilePath(previousPath) : null;
  if (prev && prev !== path) changes.set(prev, null);
  const tree = await updateTree(store, baseTree, changes);
  const subject = (message ?? '').trim() || `${existing ? 'Update' : 'Create'} ${path}`;
  const commit = await createCommit(store, {
    tree,
    parents: tip ? [tip] : [],
    author: signatureNow(user.name, user.email),
    message: subject,
  });
  await store.flush();
  const expected = target === branch ? tip : null;
  if (!(await updateRef(c.env.DB, project.id, `refs/heads/${target}`, expected, commit, user.id))) {
    throw conflict('The branch moved while saving — reload and try again');
  }
  await c.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(nowMs(), project.id).run();
  await audit(c.env.DB, user.email, 'git.commit', `project:${project.slug}/${target}`, { path, commit });
  return c.json({ commit, branch: target, path });
});

repoRoutes.delete('/:slug/repo/contents', requireRole('admin', 'uploader'), async (c) => {
  const { project, store } = await loadProject(c);
  const user = sessionUser(c);
  const path = sanitizeFilePath(c.req.query('path') ?? '');
  if (!path) throw badRequest('A valid file path is required');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const branch = (typeof body?.branch === 'string' && body.branch) || project.default_branch;
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (isProtectedBranch(project, branch)) {
    throw conflict(`${branch} is protected: commit to a new branch and open a pull request`);
  }
  const tip = await branchTip(store, branch);
  if (!tip) throw notFound('Branch not found');
  const baseTree = (await readCommit(store, tip)).tree;
  const existing = await lookupPath(store, baseTree, path);
  if (!existing || isTreeMode(existing.mode)) throw notFound('File not found on this branch');
  const tree = await updateTree(store, baseTree, new Map([[path, null]]));
  const commit = await createCommit(store, {
    tree,
    parents: [tip],
    author: signatureNow(user.name, user.email),
    message: message || `Delete ${path}`,
  });
  await store.flush();
  if (!(await updateRef(c.env.DB, project.id, `refs/heads/${branch}`, tip, commit, user.id))) {
    throw conflict('The branch moved while saving — reload and try again');
  }
  await audit(c.env.DB, user.email, 'git.commit', `project:${project.slug}/${branch}`, { deleted: path, commit });
  return c.json({ commit, branch });
});

repoRoutes.post('/:slug/repo/branches', requireRole('admin', 'uploader'), async (c) => {
  const { project, store } = await loadProject(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const from = typeof body?.from === 'string' && body.from ? body.from : project.default_branch;
  if (!validRefName(`refs/heads/${name}`)) throw badRequest('Branch names can use letters, numbers, ".", "_", "-" and "/"');
  const sha = await resolveOr404(store, from);
  if (!(await updateRef(c.env.DB, project.id, `refs/heads/${name}`, null, sha, sessionUser(c).id))) {
    throw conflict(`A branch named "${name}" already exists`);
  }
  await audit(c.env.DB, sessionUser(c).email, 'git.branch.create', `project:${project.slug}/${name}`, { from: sha });
  return c.json({ name, sha }, 201);
});

repoRoutes.delete('/:slug/repo/branches/:name{.+}', requireRole('admin', 'uploader'), async (c) => {
  const { project } = await loadProject(c);
  const name = c.req.param('name') ?? '';
  if (name === project.default_branch) throw badRequest('The default branch cannot be deleted');
  const sha = await getRef(c.env.DB, project.id, `refs/heads/${name}`);
  if (!sha) throw notFound('Branch not found');
  await updateRef(c.env.DB, project.id, `refs/heads/${name}`, sha, null, sessionUser(c).id);
  await audit(c.env.DB, sessionUser(c).email, 'git.branch.delete', `project:${project.slug}/${name}`, { sha });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ import

repoRoutes.post('/:slug/repo/import', requireRole('admin', 'uploader'), async (c) => {
  const { project } = await loadProject(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const mode = body?.mode === 'all' ? 'all' : 'latest';
  try {
    const row = await startImport(c.env, project.id, sessionUser(c).id, mode);
    await audit(c.env.DB, sessionUser(c).email, 'git.import.start', `project:${project.slug}`, { mode });
    return c.json({ import: presentImport(row) }, 201);
  } catch (err) {
    if (err instanceof ImportError) throw badRequest(err.message);
    throw err;
  }
});

repoRoutes.post('/:slug/repo/import/step', requireRole('admin', 'uploader'), async (c) => {
  const { project } = await loadProject(c);
  try {
    const row = await importStep(c.env, project.id, project.default_branch);
    return c.json({ import: presentImport(row) });
  } catch (err) {
    if (err instanceof ImportError) throw badRequest(err.message);
    throw err;
  }
});

// ------------------------------------------------------------------ starter download

repoRoutes.get('/:slug/repo/starter', requireSession(), async (c) => {
  const { project } = await loadProject(c);
  const head = await getRef(c.env.DB, project.id, `refs/heads/${project.default_branch}`);
  return c.json({ starter: presentStarter(await getStarter(getBucket(c.env), project.id)), head });
});

repoRoutes.post('/:slug/repo/starter', requireSession(), async (c) => {
  const { project } = await loadProject(c);
  try {
    const state = await startStarter(c.env, project.id, project.default_branch, sessionUser(c).id);
    await audit(c.env.DB, sessionUser(c).email, 'git.starter.start', `project:${project.slug}`);
    return c.json({ starter: presentStarter(state) }, 201);
  } catch (err) {
    if (err instanceof StarterError) throw conflict(err.message);
    throw err;
  }
});

repoRoutes.post('/:slug/repo/starter/step', requireSession(), async (c) => {
  const { project } = await loadProject(c);
  try {
    return c.json({ starter: presentStarter(await starterStep(c.env, project.id)) });
  } catch (err) {
    if (err instanceof StarterError) throw badRequest(err.message);
    throw err;
  }
});

repoRoutes.get('/:slug/repo/starter/download', requireSession(), async (c) => {
  const { project } = await loadProject(c);
  const state = await getStarter(getBucket(c.env), project.id);
  if (!state || state.status !== 'ready') throw notFound('The starter download is not ready yet');
  const etag = `"${state.id}"`;
  const ifRange = c.req.header('if-range');
  const range = ifRange && ifRange !== etag ? null : parseRange(c.req.header('range'), state.size);
  const headers = new Headers({
    'content-type': 'application/x-git-bundle',
    'content-disposition': attachment(`${project.slug}.bundle`),
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'private, no-store',
  });
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${state.size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : state.size - 1;
  const body = await starterStream(getBucket(c.env), project.id, state, start, end);
  const { readable, writable } = new FixedLengthStream(end - start + 1);
  c.executionCtx.waitUntil(body.pipeTo(writable).catch((err) => console.error('starter download failed', project.slug, err)));
  if (range) headers.set('content-range', `bytes ${start}-${end}/${state.size}`);
  return new Response(readable, { status: range ? 206 : 200, headers });
});
