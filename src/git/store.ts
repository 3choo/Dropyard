// Object store for one project's repository: index in D1, bytes in D1 (small
// non-blob objects) or R2 (blobs and anything large).

import { parseCommit, type Commit, type ObjType } from './objects';
import { getBucket } from '../lib/storage';

export const INLINE_MAX = 64 * 1024;
const IN_CHUNK = 90;

export type ObjectMeta = { sha: string; type: ObjType; size: number; r2_key: string | null };
export type LoadedObject = { sha: string; type: ObjType; data: Uint8Array };

export function objectKey(projectId: string, sha: string): string {
  return `p/${projectId}/git/${sha}`;
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('unexpected blob column value');
}

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class GitStore {
  private pending: D1PreparedStatement[] = [];
  private cache = new Map<string, LoadedObject>();

  constructor(
    readonly env: Env,
    readonly projectId: string,
  ) {}

  get db(): D1Database {
    return this.env.DB;
  }

  async metas(shas: string[]): Promise<Map<string, ObjectMeta>> {
    const out = new Map<string, ObjectMeta>();
    for (const part of chunks([...new Set(shas)])) {
      const rows = await this.db
        .prepare(
          `SELECT sha, type, size, r2_key FROM git_objects WHERE project_id = ? AND sha IN (${part.map(() => '?').join(',')})`,
        )
        .bind(this.projectId, ...part)
        .all<ObjectMeta>();
      for (const r of rows.results) out.set(r.sha, r);
    }
    return out;
  }

  async meta(sha: string): Promise<ObjectMeta | null> {
    return (await this.metas([sha])).get(sha) ?? null;
  }

  async has(shas: string[]): Promise<Set<string>> {
    return new Set((await this.metas(shas)).keys());
  }

  /** Loads small objects (trees/commits/tags; blobs too, if asked) fully into memory. */
  async loadMany(shas: string[]): Promise<Map<string, LoadedObject>> {
    const out = new Map<string, LoadedObject>();
    const missing: string[] = [];
    for (const sha of new Set(shas)) {
      const hit = this.cache.get(sha);
      if (hit) out.set(sha, hit);
      else missing.push(sha);
    }
    for (const part of chunks(missing)) {
      const rows = await this.db
        .prepare(
          `SELECT sha, type, size, r2_key, data FROM git_objects WHERE project_id = ? AND sha IN (${part.map(() => '?').join(',')})`,
        )
        .bind(this.projectId, ...part)
        .all<ObjectMeta & { data: unknown }>();
      await Promise.all(
        rows.results.map(async (r) => {
          let data: Uint8Array;
          if (r.data !== null && r.data !== undefined) data = toBytes(r.data);
          else {
            const obj = await getBucket(this.env).get(r.r2_key ?? '');
            if (!obj) throw new Error(`object ${r.sha} is missing from storage`);
            data = new Uint8Array(await obj.arrayBuffer());
          }
          const loaded = { sha: r.sha, type: r.type, data };
          if (r.type !== 'blob') this.cache.set(r.sha, loaded);
          out.set(r.sha, loaded);
        }),
      );
    }
    return out;
  }

  async load(sha: string): Promise<LoadedObject | null> {
    return (await this.loadMany([sha])).get(sha) ?? null;
  }

  async loadTyped(sha: string, type: ObjType): Promise<Uint8Array> {
    const obj = await this.load(sha);
    if (!obj || obj.type !== type) throw new Error(`${type} ${sha} not found`);
    return obj.data;
  }

  /** Queues an index row for an object whose bytes are already stored (or inline). */
  queueIndex(sha: string, type: ObjType, size: number, r2Key: string | null, data: Uint8Array | null): void {
    this.pending.push(
      this.db
        .prepare('INSERT OR IGNORE INTO git_objects (project_id, sha, type, size, r2_key, data) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(this.projectId, sha, type, size, r2Key, data),
    );
    if (data && type !== 'blob') this.cache.set(sha, { sha, type, data });
  }

  queueCommitRows(sha: string, commit: Commit): void {
    this.pending.push(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO git_commits (project_id, sha, tree, author_name, author_email, author_time, committer_time, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          this.projectId,
          sha,
          commit.tree,
          commit.author.name,
          commit.author.email,
          commit.author.time,
          commit.committer.time,
          commit.message.slice(0, 20000),
        ),
    );
    commit.parents.forEach((parent, idx) => {
      this.pending.push(
        this.db
          .prepare('INSERT OR IGNORE INTO git_commit_parents (project_id, sha, parent, idx) VALUES (?, ?, ?, ?)')
          .bind(this.projectId, sha, parent, idx),
      );
    });
  }

  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, 50);
      await this.db.batch(batch);
    }
  }

  /** Writes a small object (any type) and queues its index row. */
  async putObject(sha: string, type: ObjType, data: Uint8Array): Promise<void> {
    if (type === 'blob' || data.length > INLINE_MAX) {
      const key = objectKey(this.projectId, sha);
      await getBucket(this.env).put(key, data);
      this.queueIndex(sha, type, data.length, key, null);
    } else {
      this.queueIndex(sha, type, data.length, null, data);
    }
    if (type === 'commit') this.queueCommitRows(sha, parseCommit(data));
  }

  /** Opens a byte range of a stored object. */
  async readRange(meta: ObjectMeta, offset: number, length: number): Promise<Uint8Array> {
    if (!meta.r2_key) {
      const obj = await this.load(meta.sha);
      if (!obj) throw new Error(`object ${meta.sha} missing`);
      return obj.data.subarray(offset, offset + length);
    }
    const obj = await getBucket(this.env).get(meta.r2_key, { range: { offset, length } });
    if (!obj) throw new Error(`object ${meta.sha} is missing from storage`);
    return new Uint8Array(await obj.arrayBuffer());
  }
}
