// Turns published releases into the repository's first commits. Every file is
// hashed once (blobs keep pointing at the release's existing R2 object); the
// browser drives the work in steps so a multi-GB release never hits a limit.

import { createHash } from 'node:crypto';
import { nowMs } from '../lib/ids';
import { MODE_FILE, hashObject, objectHeader } from './objects';
import { buildTree, createCommit, listRefs, updateRef } from './repo';
import { GitStore } from './store';
import { getBucket } from '../lib/storage';

export type ImportRow = {
  project_id: string;
  release_ids: string;
  release_index: number;
  cursor: string;
  status: 'running' | 'done' | 'failed';
  files_total: number;
  files_done: number;
  bytes_total: number;
  bytes_done: number;
  head_sha: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export function presentImport(row: ImportRow | null) {
  if (!row) return null;
  return {
    status: row.status,
    releases: (JSON.parse(row.release_ids) as string[]).length,
    releaseIndex: row.release_index,
    filesTotal: row.files_total,
    filesDone: row.files_done,
    bytesTotal: row.bytes_total,
    bytesDone: row.bytes_done,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

export async function getImport(db: D1Database, projectId: string): Promise<ImportRow | null> {
  return db.prepare('SELECT * FROM git_imports WHERE project_id = ?').bind(projectId).first<ImportRow>();
}

export class ImportError extends Error {}

export async function startImport(
  env: Env,
  projectId: string,
  userId: string,
  mode: 'latest' | 'all',
): Promise<ImportRow> {
  if ((await listRefs(env.DB, projectId)).length > 0) {
    throw new ImportError('This repository already has commits; releases can only be imported into an empty repository');
  }
  const existing = await getImport(env.DB, projectId);
  if (existing?.status === 'running') return existing;
  const releases =
    mode === 'all'
      ? await env.DB
          .prepare("SELECT id FROM releases WHERE project_id = ? AND status = 'published' ORDER BY published_at ASC")
          .bind(projectId)
          .all<{ id: string }>()
      : await env.DB
          .prepare(
            "SELECT id FROM releases WHERE project_id = ? AND status = 'published' ORDER BY is_latest DESC, published_at DESC LIMIT 1",
          )
          .bind(projectId)
          .all<{ id: string }>();
  const ids = releases.results.map((r) => r.id);
  if (ids.length === 0) throw new ImportError('There is no published release to import');
  const totals = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM release_files
       WHERE release_id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(...ids)
    .first<{ n: number; bytes: number }>();
  const now = nowMs();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM git_import_files WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM git_imports WHERE project_id = ?').bind(projectId),
    env.DB
      .prepare(
        `INSERT INTO git_imports (project_id, release_ids, status, files_total, bytes_total, created_by, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .bind(projectId, JSON.stringify(ids), totals?.n ?? 0, totals?.bytes ?? 0, userId, now, now),
  ]);
  return (await getImport(env.DB, projectId))!;
}

const STEP_MS = 20_000;
const STEP_BYTES = 3 * 1024 * 1024 * 1024;
const SMALL = 8 * 1024 * 1024;
const PARALLEL = 6;

type FileRow = { path: string; r2_key: string; size: number };

async function hashStored(bucket: R2Bucket, key: string): Promise<{ sha: string; size: number }> {
  const obj = await bucket.get(key);
  if (!obj) throw new ImportError(`A release file is missing from storage (${key})`);
  if (obj.size <= SMALL) {
    const data = new Uint8Array(await obj.arrayBuffer());
    return { sha: await hashObject('blob', data), size: data.length };
  }
  const hasher = createHash('sha1').update(objectHeader('blob', obj.size));
  const reader = obj.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return { sha: hasher.digest('hex'), size: obj.size };
}

export async function importStep(env: Env, projectId: string, defaultBranch: string): Promise<ImportRow> {
  const started = Date.now();
  let row = await getImport(env.DB, projectId);
  if (!row || row.status !== 'running') {
    if (!row) throw new ImportError('No import in progress');
    return row;
  }
  const ids = JSON.parse(row.release_ids) as string[];
  const store = new GitStore(env, projectId);
  let bytesThisStep = 0;
  try {
    while (Date.now() - started < STEP_MS && bytesThisStep < STEP_BYTES) {
      const releaseId = ids[row.release_index]!;
      const files = await env.DB
        .prepare('SELECT path, r2_key, size FROM release_files WHERE release_id = ? AND path > ? ORDER BY path LIMIT 120')
        .bind(releaseId, row.cursor)
        .all<FileRow>();

      if (files.results.length === 0) {
        row = await finishRelease(env, store, row, releaseId, defaultBranch, ids);
        if (row.status !== 'running') return row;
        continue;
      }

      // Release files forked from an earlier release share R2 objects: reuse their sha.
      const known = new Map<string, string>();
      const keys = [...new Set(files.results.map((f) => f.r2_key))];
      for (let i = 0; i < keys.length; i += 90) {
        const part = keys.slice(i, i + 90);
        const hits = await env.DB
          .prepare(`SELECT sha, r2_key FROM git_objects WHERE project_id = ? AND r2_key IN (${part.map(() => '?').join(',')})`)
          .bind(projectId, ...part)
          .all<{ sha: string; r2_key: string }>();
        for (const h of hits.results) known.set(h.r2_key, h.sha);
      }

      let processed = 0;
      for (let i = 0; i < files.results.length; ) {
        const batch: FileRow[] = [];
        while (i < files.results.length && batch.length < PARALLEL) {
          const f = files.results[i]!;
          if (batch.length > 0 && f.size > SMALL) break;
          batch.push(f);
          i++;
          if (f.size > SMALL) break;
        }
        const hashed = await Promise.all(
          batch.map(async (f) => {
            const sha = known.get(f.r2_key);
            if (sha) return { f, sha, size: f.size, fresh: false };
            const h = await hashStored(getBucket(env), f.r2_key);
            known.set(f.r2_key, h.sha);
            return { f, sha: h.sha, size: h.size, fresh: true };
          }),
        );
        const stmts: D1PreparedStatement[] = [];
        let batchBytes = 0;
        for (const h of hashed) {
          if (h.fresh) {
            stmts.push(
              env.DB
                .prepare("INSERT OR IGNORE INTO git_objects (project_id, sha, type, size, r2_key, data) VALUES (?, ?, 'blob', ?, ?, NULL)")
                .bind(projectId, h.sha, h.size, h.f.r2_key),
            );
            bytesThisStep += h.size;
          }
          batchBytes += h.f.size;
          stmts.push(
            env.DB
              .prepare('INSERT OR REPLACE INTO git_import_files (project_id, release_id, path, sha) VALUES (?, ?, ?, ?)')
              .bind(projectId, releaseId, h.f.path, h.sha),
          );
        }
        const last = batch[batch.length - 1]!.path;
        stmts.push(
          env.DB
            .prepare('UPDATE git_imports SET cursor = ?, files_done = files_done + ?, bytes_done = bytes_done + ?, updated_at = ? WHERE project_id = ?')
            .bind(last, batch.length, batchBytes, nowMs(), projectId),
        );
        await env.DB.batch(stmts);
        processed += batch.length;
        row.cursor = last;
        if (Date.now() - started >= STEP_MS || bytesThisStep >= STEP_BYTES) break;
      }
      row = (await getImport(env.DB, projectId))!;
      if (processed < files.results.length) break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed';
    console.error('git import step failed', projectId, err);
    await env.DB
      .prepare("UPDATE git_imports SET status = 'failed', error = ?, updated_at = ? WHERE project_id = ?")
      .bind(message.slice(0, 500), nowMs(), projectId)
      .run();
  }
  return (await getImport(env.DB, projectId))!;
}

async function finishRelease(
  env: Env,
  store: GitStore,
  row: ImportRow,
  releaseId: string,
  defaultBranch: string,
  ids: string[],
): Promise<ImportRow> {
  const projectId = row.project_id;
  const release = await env.DB
    .prepare(
      `SELECT r.version, r.title, r.notes, r.published_at, r.created_at, u.name, u.email
       FROM releases r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?`,
    )
    .bind(releaseId)
    .first<{ version: string; title: string; notes: string; published_at: number | null; created_at: number; name: string | null; email: string | null }>();
  if (!release) throw new ImportError('A release disappeared during the import');
  const files = await env.DB
    .prepare('SELECT path, sha FROM git_import_files WHERE project_id = ? AND release_id = ?')
    .bind(projectId, releaseId)
    .all<{ path: string; sha: string }>();
  const tree = await buildTree(
    store,
    files.results.map((f) => ({ path: f.path, sha: f.sha, mode: MODE_FILE })),
  );
  const when = Math.floor((release.published_at ?? release.created_at) / 1000);
  const author = { name: release.name ?? 'dropyard', email: release.email ?? 'dropyard@localhost', time: when, tz: '+0000' };
  const subject = release.title ? `v${release.version}: ${release.title}` : `Release v${release.version}`;
  const sha = await createCommit(store, {
    tree,
    parents: row.head_sha ? [row.head_sha] : [],
    author,
    message: release.notes ? `${subject}\n\n${release.notes}` : subject,
  });
  await store.flush();
  await updateRef(env.DB, projectId, `refs/tags/v${release.version}`, null, sha, null);
  const nextIndex = row.release_index + 1;
  const finished = nextIndex >= ids.length;
  const stmts = [
    env.DB.prepare('UPDATE releases SET commit_sha = ? WHERE id = ?').bind(sha, releaseId),
    env.DB.prepare('DELETE FROM git_import_files WHERE project_id = ? AND release_id = ?').bind(projectId, releaseId),
    env.DB
      .prepare(`UPDATE git_imports SET head_sha = ?, release_index = ?, cursor = '', status = ?, updated_at = ? WHERE project_id = ?`)
      .bind(sha, nextIndex, finished ? 'done' : 'running', nowMs(), projectId),
  ];
  await env.DB.batch(stmts);
  if (finished) {
    if (!(await updateRef(env.DB, projectId, `refs/heads/${defaultBranch}`, null, sha, null))) {
      throw new ImportError('Someone pushed while the import ran; the import was not applied to the branch');
    }
  }
  return (await getImport(env.DB, projectId))!;
}
