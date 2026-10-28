export type Commit = {
  sha: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  committedAt: number;
  subject: string;
  message: string;
};

export type ImportState = {
  status: 'running' | 'done' | 'failed';
  releases: number;
  releaseIndex: number;
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  error: string | null;
  updatedAt: number;
};

export type RepoSummary = {
  defaultBranch: string;
  protectDefault: boolean;
  empty: boolean;
  cloneUrl: string;
  head: Commit | null;
  commitCount: number;
  branches: { name: string; sha: string; commit: Commit | null }[];
  tags: { name: string; sha: string }[];
  import: ImportState | null;
  canImport: boolean;
};

export type TreeEntry = {
  name: string;
  path: string;
  type: 'tree' | 'blob' | 'symlink' | 'submodule';
  sha: string;
  size: number | null;
};

export type DiffLine = { t: ' ' | '-' | '+'; s: string };
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] };

export type PatchedFile = {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  oldSha: string | null;
  newSha: string | null;
  oldSize: number | null;
  newSize: number | null;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[] | null;
  skipped: 'binary' | 'large' | 'budget' | null;
};

export type Person = { id: string; name: string; email: string } | null;

export type LineComment = {
  id: string;
  author: Person;
  body: string;
  path: string | null;
  line: number | null;
  side: string | null;
  createdAt: number;
  updatedAt: number;
};
