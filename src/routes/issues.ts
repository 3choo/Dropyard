import { Hono, type Context } from 'hono';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/http';
import { nowMs, randomId, sanitizeFilePath } from '../lib/ids';
import { requireRole, requireSession, sessionUser, type AppEnv } from '../middleware';
import { withPatches } from '../git/diffs';
import { mergeTrees } from '../git/merge';
import { signatureNow } from '../git/objects';
import {
  createCommit,
  diffTrees,
  getRef,
  isAncestor,
  logCommits,
  mergeBase,
  readCommit,
  updateRef,
  validRefName,
} from '../git/repo';
import { GitStore } from '../git/store';
import { isProtectedBranch, loadProject, type ProjectRow } from './projects';
import { presentCommit } from './repo';

/** Issues, pull requests, reviews and comments. */
export const issueRoutes = new Hono<AppEnv>();

type IssueRow = {
  id: string;
  project_id: string;
  number: number;
  kind: 'issue' | 'pull';
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  author_id: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  closed_by: string | null;
  head_branch: string | null;
  base_branch: string | null;
  head_sha: string | null;
  base_sha: string | null;
  merge_commit: string | null;
  merged_by: string | null;
  merged_at: number | null;
};

async function loadIssue(c: Context<AppEnv>, project: ProjectRow): Promise<IssueRow> {
  const number = parseInt(c.req.param('number') ?? '', 10);
  const row = await c.env.DB
    .prepare('SELECT * FROM issues WHERE project_id = ? AND number = ?')
    .bind(project.id, number)
    .first<IssueRow>();
  if (!row) throw notFound('No issue or pull request with that number');
  return row;
}

async function userNames(db: D1Database, ids: (string | null)[]): Promise<Map<string, { name: string; email: string }>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, { name: string; email: string }>();
  for (let i = 0; i < unique.length; i += 90) {
    const part = unique.slice(i, i + 90);
    const rows = await db
      .prepare(`SELECT id, name, email FROM users WHERE id IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<{ id: string; name: string; email: string }>();
    for (const r of rows.results) out.set(r.id, { name: r.name, email: r.email });
  }
  return out;
}

function person(users: Map<string, { name: string; email: string }>, id: string | null) {
  if (!id) return null;
  const u = users.get(id);
  return u ? { id, name: u.name, email: u.email } : { id, name: 'Former member', email: '' };
}

function presentIssue(r: IssueRow, users: Map<string, { name: string; email: string }>, extra: Record<string, unknown> = {}) {
  return {
    number: r.number,
    kind: r.kind,
    title: r.title,
    body: r.body,
    state: r.state,
    author: person(users, r.author_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
    headBranch: r.head_branch,
    baseBranch: r.base_branch,
    headSha: r.head_sha,
    mergeCommit: r.merge_commit,
    mergedBy: person(users, r.merged_by),
    mergedAt: r.merged_at,
    ...extra,
  };
}

async function addEvent(db: D1Database, issueId: string, actorId: string | null, kind: string, meta?: unknown) {
  await db
    .prepare('INSERT INTO issue_events (id, issue_id, actor_id, kind, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(randomId(9), issueId, actorId, kind, meta === undefined ? null : JSON.stringify(meta), nowMs())
    .run();
}

async function createNumbered(
  db: D1Database,
  project: ProjectRow,
  fields: { kind: 'issue' | 'pull'; title: string; body: string; authorId: string; head?: string; base?: string; headSha?: string; baseSha?: string },
): Promise<IssueRow> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomId(9);
    const now = nowMs();
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO issues (id, project_id, number, kind, title, body, author_id, created_at, updated_at, head_branch, base_branch, head_sha, base_sha)
         SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM issues WHERE project_id = ?`,
      )
      .bind(id, project.id, fields.kind, fields.title, fields.body, fields.authorId, now, now, fields.head ?? null, fields.base ?? null, fields.headSha ?? null, fields.baseSha ?? null, project.id)
      .run();
    if (res.meta.changes) return (await db.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first<IssueRow>())!;
  }
  throw conflict('Could not allocate a number; try again');
}

