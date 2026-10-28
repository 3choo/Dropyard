// Repository-level operations on top of GitStore: refs, history, tree edits, diffs.

import { nowMs } from '../lib/ids';
import {
  MODE_FILE,
  MODE_TREE,
  SHA_RE,
  hashObject,
  isTreeMode,
  parseCommit,
  parseTag,
  parseTree,
  serializeCommit,
  serializeTree,
  type Commit,
  type Signature,
  type TreeEntry,
} from './objects';
import { GitStore } from './store';

export type Ref = { name: string; sha: string };

export async function listRefs(db: D1Database, projectId: string): Promise<Ref[]> {
  const rows = await db
    .prepare('SELECT name, sha FROM git_refs WHERE project_id = ? ORDER BY name')
    .bind(projectId)
    .all<Ref>();
  return rows.results;
}

export async function getRef(db: D1Database, projectId: string, name: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT sha FROM git_refs WHERE project_id = ? AND name = ?')
    .bind(projectId, name)
    .first<{ sha: string }>();
  return row?.sha ?? null;
}

/** Compare-and-swap a ref. oldSha null = must not exist; newSha null = delete. */
export async function updateRef(
  db: D1Database,
  projectId: string,
  name: string,
  oldSha: string | null,
  newSha: string | null,
  actor: string | null,
): Promise<boolean> {
  let res: D1Result;
  if (oldSha === null && newSha !== null) {
    res = await db
      .prepare('INSERT OR IGNORE INTO git_refs (project_id, name, sha, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)')
      .bind(projectId, name, newSha, nowMs(), actor)
      .run();
  } else if (newSha === null && oldSha !== null) {
    res = await db
      .prepare('DELETE FROM git_refs WHERE project_id = ? AND name = ? AND sha = ?')
      .bind(projectId, name, oldSha)
      .run();
  } else if (oldSha !== null && newSha !== null) {
    res = await db
      .prepare('UPDATE git_refs SET sha = ?, updated_at = ?, updated_by = ? WHERE project_id = ? AND name = ? AND sha = ?')
      .bind(newSha, nowMs(), actor, projectId, name, oldSha)
      .run();
  } else {
    return false;
  }
  return (res.meta.changes ?? 0) > 0;
}

export const BRANCH_RE = /^[A-Za-z0-9._\-/]{1,200}$/;

