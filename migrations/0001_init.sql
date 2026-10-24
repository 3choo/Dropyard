-- gitctx schema v1
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,            -- pbkdf2$<iterations>$<salt_b64>$<hash_b64>
  role TEXT NOT NULL CHECK (role IN ('admin','uploader','viewer')),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                     -- sha256(token) hex
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','uploader','viewer')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,                    -- sha256(email|ip)
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  blocked_until INTEGER
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  is_latest INTEGER NOT NULL DEFAULT 0,
  digest TEXT,                             -- manifest digest, set at publish
  download_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (project_id, version)
);
CREATE INDEX idx_releases_project ON releases(project_id, created_at DESC);
CREATE INDEX idx_releases_latest ON releases(project_id, is_latest) WHERE is_latest = 1;

CREATE TABLE release_files (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  part_digests TEXT NOT NULL DEFAULT '[]', -- json: [{n, sha256}]
  digest TEXT,                             -- sha256 over part digests
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (release_id, path)
);
CREATE INDEX idx_files_release ON release_files(release_id);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES release_files(id) ON DELETE CASCADE, -- set when the file row is finalized
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  part_size INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('presigned','single')),
  s3_upload_id TEXT,
  parts_done TEXT NOT NULL DEFAULT '[]',   -- json: [{n, etag}]
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','aborted')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_uploads_release ON upload_sessions(release_id);

CREATE TABLE deploy_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,         -- sha256(plaintext) hex
  prefix TEXT NOT NULL,                    -- first chars, for identification
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  last_used_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