function cleanTitle(v: unknown): string {
  const title = typeof v === 'string' ? v.trim() : '';
  if (title.length < 1 || title.length > 256) throw badRequest('A title (up to 256 characters) is required');
  return title;
}

function cleanBody(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw badRequest('body must be text');
  if (v.length > 65536) throw badRequest('That text is too long (64 KB max)');
  return v;
}

// --------------------------------------------------------------- PR state

type PullStatus = {
  headSha: string | null;
  baseSha: string | null;
  mergeBase: string | null;
  ahead: number;
  behind: number;
  mergeable: boolean;
  conflicts: string[];
  branchMissing: boolean;
};

async function pullStatus(store: GitStore, pr: IssueRow): Promise<PullStatus> {
  const [head, base] = await Promise.all([
    getRef(store.db, store.projectId, `refs/heads/${pr.head_branch}`),
    getRef(store.db, store.projectId, `refs/heads/${pr.base_branch}`),
  ]);
  // A merged or closed pull request shows the range it had when it ended,
  // not whatever the branches point at now.
  const frozen = pr.state !== 'open';
  const status: PullStatus = {
    headSha: frozen ? (pr.head_sha ?? head) : (head ?? pr.head_sha),
    baseSha: frozen ? (pr.base_sha ?? base) : (base ?? pr.base_sha),
    mergeBase: null,
    ahead: 0,
    behind: 0,
    mergeable: false,
    conflicts: [],
    branchMissing: !head || !base,
  };
  if (!status.headSha || !status.baseSha) return status;
  status.mergeBase = await mergeBase(store.db, store.projectId, status.baseSha, status.headSha);
  const count = async (tip: string, exclude: string | null) =>
    (await logCommits(store.db, store.projectId, tip, { limit: 1000, exclude })).length;
  [status.ahead, status.behind] = await Promise.all([
    count(status.headSha, status.mergeBase),
    count(status.baseSha, status.mergeBase),
  ]);
  if (pr.state === 'open' && head && base && status.ahead > 0) {
    if (status.behind === 0) status.mergeable = true;
    else {
      const [b, o, t] = await Promise.all([
        status.mergeBase ? readCommit(store, status.mergeBase) : null,
        readCommit(store, base),
        readCommit(store, head),
      ]);
      const merged = await mergeTrees(store, b?.tree ?? null, o.tree, t.tree);
      status.conflicts = merged.conflicts;
      status.mergeable = merged.conflicts.length === 0;
    }
  }
  return status;
}

/** Each reviewer's latest verdict: approvals (not counting the PR's author) and change requests. */
function reviewTally(reviews: { author_id: string | null; state: string }[], prAuthor: string | null) {
  const latest = new Map<string, string>();
  for (const r of reviews) if (r.author_id && r.state !== 'commented') latest.set(r.author_id, r.state);
  return {
    approvals: [...latest.entries()].filter(([who, s]) => s === 'approved' && who !== prAuthor).length,
    changesRequested: [...latest.values()].filter((s) => s === 'changes_requested').length,
  };
}

/** A PR merged outside gitctx (pushed from GitHub Desktop) is marked merged when seen. */
async function syncMergedElsewhere(db: D1Database, pr: IssueRow, status: PullStatus): Promise<IssueRow> {
  if (pr.state !== 'open' || status.branchMissing || !status.headSha || !status.baseSha || status.ahead > 0) return pr;
  if (!(await isAncestor(db, pr.project_id, status.headSha, status.baseSha))) return pr;
  const now = nowMs();
  await db
    .prepare("UPDATE issues SET state = 'merged', merged_at = ?, head_sha = ?, updated_at = ? WHERE id = ? AND state = 'open'")
    .bind(now, status.headSha, now, pr.id)
    .run();
  await addEvent(db, pr.id, null, 'merged', { external: true });
  return { ...pr, state: 'merged', merged_at: now, head_sha: status.headSha };
}

