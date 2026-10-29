-- dropyard schema v2: automatic archive extraction (.zip / .rar)
CREATE TABLE extract_jobs (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('zip','rar')),
  archive_paths TEXT NOT NULL DEFAULT '[]', -- json: [{path, r2Key}] — the archive volume(s) this job unpacks
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  files_added INTEGER NOT NULL DEFAULT 0,
  bytes_added INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_extract_jobs_release ON extract_jobs(release_id, created_at DESC);

-- Attribution of extracted files back to the job that produced them, so a
-- failed job can clean up its partial output.
ALTER TABLE release_files ADD COLUMN extract_job_id TEXT;
