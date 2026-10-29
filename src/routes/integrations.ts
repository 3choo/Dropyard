import { Hono } from 'hono';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/http';
import { nowMs, randomId } from '../lib/ids';
import { CONNECTORS, EVENT_TYPES, getConnector, type Config, type DropEvent } from '../integrations';
import {
  buildEvent,
  parseConfig,
  parseEvents,
  recordDelivery,
  sendEvent,
  type IntegrationRow,
} from '../lib/events';
import { requireRole, sessionUser, type AppEnv } from '../middleware';
import { getProjectBySlug } from './projects';

export const integrationRoutes = new Hono<AppEnv>();
integrationRoutes.use('*', requireRole('admin'));

const MASK = '••••';

function maskValue(value: string): string {
  return value ? `${MASK}${value.slice(-4)}` : '';
}

function redact(row: IntegrationRow): Config {
  const connector = getConnector(row.type);
  const config = parseConfig(row);
  const out: Config = {};
  for (const field of connector?.fields ?? []) {
    const value = config[field.key] ?? '';
    out[field.key] = field.secret ? maskValue(value) : value;
  }
  return out;
}

function present(row: IntegrationRow, project: { slug: string; name: string } | null, last: { ok: number; created_at: number; error: string | null } | null) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    project: project ? { slug: project.slug, name: project.name } : null,
    events: parseEvents(row),
    config: redact(row),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    lastDelivery: last ? { ok: !!last.ok, at: last.created_at, error: last.error } : null,
  };
}

function mergeConfig(type: string, submitted: unknown, stored: Config): Config {
  const connector = getConnector(type);
  if (!connector) throw badRequest('Unknown integration type');
  const input = submitted && typeof submitted === 'object' ? (submitted as Record<string, unknown>) : {};
  const out: Config = {};
  for (const field of connector.fields) {
    const raw = input[field.key];
    const kept = stored[field.key] ?? '';
    if (typeof raw !== 'string') out[field.key] = kept;
    else if (field.secret && raw.startsWith(MASK)) out[field.key] = kept;
    else out[field.key] = raw.trim().slice(0, 500);
  }
  const problem = connector.check?.(out) ?? null;
  if (problem) throw badRequest(problem);
  return out;
}

function cleanEvents(value: unknown): string[] {
  if (value === undefined) return ['*'];
  if (!Array.isArray(value) || value.length === 0) throw badRequest('Choose at least one event');
  const allowed = new Set<string>(['*', ...EVENT_TYPES]);
  const events = [...new Set(value.map(String))];
  if (events.some((e) => !allowed.has(e))) throw badRequest('Unknown event type');
  return events.includes('*') ? ['*'] : events;
}

function cleanName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length > 80) throw badRequest('Name is too long (80 characters max)');
  return name || fallback;
}

async function loadRow(db: D1Database, id: string): Promise<IntegrationRow> {
  const row = await db.prepare('SELECT * FROM integrations WHERE id = ?').bind(id).first<IntegrationRow>();
  if (!row) throw notFound('Integration not found');
  return row;
}

async function projectOf(db: D1Database, id: string | null) {
  if (!id) return null;
  return db.prepare('SELECT id, slug, name FROM projects WHERE id = ?').bind(id).first<{ id: string; slug: string; name: string }>();
}

integrationRoutes.get('/types', (c) =>
  c.json({
    events: EVENT_TYPES,
    types: CONNECTORS.map((k) => ({ type: k.type, label: k.label, description: k.description, fields: k.fields })),
  }),
);

integrationRoutes.get('/', async (c) => {
  const slug = c.req.query('project');
  let rows;
  if (slug) {
    const project = await getProjectBySlug(c.env.DB, slug);
    if (!project) throw notFound('Project not found');
    rows = await c.env.DB
      .prepare('SELECT * FROM integrations WHERE project_id = ? ORDER BY created_at')
      .bind(project.id)
      .all<IntegrationRow>();
  } else {
    rows = await c.env.DB.prepare('SELECT * FROM integrations ORDER BY created_at').all<IntegrationRow>();
  }
  const out = [];
  for (const row of rows.results) {
    const [project, last] = await Promise.all([
      projectOf(c.env.DB, row.project_id),
      c.env.DB
        .prepare('SELECT ok, created_at, error FROM deliveries WHERE integration_id = ? ORDER BY id DESC LIMIT 1')
        .bind(row.id)
        .first<{ ok: number; created_at: number; error: string | null }>(),
    ]);
    out.push(present(row, project, last));
  }
  return c.json({ integrations: out });
});

