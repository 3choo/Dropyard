import { getConnector } from '../integrations';
import type { Config, DropEvent, EventType } from '../integrations';
import { nowMs, randomId } from './ids';

export interface IntegrationRow {
  id: string;
  type: string;
  name: string;
  project_id: string | null;
  events: string;
  config: string;
  enabled: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  attempts: number;
  error: string | null;
}

export interface EventInput {
  type: EventType;
  project: { id: string; slug: string; name: string };
  actor: string;
  title: string;
  body?: string;
  path: string;
  data?: Record<string, unknown>;
}

const RETRY_DELAYS_MS = [0, 1500, 6000];
const KEEP_DELIVERIES = 50;

export function parseConfig(row: Pick<IntegrationRow, 'config'>): Config {
  try {
    const value = JSON.parse(row.config) as unknown;
    return value && typeof value === 'object' ? (value as Config) : {};
  } catch {
    return {};
  }
}

export function parseEvents(row: Pick<IntegrationRow, 'events'>): string[] {
  try {
    const value = JSON.parse(row.events) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function buildEvent(origin: string, input: EventInput): DropEvent {
  return {
    id: randomId(12),
    type: input.type,
    at: nowMs(),
    actor: input.actor,
    project: { slug: input.project.slug, name: input.project.name },
    title: input.title,
    body: input.body ?? '',
    url: origin + input.path,
    data: input.data ?? {},
  };
}

export async function sendEvent(row: IntegrationRow, event: DropEvent): Promise<DeliveryResult> {
  const connector = getConnector(row.type);
  if (!connector) return { ok: false, status: null, attempts: 0, error: `Unknown integration type "${row.type}"` };
  let status: number | null = null;
  let error: string | null = null;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt - 1] ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const req = await connector.build(parseConfig(row), event);
      const res = await fetch(req.url, {
        method: req.method ?? 'POST',
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      error = res.ok ? null : `HTTP ${res.status}`;
      void res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true, status, attempts: attempt, error: null };
      if (res.status !== 429 && res.status < 500) return { ok: false, status, attempts: attempt, error };
    } catch (err) {
      status = null;
      error = err instanceof Error ? err.message : 'Request failed';
    }
  }
  return { ok: false, status, attempts: RETRY_DELAYS_MS.length, error };
}

export async function recordDelivery(
  db: D1Database,
  integrationId: string,
  event: DropEvent,
  result: DeliveryResult,
): Promise<void> {
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO deliveries (integration_id, event, ok, status, attempts, error, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(integrationId, event.type, result.ok ? 1 : 0, result.status, result.attempts, result.error, JSON.stringify(event), nowMs()),
      db
        .prepare(
          'DELETE FROM deliveries WHERE integration_id = ? AND id NOT IN (SELECT id FROM deliveries WHERE integration_id = ? ORDER BY id DESC LIMIT ?)',
        )
        .bind(integrationId, integrationId, KEEP_DELIVERIES),
    ]);
  } catch {
    // A full or unavailable log must never break the action that raised the event.
  }
}

export function emit(env: Env, waitUntil: (p: Promise<unknown>) => void, origin: string, input: EventInput): void {
  waitUntil(
    (async () => {
      try {
        const rows = await env.DB
          .prepare('SELECT * FROM integrations WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?)')
          .bind(input.project.id)
          .all<IntegrationRow>();
        const targets = rows.results.filter((row) => {
          const events = parseEvents(row);
          return events.includes('*') || events.includes(input.type);
        });
        if (targets.length === 0) return;
        const event = buildEvent(origin, input);
        await Promise.all(
          targets.map(async (row) => recordDelivery(env.DB, row.id, event, await sendEvent(row, event))),
        );
      } catch (err) {
        console.error('emit failed', input.type, err);
      }
    })(),
  );
}
