import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { ApiError } from './lib/http';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { dlRoutes } from './routes/dl';
import { internalRoutes } from './routes/internal';
import { projectRoutes } from './routes/projects';
import { tokenRoutes } from './routes/tokens';
import { uploadRoutes } from './routes/uploads';
import { ExtractRunner } from './lib/extract';
import { requireSession, type AppEnv } from './middleware';

// The extraction container's durable object must be exported from the entry module.
export { ExtractRunner };

const app = new Hono<AppEnv>();

app.use('*', logger());
app.use('/api/*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
});

app.get('/api/health', (c) => c.json({ ok: true, name: 'gitctx' }));

app.route('/api/auth', authRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/uploads', uploadRoutes);
app.route('/api/tokens', tokenRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/internal', internalRoutes);

/** Totals for the dashboard rail — any signed-in teammate can read these. */
app.get('/api/stats', requireSession(), async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(size), 0) FROM release_files) AS storage_bytes,
       (SELECT COUNT(*) FROM projects) AS project_count,
       (SELECT COUNT(*) FROM releases WHERE status = 'published') AS release_count,
       (SELECT COALESCE(SUM(download_count), 0) FROM releases) AS download_count`,
  ).first<{ storage_bytes: number; project_count: number; release_count: number; download_count: number }>();
  return c.json({
    storageBytes: row?.storage_bytes ?? 0,
    projectCount: row?.project_count ?? 0,
    releaseCount: row?.release_count ?? 0,
    downloadCount: row?.download_count ?? 0,
  });
});

app.route('/dl', dlRoutes);

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: err.code, message: err.message, details: err.details ?? undefined }, err.status as never);
  }
  console.error('unhandled error', err, c.req.path);
  return c.json({ error: 'internal', message: 'Something went wrong on our side' }, 500);
});

app.notFound((c) => {
  // Everything that is not /api or /dl should have been served as a static
  // asset by the platform; if the Worker still sees it, fall back to the SPA.
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/dl/')) {
    return c.json({ error: 'not_found', message: 'No such endpoint' }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