export function validRefName(name: string): boolean {
  if (!name.startsWith('refs/heads/') && !name.startsWith('refs/tags/')) return false;
  const short = name.replace(/^refs\/(heads|tags)\//, '');
  if (!BRANCH_RE.test(short)) return false;
  if (short.split('/').some((s) => s === '' || s.startsWith('.') || s.endsWith('.lock'))) return false;
  return !short.includes('..') && !short.endsWith('/') && !short.endsWith('.');
}

/** Resolves a branch, tag, full ref name or (abbreviated) sha to a commit sha. */
export async function resolveCommit(store: GitStore, rev: string): Promise<string | null> {
  const candidates = rev.startsWith('refs/') ? [rev] : [`refs/heads/${rev}`, `refs/tags/${rev}`];
  for (const name of candidates) {
    const sha = await getRef(store.db, store.projectId, name);
    if (sha) return peelToCommit(store, sha);
  }
  if (SHA_RE.test(rev)) {
    const meta = await store.meta(rev);
    return meta ? peelToCommit(store, rev) : null;
  }
  if (/^[0-9a-f]{7,39}$/.test(rev)) {
    const rows = await store.db
      .prepare('SELECT sha FROM git_commits WHERE project_id = ? AND sha >= ? AND sha < ? LIMIT 2')
      .bind(store.projectId, rev, `${rev}g`)
      .all<{ sha: string }>();
    if (rows.results.length === 1) return rows.results[0]!.sha;
  }
  return null;
}

export async function peelToCommit(store: GitStore, sha: string): Promise<string | null> {
  let current = sha;
  for (let i = 0; i < 10; i++) {
    const obj = await store.load(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    current = parseTag(obj.data).object;
  }
  return null;
}

export async function readCommit(store: GitStore, sha: string): Promise<Commit> {
  return parseCommit(await store.loadTyped(sha, 'commit'));
}

export async function readTree(store: GitStore, sha: string): Promise<TreeEntry[]> {
  return parseTree(await store.loadTyped(sha, 'tree'));
}

/** Finds the entry at a path ('' = the root tree itself). */
export async function lookupPath(store: GitStore, rootTree: string, path: string): Promise<TreeEntry | null> {
  if (path === '') return { mode: MODE_TREE, name: '', sha: rootTree };
  let tree = rootTree;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const entry = (await readTree(store, tree)).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry;
    if (!isTreeMode(entry.mode)) return null;
    tree = entry.sha;
  }
  return null;
}

export type FlatFile = { path: string; mode: string; sha: string };

/** Every non-tree entry under a tree, with full paths. Loads trees level by level. */
export async function listFiles(store: GitStore, rootTree: string): Promise<FlatFile[]> {
  const files: FlatFile[] = [];
  let level: { prefix: string; sha: string }[] = [{ prefix: '', sha: rootTree }];
  while (level.length > 0) {
    const loaded = await store.loadMany(level.map((l) => l.sha));
    const next: { prefix: string; sha: string }[] = [];
    for (const { prefix, sha } of level) {
      const obj = loaded.get(sha);
      if (!obj) throw new Error(`tree ${sha} missing`);
      for (const e of parseTree(obj.data)) {
        const path = prefix + e.name;
        if (isTreeMode(e.mode)) next.push({ prefix: `${path}/`, sha: e.sha });
        else files.push({ path, mode: e.mode, sha: e.sha });
      }
    }
    level = next;
  }
  return files;
}

export async function writeTree(store: GitStore, entries: TreeEntry[]): Promise<string> {
  const data = serializeTree(entries);
  const sha = await hashObject('tree', data);
  await store.putObject(sha, 'tree', data);
  return sha;
}

type DirNode = { files: Map<string, { mode: string; sha: string }>; dirs: Map<string, DirNode> };

const emptyDir = (): DirNode => ({ files: new Map(), dirs: new Map() });

async function writeDir(store: GitStore, dir: DirNode): Promise<string | null> {
  const entries: TreeEntry[] = [];
  // A file and a folder can't share a name in a tree; the folder wins.
  for (const [name, f] of dir.files) if (!dir.dirs.has(name)) entries.push({ mode: f.mode, name, sha: f.sha });
  for (const [name, sub] of dir.dirs) {
    const sha = await writeDir(store, sub);
    if (sha) entries.push({ mode: MODE_TREE, name, sha });
  }
  if (entries.length === 0) return null;
  return writeTree(store, entries);
}

/** Builds a whole tree from a flat file list; returns the root tree sha. */
export async function buildTree(store: GitStore, files: FlatFile[]): Promise<string> {
  const root = emptyDir();
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let sub = dir.dirs.get(part);
      if (!sub) dir.dirs.set(part, (sub = emptyDir()));
      dir = sub;
    }
    dir.files.set(parts[parts.length - 1]!, { mode: f.mode || MODE_FILE, sha: f.sha });
  }
  return (await writeDir(store, root)) ?? (await writeTree(store, []));
}

export type TreeChange = { mode: string; sha: string } | null;

/**
 * Applies path-level changes (null = delete) to a tree, rewriting only the
 * directories on changed paths. Returns the new root tree sha.
 */
export async function updateTree(store: GitStore, baseTree: string | null, changes: Map<string, TreeChange>): Promise<string> {
  const grouped = new Map<string, Map<string, TreeChange>>();
  const direct = new Map<string, TreeChange>();
  for (const [path, change] of changes) {
    const slash = path.indexOf('/');
    if (slash < 0) direct.set(path, change);
    else {
      const head = path.slice(0, slash);
      let g = grouped.get(head);
      if (!g) grouped.set(head, (g = new Map()));
      g.set(path.slice(slash + 1), change);
    }
  }
  const entries = new Map<string, TreeEntry>();
  if (baseTree) for (const e of await readTree(store, baseTree)) entries.set(e.name, e);
  for (const [name, change] of direct) {
    if (change === null) entries.delete(name);
    else entries.set(name, { mode: change.mode, name, sha: change.sha });
  }
  for (const [name, sub] of grouped) {
    const existing = entries.get(name);
    const subBase = existing && isTreeMode(existing.mode) ? existing.sha : null;
    const sha = await updateTree(store, subBase, sub);
    const subEntries = await readTree(store, sha);
    if (subEntries.length === 0) entries.delete(name);
    else entries.set(name, { mode: MODE_TREE, name, sha });
  }
  return writeTree(store, [...entries.values()]);
}

