// File diffs with line patches for the web UI (commit pages, compare, PRs).

import { diffText, type Hunk } from '../lib/linediff';
import { isTextPath, MAX_TEXT_BLOB_BYTES } from '../lib/mime';
import type { FileDiff } from './repo';
import { GitStore, type ObjectMeta } from './store';

export type PatchedFile = FileDiff & {
  oldSize: number | null;
  newSize: number | null;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[] | null;
  /** Why hunks are missing: binary file, too large, or the response budget ran out. */
  skipped: 'binary' | 'large' | 'budget' | null;
};

const PATCH_BUDGET = 6 * 1024 * 1024;
const MAX_PATCHED_FILES = 400;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** Decodes bytes as text, or returns null when they look binary. */
export function asText(data: Uint8Array): string | null {
  if (data.subarray(0, 8000).includes(0)) return null;
  try {
    return decoder.decode(data);
  } catch {
    return null;
  }
}

export async function readBlobBytes(store: GitStore, meta: ObjectMeta): Promise<Uint8Array> {
  if (!meta.r2_key) {
    const obj = await store.load(meta.sha);
    if (!obj) throw new Error(`blob ${meta.sha} missing`);
    return obj.data;
  }
  const obj = await store.env.BUCKET.get(meta.r2_key);
  if (!obj) throw new Error(`blob ${meta.sha} missing from storage`);
  return new Uint8Array(await obj.arrayBuffer());
}

export async function withPatches(store: GitStore, files: FileDiff[]): Promise<PatchedFile[]> {
  const shas = files.flatMap((f) => [f.oldSha, f.newSha]).filter((s): s is string => !!s);
  const metas = await store.metas(shas);
  let budget = PATCH_BUDGET;
  const out: PatchedFile[] = [];
  for (const [i, f] of files.entries()) {
    const oldMeta = f.oldSha ? metas.get(f.oldSha) ?? null : null;
    const newMeta = f.newSha ? metas.get(f.newSha) ?? null : null;
    const base: PatchedFile = {
      ...f,
      oldSize: oldMeta?.size ?? null,
      newSize: newMeta?.size ?? null,
      binary: false,
      additions: 0,
      deletions: 0,
      hunks: null,
      skipped: null,
    };
    const size = (oldMeta?.size ?? 0) + (newMeta?.size ?? 0);
    const textual = isTextPath(f.path) || size < 256 * 1024;
    if ((oldMeta?.size ?? 0) > MAX_TEXT_BLOB_BYTES || (newMeta?.size ?? 0) > MAX_TEXT_BLOB_BYTES) {
      out.push({ ...base, binary: !isTextPath(f.path), skipped: isTextPath(f.path) ? 'large' : 'binary' });
      continue;
    }
    if (!textual) {
      out.push({ ...base, binary: true, skipped: 'binary' });
      continue;
    }
    if (i >= MAX_PATCHED_FILES || size > budget) {
      out.push({ ...base, skipped: 'budget' });
      continue;
    }
    budget -= size;
    const [a, b] = await Promise.all([
      oldMeta ? readBlobBytes(store, oldMeta) : Promise.resolve(new Uint8Array(0)),
      newMeta ? readBlobBytes(store, newMeta) : Promise.resolve(new Uint8Array(0)),
    ]);
    const ta = asText(a);
    const tb = asText(b);
    if (ta === null || tb === null) {
      out.push({ ...base, binary: true, skipped: 'binary' });
      continue;
    }
    const d = diffText(ta, tb);
    if ('tooLarge' in d) out.push({ ...base, skipped: 'large' });
    else out.push({ ...base, additions: d.additions, deletions: d.deletions, hunks: d.hunks });
  }
  return out;
}
