-- dropyard v4: every project is also a Git repository (smart HTTP, so GitHub
-- Desktop can clone/push/pull), plus personal access tokens for git auth.

ALTER TABLE projects ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE releases ADD COLUMN commit_sha TEXT;

-- Content-addressed object index. Blobs (and oversize trees/commits) live in
-- R2 at r2_key; small trees/commits/tags are stored inline in data. A blob
-- imported from a release points at that release file's existing R2 object.
CREATE TABLE git_objects (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('blob','tree','commit','tag')),
  size INTEGER NOT NULL,
  r2_key TEXT,
  data BLOB,
  PRIMARY KEY (project_id, sha)
);
CREATE INDEX idx_git_objects_r2 ON git_objects(r2_key);

CREATE TABLE git_refs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                      -- refs/heads/main, refs/tags/v1.2.3
  sha TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (project_id, name)
);

-- Parsed commits, for history listings and ancestry queries without
-- re-reading objects.
CREATE TABLE git_commits (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  tree TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  author_time INTEGER NOT NULL,            -- unix seconds
  committer_time INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (project_id, sha)
);
CREATE INDEX idx_git_commits_time ON git_commits(project_id, committer_time);

CREATE TABLE git_commit_parents (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  parent TEXT NOT NULL,
  idx INTEGER NOT NULL,
  PRIMARY KEY (project_id, sha, idx)
);
CREATE INDEX idx_git_parents_parent ON git_commit_parents(project_id, parent);

-- One-time import: published releases become the first commits (oldest
-- first, each tagged v<version>). Files are hashed in resumable steps driven by
-- the browser; blobs reuse the release files' existing R2 objects.
CREATE TABLE git_imports (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  release_ids TEXT NOT NULL,               -- json array, oldest first
  release_index INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT '',         -- last hashed path in the current release
  status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  files_total INTEGER NOT NULL,
  files_done INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT,                           -- last commit written
  error TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE git_import_files (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (project_id, release_id, path)
);

-- Personal access tokens: the password GitHub Desktop / git sends.
CREATE TABLE user_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id);
