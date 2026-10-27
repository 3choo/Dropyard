import { nowMs } from './ids';

export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  target: string,
  meta?: unknown,
): Promise<void> {
  try {
    await db
      .prepare('INSERT INTO audit_log (actor, action, target, meta, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(actor, action, target, meta === undefined ? null : JSON.stringify(meta), nowMs())
      .run();
  } catch {
  }
}
