// Smart HTTP protocol: ref advertisement, upload-pack (v2 and v0) and
// receive-pack (v0, report-status).

import { isTextPath } from '../lib/mime';
import { MODE_GITLINK, SHA_RE, ZERO_SHA, isTreeMode, parseCommit, parseTag, parseTree, type ObjType } from './objects';
import { packStream, type PackEntry } from './packwrite';
import { DELIM, FLUSH, concatBytes, parsePkts, pkt, sideband, type Pkt } from './pkt';
import { ancestorSet, isAncestor, listRefs, updateRef, validRefName, type Ref } from './repo';
import { GitStore } from './store';
import { readPack } from './packread';
import { ByteReader } from './stream';

const AGENT = 'agent=gitctx/1';

export type RepoInfo = { projectId: string; defaultBranch: string; protectDefault: boolean };

function headTarget(repo: RepoInfo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

async function refsWithHead(store: GitStore, repo: RepoInfo): Promise<{ refs: Ref[]; head: string | null }> {
  const refs = await listRefs(store.db, store.projectId);
  const head = refs.find((r) => r.name === headTarget(repo))?.sha ?? null;
  return { refs, head };
}

async function peeledTags(store: GitStore, refs: Ref[]): Promise<Map<string, string>> {
  const tagRefs = refs.filter((r) => r.name.startsWith('refs/tags/'));
  const out = new Map<string, string>();
  if (tagRefs.length === 0) return out;
  const metas = await store.metas(tagRefs.map((r) => r.sha));
  const annotated = tagRefs.filter((r) => metas.get(r.sha)?.type === 'tag');
  const loaded = await store.loadMany(annotated.map((r) => r.sha));
  for (const r of annotated) {
    const obj = loaded.get(r.sha);
    if (obj) out.set(r.name, parseTag(obj.data).object);
  }
  return out;
}

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

export async function advertise(
  store: GitStore,
  repo: RepoInfo,
  service: 'git-upload-pack' | 'git-receive-pack',
  v2: boolean,
): Promise<ReadableStream<Uint8Array>> {
  if (service === 'git-upload-pack' && v2) {
    return streamOf([
      pkt('version 2\n'),
      pkt(`${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=wait-for-done\n'),
      pkt('object-format=sha1\n'),
      FLUSH,
    ]);
  }
  const { refs, head } = await refsWithHead(store, repo);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta no-progress symref=HEAD:${headTarget(repo)} ${AGENT} object-format=sha1`
      : `report-status delete-refs side-band-64k ofs-delta quiet ${AGENT} object-format=sha1`;
  const lines: string[] = [];
  if (service === 'git-upload-pack' && head) lines.push(`${head} HEAD`);
  for (const r of refs) lines.push(`${r.sha} ${r.name}`);
  if (service === 'git-upload-pack') {
    const peeled = await peeledTags(store, refs);
    const withPeeled: string[] = [];
    for (const line of lines) {
      withPeeled.push(line);
      const name = line.slice(41);
      const target = peeled.get(name);
      if (target) withPeeled.push(`${target} ${name}^{}`);
    }
    lines.splice(0, lines.length, ...withPeeled);
  }
  if (lines.length === 0) lines.push(`${ZERO_SHA} capabilities^{}`);
  lines[0] = `${lines[0]}\0${caps}`;
  return streamOf([pkt(`# service=${service}\n`), FLUSH, ...lines.map((l) => pkt(`${l}\n`)), FLUSH]);
}

// ---------------------------------------------------------------- upload-pack

/** Objects reachable from wants that the client (holding haves) lacks, in pack order. */
export async function collectPack(store: GitStore, wants: string[], haves: string[]): Promise<PackEntry[]> {
  const db = store.db;
  const pid = store.projectId;
  const known = await store.has(haves);
  const haveTips = haves.filter((h) => known.has(h));

  const tagEntries: { sha: string; data: Uint8Array }[] = [];
  const wantCommits: string[] = [];
  for (const want of new Set(wants)) {
    let sha = want;
    for (let depth = 0; depth < 10; depth++) {
      const obj = await store.load(sha);
      if (!obj) throw new Error(`not our ref ${want}`);
      if (obj.type === 'tag') {
        if (!known.has(sha)) tagEntries.push({ sha, data: obj.data });
        sha = parseTag(obj.data).object;
        continue;
      }
      if (obj.type === 'commit') wantCommits.push(sha);
      break;
    }
  }

  const haveAnc = await ancestorSet(db, pid, haveTips);
  const wantAnc = await ancestorSet(db, pid, wantCommits);
  const commits = [...wantAnc].filter((c) => !haveAnc.has(c));
  const commitObjs = await store.loadMany(commits);

  // Everything under the trees of the commits the client already has at the
  // boundary is excluded, so only changed subtrees and blobs are sent.
  const exclude = new Set<string>();
  const boundary = new Set<string>();
  for (const c of commits) {
    for (const p of parseCommit(commitObjs.get(c)!.data).parents) if (haveAnc.has(p)) boundary.add(p);
  }
  if (boundary.size > 0) {
    const bObjs = await store.loadMany([...boundary]);
    await walkTrees(
      store,
      [...bObjs.values()].map((o) => ({ sha: parseCommit(o.data).tree, prefix: '' })),
      exclude,
      (sha) => exclude.add(sha),
      (sha) => exclude.add(sha),
    );
  }

  const trees = new Map<string, Uint8Array>();
  const blobs = new Map<string, string>();
  const roots = commits.map((c) => ({ sha: parseCommit(commitObjs.get(c)!.data).tree, prefix: '' }));
  await walkTrees(
    store,
    roots,
    exclude,
    (sha, data) => trees.set(sha, data),
    (sha, path) => {
      if (!blobs.has(sha)) blobs.set(sha, path);
    },
  );

  const entries: PackEntry[] = [];
  for (const t of tagEntries) entries.push({ type: 'tag', data: t.data, compress: true });
  for (const c of commits) entries.push({ type: 'commit', data: commitObjs.get(c)!.data, compress: true });
  for (const [, data] of trees) entries.push({ type: 'tree', data, compress: true });
  const metas = await store.metas([...blobs.keys()]);
  const inlineBlobs: string[] = [];
  for (const [sha, path] of blobs) {
    const meta = metas.get(sha);
    if (!meta) throw new Error(`blob ${sha} missing`);
    if (meta.r2_key) entries.push({ type: 'blob', size: meta.size, key: meta.r2_key, compress: isTextPath(path) });
    else inlineBlobs.push(sha);
  }
  if (inlineBlobs.length > 0) {
    const loaded = await store.loadMany(inlineBlobs);
    for (const sha of inlineBlobs) entries.push({ type: 'blob', data: loaded.get(sha)!.data, compress: isTextPath(blobs.get(sha)!) });
  }
  return entries;
}

async function walkTrees(
  store: GitStore,
  roots: { sha: string; prefix: string }[],
  skip: Set<string>,
  onTree: (sha: string, data: Uint8Array) => void,
  onBlob: (sha: string, path: string) => void,
): Promise<void> {
  const seen = new Set<string>();
  let level = roots.filter((r) => !skip.has(r.sha));
  while (level.length > 0) {
    const fresh = level.filter((l) => !seen.has(l.sha));
    for (const l of fresh) seen.add(l.sha);
    const loaded = await store.loadMany([...new Set(fresh.map((l) => l.sha))]);
    const next: { sha: string; prefix: string }[] = [];
    for (const { sha, prefix } of fresh) {
      const obj = loaded.get(sha);
      if (!obj) throw new Error(`tree ${sha} missing`);
      onTree(sha, obj.data);
      for (const e of parseTree(obj.data)) {
        if (e.mode === MODE_GITLINK || skip.has(e.sha)) continue;
        if (isTreeMode(e.mode)) {
          if (!seen.has(e.sha)) next.push({ sha: e.sha, prefix: `${prefix}${e.name}/` });
        } else onBlob(e.sha, prefix + e.name);
      }
    }
    level = next;
  }
}

function packResponse(store: GitStore, entries: PackEntry[], prefix: Uint8Array[], useSideband: boolean): ReadableStream<Uint8Array> {
  const pack = packStream(store.env.BUCKET, entries);
  const reader = pack.getReader();
  let started = false;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        for (const p of prefix) controller.enqueue(p);
        return;
      }
      if (finished) {
        controller.close();
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (done) {
          finished = true;
          if (useSideband) controller.enqueue(FLUSH);
          controller.close();
          return;
        }
        if (useSideband) for (const framed of sideband(1, value)) controller.enqueue(framed);
        else controller.enqueue(value);
      } catch (err) {
        console.error('pack stream failed', err);
        if (useSideband) {
          for (const framed of sideband(3, `gitctx: ${err instanceof Error ? err.message : 'pack failed'}\n`)) controller.enqueue(framed);
          controller.close();
        } else controller.error(err);
      }
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

function dataLines(pkts: Pkt[]): string[] {
  return pkts.filter((p): p is Extract<Pkt, { kind: 'data' }> => p.kind === 'data').map((p) => p.text);
}

export async function uploadPackV2(store: GitStore, repo: RepoInfo, body: Uint8Array): Promise<ReadableStream<Uint8Array>> {
  const { pkts } = parsePkts(body);
  const delim = pkts.findIndex((p) => p.kind === 'delim');
  const capLines = dataLines(delim >= 0 ? pkts.slice(0, delim) : pkts);
  const args = dataLines(delim >= 0 ? pkts.slice(delim + 1) : []);
  const command = capLines.find((l) => l.startsWith('command='))?.slice(8);

  if (command === 'ls-refs') {
    const { refs, head } = await refsWithHead(store, repo);
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
    const symrefs = args.includes('symrefs');
    const peel = args.includes('peel');
    const unborn = args.includes('unborn');
    const matches = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const out: Uint8Array[] = [];
    if (matches('HEAD')) {
      const target = symrefs ? ` symref-target:${headTarget(repo)}` : '';
      if (head) out.push(pkt(`${head} HEAD${target}\n`));
      else if (unborn) out.push(pkt(`unborn HEAD${target}\n`));
    }
    const peeled = peel ? await peeledTags(store, refs) : new Map<string, string>();
    for (const r of refs) {
      if (!matches(r.name)) continue;
      const p = peeled.get(r.name);
      out.push(pkt(`${r.sha} ${r.name}${p ? ` peeled:${p}` : ''}\n`));
    }
    out.push(FLUSH);
    return streamOf(out);
  }

  if (command === 'fetch') {
    const wants = args.filter((a) => a.startsWith('want ')).map((a) => a.slice(5).trim());
    const haves = args.filter((a) => a.startsWith('have ')).map((a) => a.slice(5).trim());
    const done = args.includes('done');
    if (args.some((a) => a.startsWith('shallow ') || a.startsWith('deepen'))) {
      throw new GitProtocolError('shallow clones are not supported by gitctx');
    }
    if (wants.some((w) => !SHA_RE.test(w))) throw new GitProtocolError('invalid want');
    const known = await store.has([...wants, ...haves]);
    for (const w of wants) if (!known.has(w)) throw new GitProtocolError(`not our ref ${w}`);
    const common = haves.filter((h) => known.has(h));
    const prefix: Uint8Array[] = [];
    if (!done) {
      prefix.push(pkt('acknowledgments\n'));
      if (common.length === 0) {
        prefix.push(pkt('NAK\n'), FLUSH);
        return streamOf(prefix);
      }
      for (const c of common) prefix.push(pkt(`ACK ${c}\n`));
      if (args.includes('wait-for-done')) {
        prefix.push(FLUSH);
        return streamOf(prefix);
      }
      prefix.push(pkt('ready\n'), DELIM);
    }
    prefix.push(pkt('packfile\n'));
    const entries = await collectPack(store, wants, common);
    return packResponse(store, entries, prefix, true);
  }

  throw new GitProtocolError(`unknown command ${command ?? '(none)'}`);
}

export async function uploadPackV0(store: GitStore, body: Uint8Array): Promise<ReadableStream<Uint8Array>> {
  const lines = dataLines(parsePkts(body).pkts);
  const wants: string[] = [];
  const haves: string[] = [];
  let caps = '';
  let done = false;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const [sha, ...rest] = line.slice(5).split(' ');
      wants.push(sha!);
      if (rest.length) caps = rest.join(' ');
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line === 'done') done = true;
    else if (line.startsWith('shallow ') || line.startsWith('deepen')) {
      throw new GitProtocolError('shallow clones are not supported by gitctx');
    }
  }
  if (!done) return streamOf([pkt('NAK\n')]);
  const known = await store.has(wants);
  for (const w of wants) if (!known.has(w)) throw new GitProtocolError(`not our ref ${w}`);
  const entries = await collectPack(store, wants, haves);
  const useSideband = caps.split(' ').includes('side-band-64k');
  return packResponse(store, entries, [pkt('NAK\n')], useSideband);
}

export class GitProtocolError extends Error {}

// --------------------------------------------------------------- receive-pack

export type PushCommand = { oldSha: string; newSha: string; ref: string };
export type PushResult = { ref: string; ok: boolean; reason?: string };

export type PushPolicy = {
  actor: string;
  onFirstBranch: (branch: string) => Promise<void>;
};

async function checkConnectivity(store: GitStore, objects: Map<string, ObjType>): Promise<void> {
  const referenced = new Set<string>();
  const inPack = [...objects].filter(([, t]) => t !== 'blob').map(([sha]) => sha);
  for (let i = 0; i < inPack.length; i += 200) {
    const loaded = await store.loadMany(inPack.slice(i, i + 200));
    for (const obj of loaded.values()) {
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        referenced.add(c.tree);
        for (const p of c.parents) referenced.add(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== MODE_GITLINK) referenced.add(e.sha);
      } else if (obj.type === 'tag') {
        referenced.add(parseTag(obj.data).object);
      }
    }
  }
  const outside = [...referenced].filter((s) => !objects.has(s));
  const present = await store.has(outside);
  const missing = outside.filter((s) => !present.has(s));
  if (missing.length > 0) throw new GitProtocolError(`missing objects: ${missing.slice(0, 3).join(', ')}`);
}

export async function receivePack(
  store: GitStore,
  repo: RepoInfo,
  body: ReadableStream<Uint8Array> | null,
  policy: PushPolicy,
): Promise<{ stream: ReadableStream<Uint8Array>; results: PushResult[]; commands: PushCommand[] }> {
  const reader = ByteReader.from(body);
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  // Command list: pkt-lines up to the first flush.
  for (;;) {
    const head = await reader.readExact(4);
    const len = parseInt(new TextDecoder().decode(head), 16);
    if (!Number.isFinite(len)) throw new GitProtocolError('malformed push request');
    if (len === 0) break;
    let line = new TextDecoder().decode(await reader.readExact(len - 4)).replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1).trim().split(' ');
      line = line.slice(0, nul);
    }
    const [oldSha, newSha, ref] = line.split(' ');
    if (!oldSha || !newSha || !ref || !SHA_RE.test(oldSha) || !SHA_RE.test(newSha)) {
      throw new GitProtocolError('malformed push command');
    }
    commands.push({ oldSha, newSha, ref });
  }

  let unpackError: string | null = null;
  try {
    const { objects } = await readPack(reader, store);
    await checkConnectivity(store, objects);
  } catch (err) {
    unpackError = err instanceof Error ? err.message : 'unpack failed';
    console.error('receive-pack unpack failed', err);
  }

  const results: PushResult[] = [];
  const existingHeads = (await listRefs(store.db, store.projectId)).filter((r) => r.name.startsWith('refs/heads/'));
  const firstPush = existingHeads.length === 0 && !commands.some((c) => c.ref === headTarget(repo));
  for (const cmd of commands) {
    if (unpackError) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    results.push(await applyCommand(store, repo, cmd, policy, firstPush && cmd === commands.find((c) => c.ref.startsWith('refs/heads/'))));
  }

  const report: Uint8Array[] = [pkt(`unpack ${unpackError ? unpackError.replace(/\n/g, ' ') : 'ok'}\n`)];
  for (const r of results) report.push(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  report.push(FLUSH);
  const out: Uint8Array[] = [];
  if (caps.includes('report-status') || caps.includes('report-status-v2')) {
    if (caps.includes('side-band-64k')) {
      out.push(...sideband(1, concatBytes(report)), FLUSH);
    } else {
      out.push(...report);
    }
  }
  return { stream: streamOf(out), results, commands };
}

async function applyCommand(
  store: GitStore,
  repo: RepoInfo,
  cmd: PushCommand,
  policy: PushPolicy,
  firstPush: boolean,
): Promise<PushResult> {
  const { ref } = cmd;
  const fail = (reason: string): PushResult => ({ ref, ok: false, reason });
  if (!validRefName(ref)) return fail('invalid ref name (only branches and tags can be pushed)');
  const isDelete = cmd.newSha === ZERO_SHA;
  const isCreate = cmd.oldSha === ZERO_SHA;
  const isBranch = ref.startsWith('refs/heads/');
  const defaultRef = `refs/heads/${repo.defaultBranch}`;

  if (isDelete) {
    if (ref === defaultRef) return fail('the default branch cannot be deleted');
    const ok = await updateRef(store.db, store.projectId, ref, cmd.oldSha, null, policy.actor);
    return ok ? { ref, ok: true } : fail('stale info (the ref moved; fetch first)');
  }

  const meta = await store.meta(cmd.newSha);
  if (!meta) return fail('missing object');
  if (isBranch && meta.type !== 'commit') return fail('branches must point at commits');

  if (!isCreate) {
    if (!isBranch) return fail('tags cannot be moved once pushed');
    if (ref === defaultRef && repo.protectDefault) {
      return fail(`${repo.defaultBranch} is protected: push a branch and open a pull request`);
    }
    if (ref === defaultRef && !(await isAncestor(store.db, store.projectId, cmd.oldSha, cmd.newSha))) {
      return fail('non-fast-forward (force pushes to the default branch are blocked; pull first)');
    }
  }
  const ok = await updateRef(store.db, store.projectId, ref, isCreate ? null : cmd.oldSha, cmd.newSha, policy.actor);
  if (!ok) return fail(isCreate ? 'already exists (fetch first)' : 'stale info (the ref moved; fetch first)');
  if (isBranch && firstPush && ref !== defaultRef) await policy.onFirstBranch(ref.slice('refs/heads/'.length));
  return { ref, ok: true };
}

