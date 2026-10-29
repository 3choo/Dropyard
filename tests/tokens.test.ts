import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const worker = (exports as unknown as { default: { fetch: typeof fetch } }).default;
let cookie = '';

async function call(path: string, init: RequestInit = {}, withCookie = true) {
  const headers = new Headers(init.headers);
  if (withCookie && cookie) headers.set('cookie', cookie);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await worker.fetch(`http://localhost${path}`, { ...init, headers });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const { res } = await call(
    '/api/auth/setup',
    { method: 'POST', body: JSON.stringify({ name: 'Root', email: 'root@team.gg', password: 'correct-horse-battery' }) },
    false,
  );
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
});

describe('deploy token admin', () => {
  it('requires an admin session', async () => {
    expect((await call('/api/tokens', {}, false)).res.status).toBe(401);
  });

  it('creates a token once in plaintext, lists only its prefix, and deletes it', async () => {
    const created = await call('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'prod server' }) });
    expect(created.res.status).toBe(201);
    expect(created.body.token).toMatch(/^gctx_/);

    const listed = await call('/api/tokens');
    const row = listed.body.tokens.find((t: { id: string }) => t.id === created.body.id);
    expect(row.prefix).toBe(created.body.token.slice(0, 12));
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    expect((await call(`/api/tokens/${created.body.id}`, { method: 'DELETE' })).res.status).toBe(200);
    expect((await call(`/api/tokens/${created.body.id}`, { method: 'DELETE' })).res.status).toBe(404);
  });

  it('rejects unnamed tokens and unknown project scopes', async () => {
    expect((await call('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).res.status).toBe(400);
    const scoped = await call('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'scoped token', projectId: 'missing' }),
    });
    expect(scoped.res.status).toBe(400);
  });
});
