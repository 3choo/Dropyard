import { Hono, type Context } from 'hono';
import { audit } from '../lib/audit';
import {
  clearLoginAttempts,
  loginBlocked,
  recordLoginFailure,
  resolveUserToken,
  verifyPassword,
  type Role,
  type SessionUser,
} from '../lib/auth';
import { nowMs } from '../lib/ids';
import { resolveToken, type AppEnv } from '../middleware';
import {
  GitProtocolError,
  advertise,
  receivePack,
  uploadPackV0,
  uploadPackV2,
  type RepoInfo,
} from '../git/protocol';
import { pkt, FLUSH } from '../git/pkt';
import { GitStore } from '../git/store';

/**
 * Git smart HTTP at /git/<slug>.git — what GitHub Desktop (or any git) talks
 * to. Username can be anything; the password is a personal access token
 * (gctp_…), a deploy token (gctx_…, read-only) or the account password.
 */
export const gitRoutes = new Hono<AppEnv>();

type GitAuth = { user: SessionUser | null; tokenProjectId: string | null; canRead: boolean };

const REALM = 'Basic realm="gitctx", charset="UTF-8"';

function challenge(message = 'Authentication required'): Response {
  return new Response(`${message}\n`, {
    status: 401,
    headers: { 'www-authenticate': REALM, 'content-type': 'text/plain; charset=utf-8' },
  });
}

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function authenticate(c: Context<AppEnv>): Promise<GitAuth | null> {
  const header = c.req.header('authorization') ?? '';
  let secret = '';
  let username = '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6).trim()), (ch) => ch.charCodeAt(0)));
      const colon = decoded.indexOf(':');
      username = colon >= 0 ? decoded.slice(0, colon) : decoded;
      secret = colon >= 0 ? decoded.slice(colon + 1) : '';
    } catch {
      return null;
    }
  } else if (header.startsWith('Bearer ')) {
    secret = header.slice(7).trim();
  }
  if (!secret) return null;

  const user = await resolveUserToken(c.env.DB, secret);
  if (user) return { user, tokenProjectId: null, canRead: true };
  const deploy = await resolveToken(c.env, secret);
  if (deploy && deploy.kind === 'token') return { user: null, tokenProjectId: deploy.projectId, canRead: true };

  // Fall back to email + account password (rate limited like the login form).
  const email = username.trim().toLowerCase();
  if (!email.includes('@')) return null;
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (await loginBlocked(c.env.DB, email, ip)) return null;
  const row = await c.env.DB
    .prepare('SELECT id, email, name, role, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; email: string; name: string; role: Role; password_hash: string }>();
  if (!row || !(await verifyPassword(secret, row.password_hash))) {
    await recordLoginFailure(c.env.DB, email, ip);
    return null;
  }
  await clearLoginAttempts(c.env.DB, email, ip);
  return { user: { id: row.id, email: row.email, name: row.name, role: row.role }, tokenProjectId: null, canRead: true };
}

type RepoRow = { id: string; slug: string; default_branch: string; protect_default: number };

async function findRepo(c: Context<AppEnv>): Promise<RepoRow | null> {
  const slug = (c.req.param('repo') ?? '').replace(/\.git$/, '');
  return c.env.DB
    .prepare('SELECT id, slug, default_branch, protect_default FROM projects WHERE slug = ?')
    .bind(slug)
    .first<RepoRow>();
}

