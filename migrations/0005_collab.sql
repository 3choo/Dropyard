-- dropyard v5: issues, pull requests, reviews and comments (GitHub-style).

-- When set, the default branch only changes through approved pull requests:
-- direct pushes and browser commits to it are refused.
ALTER TABLE projects ADD COLUMN protect_default INTEGER NOT NULL DEFAULT 0;

-- Issues and pull requests share one number sequence per project, like GitHub.
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue','pull')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','merged')),
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- pull requests only
  head_branch TEXT,
  base_branch TEXT,
  head_sha TEXT,                           -- last known head (kept after merge/close)
  base_sha TEXT,                           -- base tip when merged/closed
  merge_commit TEXT,
  merged_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  merged_at INTEGER,
  UNIQUE (project_id, number)
);
CREATE INDEX idx_issues_list ON issues(project_id, kind, state, number);

-- Conversation comments on issues/PRs, inline review comments on PR diffs
-- (path + line + side), and comments on commits (target_type 'commit').
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('issue','commit')),
  target_id TEXT NOT NULL,                 -- issues.id or a commit sha
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  side TEXT CHECK (side IN ('old','new')),
  commit_sha TEXT,
  review_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_comments_target ON comments(project_id, target_type, target_id, created_at);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('approved','changes_requested','commented')),
  body TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reviews_issue ON reviews(issue_id, created_at);

-- Timeline events (closed, reopened, merged, head pushed, …).
CREATE TABLE issue_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_issue_events_issue ON issue_events(issue_id, created_at);