// ------------------------------------------------------------------ routes

issueRoutes.get('/:slug/issues', requireSession(), async (c) => {
  const project = await loadProject(c);
  const kind = c.req.query('kind') === 'pull' ? 'pull' : 'issue';
  const state = c.req.query('state') ?? 'open';
  const stateClause = state === 'all' ? '' : state === 'closed' ? "AND i.state IN ('closed','merged')" : "AND i.state = 'open'";
  const rows = await c.env.DB
    .prepare(
      `SELECT i.*, (SELECT COUNT(*) FROM comments m WHERE m.project_id = i.project_id AND m.target_type = 'issue' AND m.target_id = i.id) AS comment_count
       FROM issues i WHERE i.project_id = ? AND i.kind = ? ${stateClause} ORDER BY i.number DESC LIMIT 200`,
    )
    .bind(project.id, kind)
    .all<IssueRow & { comment_count: number }>();
  const counts = await c.env.DB
    .prepare(
      `SELECT SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN state != 'open' THEN 1 ELSE 0 END) AS closed
       FROM issues WHERE project_id = ? AND kind = ?`,
    )
    .bind(project.id, kind)
    .first<{ open: number | null; closed: number | null }>();
  const users = await userNames(c.env.DB, rows.results.map((r) => r.author_id));
  return c.json({
    items: rows.results.map((r) => presentIssue(r, users, { commentCount: r.comment_count })),
    open: counts?.open ?? 0,
    closed: counts?.closed ?? 0,
  });
});