integrationRoutes.post('/', async (c) => {
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const connector = getConnector(String(body.type ?? ''));
  if (!connector) throw badRequest('Choose an integration type');
  let projectId: string | null = null;
  if (typeof body.project === 'string' && body.project) {
    const project = await getProjectBySlug(c.env.DB, body.project);
    if (!project) throw notFound('Project not found');
    projectId = project.id;
  }
  const config = mergeConfig(connector.type, body.config, {});
  const events = cleanEvents(body.events);
  const id = randomId(9).toLowerCase();
  const now = nowMs();
  await c.env.DB
    .prepare(
      'INSERT INTO integrations (id, type, name, project_id, events, config, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
    )
    .bind(id, connector.type, cleanName(body.name, connector.label), projectId, JSON.stringify(events), JSON.stringify(config), sessionUser(c).id, now, now)
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'integration.create', `integration:${id}`, { type: connector.type, project: projectId });
  return c.json({ id }, 201);
});

integrationRoutes.put('/:id', async (c) => {
  const row = await loadRow(c.env.DB, c.req.param('id'));
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const config = body.config === undefined ? parseConfig(row) : mergeConfig(row.type, body.config, parseConfig(row));
  const events = body.events === undefined ? parseEvents(row) : cleanEvents(body.events);
  const name = body.name === undefined ? row.name : cleanName(body.name, row.name);
  const enabled = typeof body.enabled === 'boolean' ? (body.enabled ? 1 : 0) : row.enabled;
  await c.env.DB
    .prepare('UPDATE integrations SET name = ?, events = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .bind(name, JSON.stringify(events), JSON.stringify(config), enabled, nowMs(), row.id)
    .run();
  await audit(c.env.DB, sessionUser(c).email, 'integration.update', `integration:${row.id}`, { enabled: !!enabled });
  return c.json({ ok: true });
});

integrationRoutes.delete('/:id', async (c) => {
  const row = await loadRow(c.env.DB, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM integrations WHERE id = ?').bind(row.id).run();
  await audit(c.env.DB, sessionUser(c).email, 'integration.delete', `integration:${row.id}`, { type: row.type });
  return c.json({ ok: true });
});

integrationRoutes.post('/:id/test', async (c) => {
  const row = await loadRow(c.env.DB, c.req.param('id'));
  const project = await projectOf(c.env.DB, row.project_id);
  const event = buildEvent(new URL(c.req.url).origin, {
    type: 'release.published',
    project: project ?? { id: '', slug: 'example-project', name: 'Example project' },
    actor: sessionUser(c).email,
    title: `${project?.name ?? 'Example project'} — v1.0.0`,
    body: 'This is a test message from dropyard.',
    path: project ? `/p/${project.slug}` : '/',
    data: { test: true },
  });
  const test: DropEvent = { ...event, type: 'test' };
  const result = await sendEvent(row, test);
  await recordDelivery(c.env.DB, row.id, test, result);
  return c.json(result);
});

integrationRoutes.get('/:id/deliveries', async (c) => {
  const row = await loadRow(c.env.DB, c.req.param('id'));
  const rows = await c.env.DB
    .prepare('SELECT id, event, ok, status, attempts, error, created_at FROM deliveries WHERE integration_id = ? ORDER BY id DESC LIMIT 30')
    .bind(row.id)
    .all();
  return c.json({ deliveries: rows.results });
});

integrationRoutes.post('/:id/deliveries/:did/redeliver', async (c) => {
  const row = await loadRow(c.env.DB, c.req.param('id'));
  const delivery = await c.env.DB
    .prepare('SELECT payload FROM deliveries WHERE id = ? AND integration_id = ?')
    .bind(c.req.param('did'), row.id)
    .first<{ payload: string }>();
  if (!delivery) throw notFound('Delivery not found');
  const event = JSON.parse(delivery.payload) as DropEvent;
  const result = await sendEvent(row, event);
  await recordDelivery(c.env.DB, row.id, event, result);
  return c.json(result);
});
