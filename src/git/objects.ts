// Git object encoding: hashing, trees, commits, tags.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const ZERO_SHA = '0000000000000000000000000000000000000000';
export const SHA_RE = /^[0-9a-f]{40}$/;

export const MODE_FILE = '100644';
export const MODE_EXEC = '100755';
export const MODE_SYMLINK = '120000';
export const MODE_TREE = '40000';
export const MODE_GITLINK = '160000';

export function objectHeader(type: ObjType, size: number): Uint8Array {
  return encoder.encode(`${type} ${size}\0`);
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hashObject(type: ObjType, data: Uint8Array): Promise<string> {
  const header = objectHeader(type, data.length);
  const buf = new Uint8Array(header.length + data.length);
  buf.set(header);
  buf.set(data, header.length);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', buf)));
}

export type TreeEntry = { mode: string; name: string; sha: string };

export function isTreeMode(mode: string): boolean {
  return mode === MODE_TREE || mode === '040000';
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree object');
    const mode = decoder.decode(data.subarray(pos, sp));
    const name = decoder.decode(data.subarray(sp + 1, nul));
    entries.push({ mode, name, sha: toHex(data.subarray(nul + 1, nul + 21)) });
    pos = nul + 21;
  }
  return entries;
}

// Git orders tree entries bytewise, comparing a subtree's name as if it ended in "/".
function sortKey(e: TreeEntry): Uint8Array {
  return encoder.encode(isTreeMode(e.mode) ? `${e.name}/` : e.name);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const keyed = entries.map((e) => ({ e, k: sortKey(e) }));
  keyed.sort((x, y) => compareBytes(x.k, y.k));
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const { e } of keyed) {
    const head = encoder.encode(`${isTreeMode(e.mode) ? MODE_TREE : e.mode} ${e.name}\0`);
    parts.push(head, fromHex(e.sha));
    total += head.length + 20;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export type Signature = { name: string; email: string; time: number; tz: string };

export type Commit = {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
};

const SIG_RE = /^(.*?) <([^>]*)> (-?\d+) ([+-]\d{4})$/;

function parseSignature(s: string): Signature {
  const m = SIG_RE.exec(s);
  if (!m) return { name: s, email: '', time: 0, tz: '+0000' };
  return { name: m[1]!, email: m[2]!, time: parseInt(m[3]!, 10), tz: m[4]! };
}

function formatSignature(s: Signature): string {
  return `${s.name.replace(/[<>\n]/g, '')} <${s.email.replace(/[<>\n]/g, '')}> ${s.time} ${s.tz}`;
}

export function parseCommit(data: Uint8Array): Commit {
  const text = decoder.decode(data);
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const commit: Commit = {
    tree: '',
    parents: [],
    author: { name: '', email: '', time: 0, tz: '+0000' },
    committer: { name: '', email: '', time: 0, tz: '+0000' },
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header (gpgsig)
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'tree') commit.tree = value;
    else if (key === 'parent') commit.parents.push(value);
    else if (key === 'author') commit.author = parseSignature(value);
    else if (key === 'committer') commit.committer = parseSignature(value);
  }
  return commit;
}

export function serializeCommit(c: Commit): Uint8Array {
  const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`)];
  lines.push(`author ${formatSignature(c.author)}`, `committer ${formatSignature(c.committer)}`);
  const message = c.message.endsWith('\n') ? c.message : `${c.message}\n`;
  return encoder.encode(`${lines.join('\n')}\n\n${message}`);
}

export type Tag = { object: string; type: ObjType; tag: string };

export function parseTag(data: Uint8Array): Tag {
  const text = decoder.decode(data);
  const tag: Tag = { object: '', type: 'commit', tag: '' };
  for (const line of text.split('\n')) {
    if (line === '') break;
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'object') tag.object = value;
    else if (key === 'type') tag.type = value as ObjType;
    else if (key === 'tag') tag.tag = value;
  }
  return tag;
}

export function signatureNow(name: string, email: string): Signature {
  return { name, email, time: Math.floor(Date.now() / 1000), tz: '+0000' };
}

export function commitSubject(message: string): string {
  return message.split('\n', 1)[0] ?? '';
}