issueRoutes.post('/:slug/issues', requireSession(), async (c) => {
  const project = await loadProject(c);
  const user = sessionUser(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const row = await createNumbered(c.env.DB, project, {
    kind: 'issue',
    title: cleanTitle(body?.title),
    body: cleanBody(body?.body),
    authorId: user.id,
  });
  await audit(c.env.DB, user.email, 'issue.create', `project:${project.slug}#${row.number}`);
  return c.json({ number: row.number }, 201);
});

issueRoutes.post('/:slug/pulls', requireRole('admin', 'uploader'), async (c) => {
  const project = await loadProject(c);
  const user = sessionUser(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const head = typeof body?.head === 'string' ? body.head : '';
  const base = typeof body?.base === 'string' && body.base ? body.base : project.default_branch;
  if (!validRefName(`refs/heads/${head}`) || !validRefName(`refs/heads/${base}`)) throw badRequest('Pick a branch to merge');
  if (head === base) throw badRequest('Choose two different branches');
  const headSha = await getRef(c.env.DB, project.id, `refs/heads/${head}`);
  const baseSha = await getRef(c.env.DB, project.id, `refs/heads/${base}`);
  if (!headSha || !baseSha) throw notFound('Branch not found');
  const open = await c.env.DB
    .prepare("SELECT number FROM issues WHERE project_id = ? AND kind = 'pull' AND state = 'open' AND head_branch = ? AND base_branch = ?")
    .bind(project.id, head, base)
    .first<{ number: number }>();
  if (open) throw conflict(`Pull request #${open.number} already proposes ${head} → ${base}`);
  if (await isAncestor(c.env.DB, project.id, headSha, baseSha)) {
    throw badRequest(`${base} already contains everything on ${head}`);
  }
  const row = await createNumbered(c.env.DB, project, {
    kind: 'pull',
    title: cleanTitle(body?.title),
    body: cleanBody(body?.body),
    authorId: user.id,
    head,
    base,
    headSha,
    baseSha,
  });
  await audit(c.env.DB, user.email, 'pull.create', `project:${project.slug}#${row.number}`, { head, base });
  return c.json({ number: row.number }, 201);
});

issueRoutes.get('/:slug/issues/:number', requireSession(), async (c) => {
  const project = await loadProject(c);
  let issue = await loadIssue(c, project);
  const comments = await c.env.DB
    .prepare("SELECT * FROM comments WHERE project_id = ? AND target_type = 'issue' AND target_id = ? ORDER BY created_at")
    .bind(project.id, issue.id)
    .all<{ id: string; author_id: string | null; body: string; path: string | null; line: number | null; side: string | null; commit_sha: string | null; review_id: string | null; created_at: number; updated_at: number }>();
  const events = await c.env.DB
    .prepare('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY created_at')
    .bind(issue.id)
    .all<{ id: string; actor_id: string | null; kind: string; meta: string | null; created_at: number }>();
  const reviews = await c.env.DB
    .prepare('SELECT * FROM reviews WHERE issue_id = ? ORDER BY created_at')
    .bind(issue.id)
    .all<{ id: string; author_id: string | null; state: string; body: string; commit_sha: string; created_at: number }>();

  let pull: Record<string, unknown> | null = null;
  if (issue.kind === 'pull') {
    const store = new GitStore(c.env, project.id);
    let status = await pullStatus(store, issue);
    const before = issue.state;
    issue = await syncMergedElsewhere(c.env.DB, issue, status);
    if (issue.state !== before) status = await pullStatus(store, issue);
    else if (issue.state === 'open' && status.ahead > 0 && !status.branchMissing && status.baseSha !== issue.base_sha) {
      // Remember the latest base that did not yet contain the branch, so a
      // merge pushed from GitHub Desktop still shows the right commits later.
      await c.env.DB.prepare('UPDATE issues SET base_sha = ? WHERE id = ?').bind(status.baseSha, issue.id).run();
    }
    const commits = status.headSha
      ? await logCommits(c.env.DB, project.id, status.headSha, { limit: 250, exclude: status.mergeBase })
      : [];
    pull = {
      ...status,
      commits: commits.map(presentCommit),
      ...reviewTally(reviews.results, issue.author_id),
      requiresApproval: isProtectedBranch(project, issue.base_branch),
    };
  }

  const users = await userNames(c.env.DB, [
    issue.author_id,
    issue.merged_by,
    issue.closed_by,
    ...comments.results.map((m) => m.author_id),
    ...events.results.map((e) => e.actor_id),
    ...reviews.results.map((r) => r.author_id),
  ]);
  return c.json({
    issue: presentIssue(issue, users),
    comments: comments.results.map((m) => ({
      id: m.id,
      author: person(users, m.author_id),
      body: m.body,
      path: m.path,
      line: m.line,
      side: m.side,
      commitSha: m.commit_sha,
      reviewId: m.review_id,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    })),
    events: events.results.map((e) => ({
      id: e.id,
      actor: person(users, e.actor_id),
      kind: e.kind,
      meta: e.meta ? JSON.parse(e.meta) : null,
      createdAt: e.created_at,
    })),
    reviews: reviews.results.map((r) => ({
      id: r.id,
      author: person(users, r.author_id),
      state: r.state,
      body: r.body,
      commitSha: r.commit_sha,
      createdAt: r.created_at,
    })),
    pull,
  });
});

issueRoutes.patch('/:slug/issues/:number', requireSession(), async (c) => {
  const project = await loadProject(c);
  const issue = await loadIssue(c, project);
  const user = sessionUser(c);
  const isOwner = issue.author_id === user.id;
  const canManage = user.role !== 'viewer' || isOwner;
  if (!canManage) throw forbidden('Only the author or a teammate with upload access can change this');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const now = nowMs();
  if (body?.title !== undefined || body?.body !== undefined) {
    if (!isOwner && user.role !== 'admin') throw forbidden('Only the author or an admin can edit the text');
    await c.env.DB
      .prepare('UPDATE issues SET title = COALESCE(?, title), body = COALESCE(?, body), updated_at = ? WHERE id = ?')
      .bind(body?.title !== undefined ? cleanTitle(body.title) : null, body?.body !== undefined ? cleanBody(body.body) : null, now, issue.id)
      .run();
  }
  if (body?.state === 'closed' || body?.state === 'open') {
    if (issue.state === 'merged') throw conflict('A merged pull request cannot be reopened or closed');
    if (body.state !== issue.state) {
      let headSha = issue.head_sha;
      let baseSha = issue.base_sha;
      if (issue.kind === 'pull' && body.state === 'closed') {
        headSha = (await getRef(c.env.DB, project.id, `refs/heads/${issue.head_branch}`)) ?? headSha;
        baseSha = (await getRef(c.env.DB, project.id, `refs/heads/${issue.base_branch}`)) ?? baseSha;
      }
      await c.env.DB
        .prepare('UPDATE issues SET state = ?, closed_at = ?, closed_by = ?, head_sha = ?, base_sha = ?, updated_at = ? WHERE id = ?')
        .bind(body.state, body.state === 'closed' ? now : null, body.state === 'closed' ? user.id : null, headSha, baseSha, now, issue.id)
        .run();
      await addEvent(c.env.DB, issue.id, user.id, body.state === 'closed' ? 'closed' : 'reopened');
    }
  }
  return c.json({ ok: true });
});

issueRoutes.post('/:slug/issues/:number/comments', requireSession(), async (c) => {
  const project = await loadProject(c);
  const issue = await loadIssue(c, project);
  const user = sessionUser(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const text = cleanBody(body?.body).trim();
  if (!text) throw badRequest('Write something first');
  let path: string | null = null;
  let line: number | null = null;
  let side: 'old' | 'new' | null = null;
  let commitSha: string | null = null;
  if (body?.path !== undefined && body.path !== null) {
    if (issue.kind !== 'pull') throw badRequest('Line comments only apply to pull requests');
    path = sanitizeFilePath(String(body.path));
    line = Number(body.line);
    side = body.side === 'old' ? 'old' : 'new';
    if (!path || !Number.isInteger(line) || line < 1) throw badRequest('Line comments need a file path and line number');
    commitSha = typeof body.commit === 'string' ? body.commit : issue.head_sha;
  }
  const id = randomId(9);
  const now = nowMs();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO comments (id, project_id, target_type, target_id, author_id, body, path, line, side, commit_sha, created_at, updated_at)
         VALUES (?, ?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, project.id, issue.id, user.id, text, path, line, side, commitSha, now, now),
    c.env.DB.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').bind(now, issue.id),
  ]);
  return c.json({ id }, 201);
});

issueRoutes.patch('/:slug/comments/:id', requireSession(), async (c) => {
  const project = await loadProject(c);
  const user = sessionUser(c);
  const row = await c.env.DB
    .prepare('SELECT id, author_id FROM comments WHERE id = ? AND project_id = ?')
    .bind(c.req.param('id'), project.id)
    .first<{ id: string; author_id: string | null }>();
  if (!row) throw notFound('Comment not found');
  if (row.author_id !== user.id) throw forbidden('Only the author can edit a comment');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const text = cleanBody(body?.body).trim();
  if (!text) throw badRequest('Write something first');
  await c.env.DB.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').bind(text, nowMs(), row.id).run();
  return c.json({ ok: true });
});

issueRoutes.delete('/:slug/comments/:id', requireSession(), async (c) => {
  const project = await loadProject(c);
  const user = sessionUser(c);
  const row = await c.env.DB
    .prepare('SELECT id, author_id FROM comments WHERE id = ? AND project_id = ?')
    .bind(c.req.param('id'), project.id)
    .first<{ id: string; author_id: string | null }>();
  if (!row) throw notFound('Comment not found');
  if (row.author_id !== user.id && user.role !== 'admin') throw forbidden('Only the author or an admin can delete a comment');
  await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(row.id).run();
  return c.json({ ok: true });
});

// Commit comments (shown on the commit page).
issueRoutes.get('/:slug/repo/commits/:sha/comments', requireSession(), async (c) => {
  const project = await loadProject(c);
  const rows = await c.env.DB
    .prepare("SELECT * FROM comments WHERE project_id = ? AND target_type = 'commit' AND target_id = ? ORDER BY created_at")
    .bind(project.id, c.req.param('sha'))
    .all<{ id: string; author_id: string | null; body: string; path: string | null; line: number | null; side: string | null; created_at: number; updated_at: number }>();
  const users = await userNames(c.env.DB, rows.results.map((r) => r.author_id));
  return c.json({
    comments: rows.results.map((m) => ({
      id: m.id,
      author: person(users, m.author_id),
      body: m.body,
      path: m.path,
      line: m.line,
      side: m.side,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    })),
  });
});

issueRoutes.post('/:slug/repo/commits/:sha/comments', requireSession(), async (c) => {
  const project = await loadProject(c);
  const user = sessionUser(c);
  const sha = c.req.param('sha') ?? '';
  const exists = await c.env.DB
    .prepare('SELECT 1 FROM git_commits WHERE project_id = ? AND sha = ?')
    .bind(project.id, sha)
    .first();
  if (!exists) throw notFound('Commit not found');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const text = cleanBody(body?.body).trim();
  if (!text) throw badRequest('Write something first');
  const path = body?.path ? sanitizeFilePath(String(body.path)) : null;
  const line = path ? Number(body?.line) : null;
  const side = path ? (body?.side === 'old' ? 'old' : 'new') : null;
  if (path && (!Number.isInteger(line) || line! < 1)) throw badRequest('Line comments need a line number');
  const id = randomId(9);
  const now = nowMs();
  await c.env.DB
    .prepare(
      `INSERT INTO comments (id, project_id, target_type, target_id, author_id, body, path, line, side, commit_sha, created_at, updated_at)
       VALUES (?, ?, 'commit', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, project.id, sha, user.id, text, path, line, side, sha, now, now)
    .run();
  return c.json({ id }, 201);
});

// --------------------------------------------------------------- PR actions

issueRoutes.get('/:slug/pulls/:number/files', requireSession(), async (c) => {
  const project = await loadProject(c);
  const pr = await loadIssue(c, project);
  if (pr.kind !== 'pull') throw notFound('Not a pull request');
  const store = new GitStore(c.env, project.id);
  const status = await pullStatus(store, pr);
  if (!status.headSha || !status.baseSha) return c.json({ files: [], status });
  const from = status.mergeBase ? (await readCommit(store, status.mergeBase)).tree : null;
  const to = (await readCommit(store, status.headSha)).tree;
  const files = await withPatches(store, await diffTrees(store, from, to));
  return c.json({ files, headSha: status.headSha, mergeBase: status.mergeBase });
});

issueRoutes.post('/:slug/pulls/:number/reviews', requireSession(), async (c) => {
  const project = await loadProject(c);
  const pr = await loadIssue(c, project);
  const user = sessionUser(c);
  if (pr.kind !== 'pull') throw notFound('Not a pull request');
  if (pr.state !== 'open') throw conflict('This pull request is no longer open');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const state = body?.state;
  if (state !== 'approved' && state !== 'changes_requested' && state !== 'commented') throw badRequest('Pick approve, request changes or comment');
  if (state !== 'commented' && user.role === 'viewer') throw forbidden('Viewers can comment but not approve or request changes');
  if (state === 'approved' && pr.author_id === user.id) throw badRequest('You cannot approve your own pull request');
  const text = cleanBody(body?.body);
  if (state === 'changes_requested' && !text.trim()) throw badRequest('Say what needs to change');
  const head = (await getRef(c.env.DB, project.id, `refs/heads/${pr.head_branch}`)) ?? pr.head_sha ?? '';
  const id = randomId(9);
  const now = nowMs();
  await c.env.DB.batch([
    c.env.DB
      .prepare('INSERT INTO reviews (id, issue_id, author_id, state, body, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, pr.id, user.id, state, text, head, now),
    c.env.DB.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').bind(now, pr.id),
  ]);
  await audit(c.env.DB, user.email, `pull.review.${state}`, `project:${project.slug}#${pr.number}`);
  return c.json({ id }, 201);
});

issueRoutes.post('/:slug/pulls/:number/merge', requireRole('admin', 'uploader'), async (c) => {
  const project = await loadProject(c);
  const pr = await loadIssue(c, project);
  const user = sessionUser(c);
  if (pr.kind !== 'pull') throw notFound('Not a pull request');
  if (pr.state !== 'open') throw conflict('This pull request is no longer open');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const method = body?.method === 'squash' ? 'squash' : 'merge';
  const deleteBranch = body?.deleteBranch === true;
  const store = new GitStore(c.env, project.id);
  const status = await pullStatus(store, pr);
  if (status.branchMissing || !status.headSha || !status.baseSha) throw conflict('The head or base branch no longer exists');
  if (status.ahead === 0) throw conflict('Nothing to merge');
  if (!status.mergeable) {
    throw conflict(
      `This branch has conflicts with ${pr.base_branch} (${status.conflicts.slice(0, 5).join(', ')}). In GitHub Desktop, merge ${pr.base_branch} into ${pr.head_branch}, resolve, and push.`,
    );
  }
  if (isProtectedBranch(project, pr.base_branch)) {
    const reviews = await c.env.DB
      .prepare("SELECT author_id, state FROM reviews WHERE issue_id = ? AND state != 'commented' ORDER BY created_at")
      .bind(pr.id)
      .all<{ author_id: string | null; state: string }>();
    const tally = reviewTally(reviews.results, pr.author_id);
    const approved = tally.approvals > 0;
    const blocked = tally.changesRequested > 0;
    if ((!approved || blocked) && !(user.role === 'admin' && body?.bypass === true)) {
      throw forbidden(blocked ? 'Changes were requested; get a new approval first' : `${pr.base_branch} requires an approving review before merging`);
    }
  }

  const [b, o, t] = await Promise.all([
    status.mergeBase ? readCommit(store, status.mergeBase) : null,
    readCommit(store, status.baseSha),
    readCommit(store, status.headSha),
  ]);
  const merged = await mergeTrees(store, b?.tree ?? null, o.tree, t.tree);
  if (!merged.tree) throw conflict('This branch has conflicts that must be resolved first');
  const subject = typeof body?.message === 'string' && body.message.trim()
    ? body.message.trim()
    : method === 'squash'
      ? `${pr.title} (#${pr.number})`
      : `Merge pull request #${pr.number} from ${pr.head_branch}\n\n${pr.title}`;
  const commit = await createCommit(store, {
    tree: merged.tree,
    parents: method === 'squash' ? [status.baseSha] : [status.baseSha, status.headSha],
    author: signatureNow(user.name, user.email),
    message: subject,
  });
  await store.flush();
  if (!(await updateRef(c.env.DB, project.id, `refs/heads/${pr.base_branch}`, status.baseSha, commit, user.id))) {
    throw conflict(`${pr.base_branch} moved while merging — try again`);
  }
  const now = nowMs();
  await c.env.DB
    .prepare(
      "UPDATE issues SET state = 'merged', merge_commit = ?, merged_by = ?, merged_at = ?, head_sha = ?, base_sha = ?, updated_at = ? WHERE id = ?",
    )
    .bind(commit, user.id, now, status.headSha, status.baseSha, now, pr.id)
    .run();
  await addEvent(c.env.DB, pr.id, user.id, 'merged', { method, commit });
  if (deleteBranch && pr.head_branch !== project.default_branch) {
    await updateRef(c.env.DB, project.id, `refs/heads/${pr.head_branch}`, status.headSha, null, user.id);
    await addEvent(c.env.DB, pr.id, user.id, 'branch_deleted', { branch: pr.head_branch });
  }
  await c.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, project.id).run();
  await audit(c.env.DB, user.email, 'pull.merge', `project:${project.slug}#${pr.number}`, { method, commit });
  return c.json({ commit, method });
});
