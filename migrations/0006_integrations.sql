-- dropyard v6: outbound integrations (chat, webhooks, ...) driven by one event bus.

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  events TEXT NOT NULL DEFAULT '["*"]',
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_integrations_project ON integrations(project_id);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_deliveries_integration ON deliveries(integration_id, id DESC);

INSERT INTO integrations (id, type, name, project_id, events, config, enabled, created_at, updated_at)
SELECT lower(hex(randomblob(9))), 'discord', 'Discord announcements', NULL, '["release.published"]',
       json_object('url', value), 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM settings
WHERE key = 'discord_webhook_url' AND value != '';

DELETE FROM settings WHERE key = 'discord_webhook_url';