export async function createCommit(
  store: GitStore,
  input: { tree: string; parents: string[]; author: Signature; committer?: Signature; message: string },
): Promise<string> {
  const commit: Commit = {
    tree: input.tree,
    parents: input.parents,
    author: input.author,
    committer: input.committer ?? input.author,
    message: input.message,
  };
  const data = serializeCommit(commit);
  const sha = await hashObject('commit', data);
  await store.putObject(sha, 'commit', data);
  return sha;
}

export type FileDiff = {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  oldSha: string | null;
  newSha: string | null;
  oldMode: string | null;
  newMode: string | null;
};

/** Path-level diff between two trees, skipping identical subtrees. */
export async function diffTrees(store: GitStore, a: string | null, b: string | null, prefix = ''): Promise<FileDiff[]> {
  if (a === b) return [];
  const [ea, eb] = await Promise.all([a ? readTree(store, a) : [], b ? readTree(store, b) : []]);
  const ma = new Map(ea.map((e) => [e.name, e]));
  const mb = new Map(eb.map((e) => [e.name, e]));
  const names = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const out: FileDiff[] = [];
  for (const name of names) {
    const x = ma.get(name);
    const y = mb.get(name);
    if (x && y && x.sha === y.sha && x.mode === y.mode) continue;
    const path = prefix + name;
    const xTree = x && isTreeMode(x.mode);
    const yTree = y && isTreeMode(y.mode);
    if (xTree || yTree) {
      out.push(...(await diffTrees(store, xTree ? x!.sha : null, yTree ? y!.sha : null, `${path}/`)));
      if (x && !xTree) out.push({ path, status: 'deleted', oldSha: x.sha, newSha: null, oldMode: x.mode, newMode: null });
      if (y && !yTree) out.push({ path, status: 'added', oldSha: null, newSha: y.sha, oldMode: null, newMode: y.mode });
      continue;
    }
    if (x && y) out.push({ path, status: 'modified', oldSha: x.sha, newSha: y.sha, oldMode: x.mode, newMode: y.mode });
    else if (x) out.push({ path, status: 'deleted', oldSha: x.sha, newSha: null, oldMode: x.mode, newMode: null });
    else if (y) out.push({ path, status: 'added', oldSha: null, newSha: y.sha, oldMode: null, newMode: y.mode });
  }
  return out;
}

const ANCESTORS_CTE = `WITH RECURSIVE anc(sha) AS (
  SELECT ?2
  UNION
  SELECT p.parent FROM git_commit_parents p JOIN anc ON p.sha = anc.sha WHERE p.project_id = ?1
)`;

export async function isAncestor(db: D1Database, projectId: string, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  const row = await db
    .prepare(`${ANCESTORS_CTE} SELECT 1 AS hit FROM anc WHERE sha = ?3 LIMIT 1`)
    .bind(projectId, descendant, ancestor)
    .first<{ hit: number }>();
  return !!row;
}

export async function ancestorSet(db: D1Database, projectId: string, tips: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const tip of tips) {
    if (out.has(tip)) continue;
    const rows = await db.prepare(`${ANCESTORS_CTE} SELECT sha FROM anc`).bind(projectId, tip).all<{ sha: string }>();
    for (const r of rows.results) out.add(r.sha);
  }
  return out;
}

export async function mergeBase(db: D1Database, projectId: string, a: string, b: string): Promise<string | null> {
  const row = await db
    .prepare(
      `WITH RECURSIVE
        ea(sha) AS (SELECT ?2 UNION SELECT p.parent FROM git_commit_parents p JOIN ea ON p.sha = ea.sha WHERE p.project_id = ?1),
        eb(sha) AS (SELECT ?3 UNION SELECT p.parent FROM git_commit_parents p JOIN eb ON p.sha = eb.sha WHERE p.project_id = ?1)
       SELECT c.sha FROM git_commits c JOIN ea ON ea.sha = c.sha JOIN eb ON eb.sha = c.sha
       WHERE c.project_id = ?1 ORDER BY c.committer_time DESC LIMIT 1`,
    )
    .bind(projectId, a, b)
    .first<{ sha: string }>();
  return row?.sha ?? null;
}

