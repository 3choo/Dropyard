-- dropyard schema v3: live unpack progress + console log.
-- The extraction container (and the in-Worker zip path) report phase changes
-- and byte counters as the job runs, so the release page can render a progress
-- bar with an ETA. extract_log is a ring buffer of console lines shown in a
-- terminal-style panel; old lines are trimmed by the writer, not the schema.
ALTER TABLE extract_jobs ADD COLUMN phase TEXT;             -- download|scan|extract|upload|finish (null before start)
ALTER TABLE extract_jobs ADD COLUMN detail TEXT;            -- e.g. the volume basename or "batch 3/12"
ALTER TABLE extract_jobs ADD COLUMN total_files INTEGER;    -- entries per the archive listing (rar only)
ALTER TABLE extract_jobs ADD COLUMN total_bytes INTEGER;    -- uncompressed payload bytes (rar only)
ALTER TABLE extract_jobs ADD COLUMN archive_bytes INTEGER;  -- archive bytes on disk (zip stream size, rar volume total)
ALTER TABLE extract_jobs ADD COLUMN bytes_done INTEGER NOT NULL DEFAULT 0; -- phase numerator: downloaded rar bytes / read zip bytes

CREATE TABLE extract_log (
  job_id TEXT NOT NULL REFERENCES extract_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  line TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (job_id, seq)
);
