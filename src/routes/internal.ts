import { Hono } from 'hono';
import { handleExtractCallback, type ExtractCallback } from '../lib/extract';
import { AppEnv } from '../middleware';
import { sha256Hex } from '../lib/ids';

/**
 * Machine endpoint for the extraction container: it reports each unpacked
 * file and the job outcome here. Authenticated with a shared secret, not a
 * session — the container is not a browser.
 */
export const internalRoutes = new Hono<AppEnv>();

internalRoutes.post('/extract', async (c) => {
  const expected = c.env.EXTRACT_CALLBACK_SECRET;
  const presented = c.req.header('authorization');
  const token = presented?.startsWith('Bearer ') ? presented.slice(7) : null;
  if (!expected || !token || (await sha256Hex(token)) !== (await sha256Hex(expected))) {
    return c.json({ error: 'unauthorized', message: 'Invalid extraction callback secret' }, 401);
  }
  const body = await c.req.json<ExtractCallback>().catch(() => null);
  if (!body || typeof body.jobId !== 'string' || (body.type !== 'file' && body.type !== 'done' && body.type !== 'failed')) {
    return c.json({ error: 'bad_request', message: 'jobId and a known type are required' }, 400);
  }
  try {
    if (body.type === 'file') {
      if (typeof body.path !== 'string' || typeof body.size !== 'number') {
        return c.json({ error: 'bad_request', message: 'file events need path and size' }, 400);
      }
      await handleExtractCallback(c.env, { jobId: body.jobId, type: 'file', path: body.path, size: body.size, contentType: body.contentType });
    } else if (body.type === 'done') {
      await handleExtractCallback(c.env, { jobId: body.jobId, type: 'done' });
    } else {
      await handleExtractCallback(c.env, { jobId: body.jobId, type: 'failed', error: String(body.error ?? '') });
    }
  } catch (err) {
    const code = err instanceof Error ? err.message : 'callback_failed';
    // 410 tells the container its job is gone or closed — stop reporting, exit.
    return c.json({ error: code }, 410);
  }
  return c.json({ ok: true });
});
