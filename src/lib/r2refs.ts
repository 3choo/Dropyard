import { randomId } from './ids';

/**
 * R2 keys may be shared across releases: forking a release clones its
 * release_files rows and reuses the source release's objects instead of
 * copying multi-GB blobs. Two rules keep that safe:
 *
 * 1. Never write to a key another release references — writers use
 *    writeKeyFor(), which redirects to p/<pid>/r/<rid>~<suffix>/<path> when
 *    the standard key is claimed elsewhere. The ~<suffix> segment keeps the
 *    key's path recoverable via r2_key.split('/').slice(4).
 * 2. Never delete a key another release references — deletions go through
 *    deleteUnreferencedObjects().
 */

const DELETE_BATCH = 90;

export async function keyClaimedByOtherRelease(
  db: D1Database,
  key: string,
  releaseId: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM release_files WHERE r2_key = ? AND release_id != ? LIMIT 1')
    .bind(key, releaseId)
    .first();
  return row !== null;
}

/** The key to write file bytes to for a given release + path. */
export async function writeKeyFor(
  db: D1Database,
  projectId: string,
  releaseId: string,
  path: string,
  suffix = randomId(6),
): Promise<string> {
  const standard = `p/${projectId}/r/${releaseId}/${path}`;
  if (await keyClaimedByOtherRelease(db, standard, releaseId)) {
    return `p/${projectId}/r/${releaseId}~${suffix}/${path}`;
  }
  return standard;
}

/**
 * Delete R2 objects that no release_files row references anymore. Callers must
 * already have removed (or never had) the rows that justified the keys — the
 * reference check runs live, so deleting a release's rows first makes its
 * private keys deletable while fork-shared keys survive.
 */
export async function deleteUnreferencedObjects(
  db: D1Database,
  bucket: R2Bucket,
  keys: string[],
): Promise<void> {
  const unique = [...new Set(keys)].filter((k) => k.length > 0);
  if (unique.length === 0) return;
  const claimed = new Set<string>();
  for (let i = 0; i < unique.length; i += DELETE_BATCH) {
    const chunk = unique.slice(i, i + DELETE_BATCH);
    const rows = await db
      .prepare(`SELECT DISTINCT r2_key FROM release_files WHERE r2_key IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ r2_key: string }>();
    for (const r of rows.results) claimed.add(r.r2_key);
  }
  const deletable = unique.filter((k) => !claimed.has(k));
  for (let i = 0; i < deletable.length; i += DELETE_BATCH) {
    await bucket.delete(deletable.slice(i, i + DELETE_BATCH));
  }
}