export type CommitRow = {
  sha: string;
  tree: string;
  author_name: string;
  author_email: string;
  author_time: number;
  committer_time: number;
  message: string;
  parents: string[];
};

async function attachParents(db: D1Database, projectId: string, rows: Omit<CommitRow, 'parents'>[]): Promise<CommitRow[]> {
  if (rows.length === 0) return [];
  const parents = new Map<string, string[]>();
  for (let i = 0; i < rows.length; i += 90) {
    const part = rows.slice(i, i + 90).map((r) => r.sha);
    const res = await db
      .prepare(
        `SELECT sha, parent FROM git_commit_parents WHERE project_id = ? AND sha IN (${part.map(() => '?').join(',')}) ORDER BY idx`,
      )
      .bind(projectId, ...part)
      .all<{ sha: string; parent: string }>();
    for (const r of res.results) {
      const list = parents.get(r.sha) ?? [];
      list.push(r.parent);
      parents.set(r.sha, list);
    }
  }
  return rows.map((r) => ({ ...r, parents: parents.get(r.sha) ?? [] }));
}

/** History reachable from tip (minus anything reachable from exclude), newest first. */
export async function logCommits(
  db: D1Database,
  projectId: string,
  tip: string,
  opts: { limit: number; offset?: number; exclude?: string | null },
): Promise<CommitRow[]> {
  const excludeClause = opts.exclude
    ? `AND c.sha NOT IN (
         WITH RECURSIVE ex(sha) AS (SELECT ?5 UNION SELECT p.parent FROM git_commit_parents p JOIN ex ON p.sha = ex.sha WHERE p.project_id = ?1)
         SELECT sha FROM ex)`
    : '';
  const stmt = db.prepare(
    `${ANCESTORS_CTE}
     SELECT c.sha, c.tree, c.author_name, c.author_email, c.author_time, c.committer_time, c.message
     FROM git_commits c JOIN anc ON anc.sha = c.sha
     WHERE c.project_id = ?1 ${excludeClause}
     ORDER BY c.committer_time DESC, c.sha LIMIT ?3 OFFSET ?4`,
  );
  const bound = opts.exclude
    ? stmt.bind(projectId, tip, opts.limit, opts.offset ?? 0, opts.exclude)
    : stmt.bind(projectId, tip, opts.limit, opts.offset ?? 0);
  const rows = await bound.all<Omit<CommitRow, 'parents'>>();
  return childrenFirst(await attachParents(db, projectId, rows.results));
}

/**
 * Commits made in the same second tie on committer_time; within each tie keep
 * every child ahead of its parents, the way git log never shows a parent
 * before its children.
 */
function childrenFirst(rows: CommitRow[]): CommitRow[] {
  const out: CommitRow[] = [];
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && rows[j]!.committer_time === rows[i]!.committer_time) j++;
    const group = rows.slice(i, j);
    const inGroup = new Set(group.map((r) => r.sha));
    const pendingChildren = new Map<string, number>(group.map((r) => [r.sha, 0]));
    for (const r of group) for (const p of r.parents) if (inGroup.has(p)) pendingChildren.set(p, pendingChildren.get(p)! + 1);
    const placed = new Set<string>();
    while (placed.size < group.length) {
      const next = group.find((r) => !placed.has(r.sha) && pendingChildren.get(r.sha) === 0) ?? group.find((r) => !placed.has(r.sha))!;
      placed.add(next.sha);
      out.push(next);
      for (const p of next.parents) if (pendingChildren.has(p)) pendingChildren.set(p, pendingChildren.get(p)! - 1);
    }
    i = j;
  }
  return out;
}

export async function getCommitRow(db: D1Database, projectId: string, sha: string): Promise<CommitRow | null> {
  const row = await db
    .prepare(
      'SELECT sha, tree, author_name, author_email, author_time, committer_time, message FROM git_commits WHERE project_id = ? AND sha = ?',
    )
    .bind(projectId, sha)
    .first<Omit<CommitRow, 'parents'>>();
  if (!row) return null;
  return (await attachParents(db, projectId, [row]))[0]!;
}

export async function countCommits(db: D1Database, projectId: string, tip: string): Promise<number> {
  const row = await db
    .prepare(`${ANCESTORS_CTE} SELECT COUNT(*) AS n FROM anc`)
    .bind(projectId, tip)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