async function requestBody(c: Context<AppEnv>): Promise<ReadableStream<Uint8Array> | null> {
  const body = c.req.raw.body;
  if (!body) return null;
  const encoding = (c.req.header('content-encoding') ?? '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return body.pipeThrough(new DecompressionStream('gzip'));
  return body;
}

async function readAll(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) throw new GitProtocolError('request too large');
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const NO_CACHE = {
  'cache-control': 'no-cache, max-age=0, must-revalidate',
  pragma: 'no-cache',
  expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
};

function errorPkt(contentType: string, message: string): Response {
  const body = new Uint8Array([...pkt(`ERR ${message}\n`), ...FLUSH]);
  return new Response(body, { headers: { 'content-type': contentType, ...NO_CACHE } });
}

type Gate = { repo: RepoRow; auth: GitAuth; info: RepoInfo } | Response;

async function gate(c: Context<AppEnv>, write: boolean): Promise<Gate> {
  const auth = await authenticate(c);
  if (!auth) return challenge();
  const repo = await findRepo(c);
  if (!repo) return plain(404, 'Repository not found');
  if (auth.tokenProjectId && auth.tokenProjectId !== repo.id) return plain(403, 'This deploy token is scoped to a different project');
  if (write) {
    if (!auth.user) return plain(403, 'Deploy tokens are read-only; push with a personal access token');
    if (auth.user.role === 'viewer') return plain(403, 'Your gitctx role (viewer) cannot push; ask an admin for uploader access');
  }
  return { repo, auth, info: { projectId: repo.id, defaultBranch: repo.default_branch, protectDefault: repo.protect_default === 1 } };
}

function wantsV2(c: Context<AppEnv>): boolean {
  return (c.req.header('git-protocol') ?? '').split(':').includes('version=2');
}

gitRoutes.get('/:repo/info/refs', async (c) => {
  const service = c.req.query('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return plain(403, 'gitctx only speaks the smart HTTP protocol; update your git client');
  }
  const g = await gate(c, service === 'git-receive-pack');
  if (g instanceof Response) return g;
  const store = new GitStore(c.env, g.repo.id);
  const stream = await advertise(store, g.info, service, wantsV2(c));
  return new Response(stream, {
    headers: { 'content-type': `application/x-${service}-advertisement`, ...NO_CACHE },
  });
});

gitRoutes.post('/:repo/git-upload-pack', async (c) => {
  const g = await gate(c, false);
  if (g instanceof Response) return g;
  const contentType = 'application/x-git-upload-pack-result';
  const store = new GitStore(c.env, g.repo.id);
  try {
    const body = await readAll(await requestBody(c), 32 * 1024 * 1024);
    const stream = wantsV2(c) ? await uploadPackV2(store, g.info, body) : await uploadPackV0(store, body);
    return new Response(stream, { headers: { 'content-type': contentType, ...NO_CACHE } });
  } catch (err) {
    if (err instanceof GitProtocolError) return errorPkt(contentType, err.message);
    console.error('upload-pack failed', g.repo.slug, err);
    return errorPkt(contentType, 'internal error while preparing the pack');
  }
});

gitRoutes.post('/:repo/git-receive-pack', async (c) => {
  const g = await gate(c, true);
  if (g instanceof Response) return g;
  const contentType = 'application/x-git-receive-pack-result';
  const user = g.auth.user!;
  const store = new GitStore(c.env, g.repo.id);
  try {
    const { stream, results, commands } = await receivePack(store, g.info, await requestBody(c), {
      actor: user.id,
      onFirstBranch: async (branch) => {
        await c.env.DB.prepare('UPDATE projects SET default_branch = ? WHERE id = ?').bind(branch, g.repo.id).run();
      },
    });
    if (results.some((r) => r.ok)) {
      await c.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(nowMs(), g.repo.id).run();
      await audit(c.env.DB, user.email, 'git.push', `project:${g.repo.slug}`, {
        refs: commands.map((cmd, i) => ({ ref: cmd.ref, from: cmd.oldSha, to: cmd.newSha, ok: results[i]?.ok ?? false })),
      });
    }
    return new Response(stream, { headers: { 'content-type': contentType, ...NO_CACHE } });
  } catch (err) {
    if (err instanceof GitProtocolError) return errorPkt(contentType, err.message);
    console.error('receive-pack failed', g.repo.slug, err);
    return errorPkt(contentType, 'internal error while receiving the push');
  }
});
