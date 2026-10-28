import { randomId } from './ids';

const DELETE_BATCH = 45;

export async function keyClaimedByOtherRelease(
  db: D1Database,
  key: string,
  releaseId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM release_files WHERE r2_key = ?1 AND release_id != ?2
       UNION ALL SELECT 1 FROM git_objects WHERE r2_key = ?1 LIMIT 1`,
    )
    .bind(key, releaseId)
    .first();
  return row !== null;
}

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
    const marks = chunk.map(() => '?').join(',');
    // Git blobs imported from a release keep pointing at its R2 objects.
    const rows = await db
      .prepare(
        `SELECT r2_key FROM release_files WHERE r2_key IN (${marks})
         UNION SELECT r2_key FROM git_objects WHERE r2_key IN (${marks})`,
      )
      .bind(...chunk, ...chunk)
      .all<{ r2_key: string }>();
    for (const r of rows.results) claimed.add(r.r2_key);
  }
  const deletable = unique.filter((k) => !claimed.has(k));
  for (let i = 0; i < deletable.length; i += DELETE_BATCH) {
    await bucket.delete(deletable.slice(i, i + DELETE_BATCH));
  }
}
