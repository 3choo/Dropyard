// Three-way tree merge at file granularity, for merging pull requests on the
// server. Files changed on both sides in different ways are conflicts; those
// get resolved locally (GitHub Desktop: update the branch from the base).

import { MODE_TREE, isTreeMode, type TreeEntry } from './objects';
import { readTree, writeTree } from './repo';
import { GitStore } from './store';

export type MergeResult = { tree: string | null; conflicts: string[] };

const same = (a?: TreeEntry, b?: TreeEntry) => (!a && !b) || (!!a && !!b && a.sha === b.sha && a.mode === b.mode);

export async function mergeTrees(
  store: GitStore,
  base: string | null,
  ours: string,
  theirs: string,
  prefix = '',
): Promise<MergeResult> {
  if (ours === theirs || base === theirs) return { tree: ours, conflicts: [] };
  if (base === ours) return { tree: theirs, conflicts: [] };
  const [b, o, t] = await Promise.all([base ? readTree(store, base) : [], readTree(store, ours), readTree(store, theirs)]);
  const mb = new Map(b.map((e) => [e.name, e]));
  const mo = new Map(o.map((e) => [e.name, e]));
  const mt = new Map(t.map((e) => [e.name, e]));
  const names = new Set([...mb.keys(), ...mo.keys(), ...mt.keys()]);
  const merged: TreeEntry[] = [];
  const conflicts: string[] = [];
  for (const name of [...names].sort()) {
    const eb = mb.get(name);
    const eo = mo.get(name);
    const et = mt.get(name);
    const path = prefix + name;
    let pick: TreeEntry | undefined;
    if (same(eo, et)) pick = eo;
    else if (same(eb, eo)) pick = et;
    else if (same(eb, et)) pick = eo;
    else if (eo && et && isTreeMode(eo.mode) && isTreeMode(et.mode)) {
      const sub = await mergeTrees(store, eb && isTreeMode(eb.mode) ? eb.sha : null, eo.sha, et.sha, `${path}/`);
      conflicts.push(...sub.conflicts);
      if (sub.tree) pick = { mode: MODE_TREE, name, sha: sub.tree };
    } else {
      conflicts.push(path);
      continue;
    }
    if (pick) merged.push(pick);
  }
  if (conflicts.length > 0) return { tree: null, conflicts };
  return { tree: await writeTree(store, merged), conflicts: [] };
}
