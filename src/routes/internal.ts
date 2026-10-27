import { Hono } from 'hono';
import { handleExtractCallback, isExtractPhase, type ExtractCallback } from '../lib/extract';
import { AppEnv } from '../middleware';
import { sha256Hex } from '../lib/ids';

export const internalRoutes = new Hono<AppEnv>();

const MAX_LOG_LINES = 200;

internalRoutes.post('/extract', async (c) => {
  const expected = c.env.EXTRACT_CALLBACK_SECRET;
  const presented = c.req.header('authorization');
  const token = presented?.startsWith('Bearer ') ? presented.slice(7) : null;
  if (!expected || !token || (await sha256Hex(token)) !== (await sha256Hex(expected))) {
    return c.json({ error: 'unauthorized', message: 'Invalid extraction callback secret' }, 401);
  }
  const body = await c.req.json<ExtractCallback>().catch(() => null);
  const known =
    body &&
    typeof body.jobId === 'string' &&
    ['file', 'files', 'done', 'failed', 'stage', 'log'].includes(body.type);
  if (!known) {
    return c.json({ error: 'bad_request', message: 'jobId and a known type are required' }, 400);
  }
  try {
    if (body.type === 'file') {
      if (typeof body.path !== 'string' || typeof body.size !== 'number') {
        return c.json({ error: 'bad_request', message: 'file events need path and size' }, 400);
      }
      await handleExtractCallback(c.env, { jobId: body.jobId, type: 'file', path: body.path, size: body.size, contentType: body.contentType });
    } else if (body.type === 'files') {
      if (!Array.isArray(body.files) || body.files.length === 0) {
        return c.json({ error: 'bad_request', message: 'files events need a non-empty files array' }, 400);
      }
      await handleExtractCallback(c.env, { jobId: body.jobId, type: 'files', files: body.files });
    } else if (body.type === 'stage') {
      if (!isExtractPhase(body.phase)) {
        return c.json({ error: 'bad_request', message: 'unknown extraction phase' }, 400);
      }
      await handleExtractCallback(c.env, {
        jobId: body.jobId,
        type: 'stage',
        phase: body.phase,
        detail: typeof body.detail === 'string' ? body.detail : undefined,
        log: typeof body.log === 'string' ? body.log.slice(0, 500) : undefined,
        totalFiles: typeof body.totalFiles === 'number' ? body.totalFiles : undefined,
        totalBytes: typeof body.totalBytes === 'number' ? body.totalBytes : undefined,
        archiveBytes: typeof body.archiveBytes === 'number' ? body.archiveBytes : undefined,
        bytesDone: typeof body.bytesDone === 'number' ? body.bytesDone : undefined,
      });
    } else if (body.type === 'log') {
      if (
        !Array.isArray(body.lines) ||
        body.lines.length === 0 ||
        body.lines.length > MAX_LOG_LINES ||
        !body.lines.every((l) => typeof l === 'string')
      ) {
        return c.json({ error: 'bad_request', message: `log events need 1-${MAX_LOG_LINES} string lines` }, 400);
      }
      await handleExtractCallback(c.env, { jobId: body.jobId, type: 'log', lines: body.lines });
    } else if (body.type === 'done') {
      await handleExtractCallback(c.env, { jobId: body.jobId, type: 'done' });
    } else {
      await handleExtractCallback(c.env, { jobId: body.jobId, type: 'failed', error: String(body.error ?? '') });
    }
  } catch (err) {
    const code = err instanceof Error ? err.message : 'callback_failed';
    return c.json({ error: code }, 410);
  }
  return c.json({ ok: true });
});
