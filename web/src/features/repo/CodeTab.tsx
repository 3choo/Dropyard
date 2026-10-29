import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../../api/client';
import { Markdown } from '../../components/Markdown';
import { Button, CopyButton, EmptyState, Select, toast } from '../../components/ui';
import { IconBranch, IconFile, IconFolder, IconHistory, IconPlus, IconTag, IconUpload } from '../../components/icons';
import { formatBytes, timeAgo } from '../../lib/format';
import { useProject } from '../project/ProjectPage';
import { apiQuery, blobUrl, commitUrl, commitsUrl, newFileUrl, treeUrl } from './links';
import type { Commit, ImportState, RepoSummary, TreeEntry } from './types';

type TreeResponse =
  | { kind: 'tree'; ref: string; commit: string; path: string; entries: TreeEntry[]; readme: { path: string; content: string } | null; lastCommit: Commit | null }
  | { kind: 'blob'; ref: string; commit: string; path: string };

export function RefPicker({
  repo,
  value,
  onChange,
  className = '',
}: {
  repo: RepoSummary;
  value: string;
  onChange: (ref: string) => void;
  className?: string;
}) {
  const known = repo.branches.some((b) => b.name === value) || repo.tags.some((t) => t.name === value);
  return (
    <div className={`relative flex items-center ${className}`}>
      <IconBranch size={13} className="pointer-events-none absolute left-2.5 text-ink-3" />
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="max-w-[16rem] pl-7 font-mono text-[12px]" aria-label="Branch or tag">
        {!known ? <option value={value}>{value.length === 40 ? value.slice(0, 7) : value}</option> : null}
        <optgroup label="Branches">
          {repo.branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </optgroup>
        {repo.tags.length > 0 ? (
          <optgroup label="Tags">
            {repo.tags.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </optgroup>
        ) : null}
      </Select>
    </div>
  );
}

export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md bg-accent/15 font-mono text-accent"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      aria-hidden
    >
      {(name || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Breadcrumbs({ slug, refName, path, leafIsFile }: { slug: string; refName: string; path: string; leafIsFile?: boolean }) {
  const parts = path ? path.split('/') : [];
  const { project } = useProject();
  return (
    <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-[13px]">
      <Link to={treeUrl(slug, refName)} className="font-medium text-ink hover:text-accent">
        {project.slug}
      </Link>
      {parts.map((part, i) => {
        const sub = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <span key={sub} className="flex items-center gap-1">
            <span className="text-ink-3">/</span>
            {last ? (
              <span className={leafIsFile ? 'font-medium text-ink' : 'text-ink'}>{part}</span>
            ) : (
              <Link to={treeUrl(slug, refName, sub)} className="text-ink-2 hover:text-accent">
                {part}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function CommitBar({ slug, commit, count, refName }: { slug: string; commit: Commit; count?: number; refName?: string | null }) {
  return (
    <div className="flex items-center gap-2.5 rounded-t-xl border border-line bg-panel-2 px-3.5 py-2.5 text-[12.5px]">
      <Avatar name={commit.authorName} />
      <span className="shrink-0 font-medium">{commit.authorName}</span>
      <Link to={commitUrl(slug, commit.sha)} className="min-w-0 flex-1 truncate text-ink-2 hover:text-ink">
        {commit.subject}
      </Link>
      <Link to={commitUrl(slug, commit.sha)} className="hidden font-mono text-[11.5px] text-ink-3 hover:text-ink sm:inline">
        {commit.sha.slice(0, 7)}
      </Link>
      <span className="hidden font-mono text-[11.5px] text-ink-3 sm:inline">{timeAgo(commit.committedAt)}</span>
      {count !== undefined ? (
        <Link to={commitsUrl(slug, refName)} className="flex shrink-0 items-center gap-1 font-mono text-[11.5px] text-ink-2 hover:text-ink">
          <IconHistory size={13} />
          {count}
        </Link>
      ) : null}
    </div>
  );
}

export function CodeTab() {
  const { project, repo, refetchRepo, canUpload } = useProject();
  const slug = project.slug;
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const path = (params['*'] ?? '').replace(/\/+$/, '');
  const refName = search.get('ref') || repo?.defaultBranch || 'main';

  const tree = useQuery({
    queryKey: ['tree', slug, refName, path],
    queryFn: () => api<TreeResponse>(`/api/projects/${slug}/repo/tree${apiQuery({ ref: refName, path })}`),
    enabled: !!repo && !repo.empty,
  });

  useEffect(() => {
    if (tree.data?.kind === 'blob') navigate(blobUrl(slug, search.get('ref'), path), { replace: true });
  }, [tree.data, navigate, slug, search, path]);

  if (!repo) return <p className="text-[13px] text-ink-3">Loading…</p>;
  if (repo.empty) return <EmptyRepo repo={repo} onImported={refetchRepo} canUpload={canUpload} />;

  const data = tree.data?.kind === 'tree' ? tree.data : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <RefPicker repo={repo} value={refName} onChange={(r) => navigate(treeUrl(slug, r === repo.defaultBranch ? null : r, path))} />
        <Link to={`/p/${slug}/branches`} className="flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink">
          <IconBranch size={13} className="text-ink-3" />
          <span className="font-mono tnum">{repo.branches.length}</span> {repo.branches.length === 1 ? 'branch' : 'branches'}
        </Link>
        <Link to={`/p/${slug}/releases`} className="flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink">
          <IconTag size={13} className="text-ink-3" />
          <span className="font-mono tnum">{repo.tags.length}</span> {repo.tags.length === 1 ? 'tag' : 'tags'}
        </Link>
        <div className="flex-1" />
        {path ? <Breadcrumbs slug={slug} refName={refName} path={path} /> : null}
        {canUpload ? (
          <Button variant="secondary" onClick={() => navigate(newFileUrl(slug, search.get('ref'), path))}>
            <IconPlus size={14} />
            Add file
          </Button>
        ) : null}
      </div>

      {tree.isError ? (
        <EmptyState
          icon={<IconFolder />}
          title="Nothing here"
          body={errMsg(tree.error, 'This path does not exist at this ref.')}
        />
      ) : !data ? (
        <p className="text-[13px] text-ink-3">Loading…</p>
      ) : (
        <>
          {data.lastCommit ? <CommitBar slug={slug} commit={data.lastCommit} count={path ? undefined : repo.commitCount} refName={search.get("ref") ?? undefined} /> : null}
          <div className={`overflow-hidden border border-line bg-panel ${data.lastCommit ? 'rounded-b-xl border-t-0' : 'rounded-xl'}`}>
            {path ? (
              <Link
                to={treeUrl(slug, search.get('ref'), path.split('/').slice(0, -1).join('/'))}
                className="flex h-9 items-center gap-2.5 border-b border-line px-3.5 font-mono text-[12.5px] text-ink-2 hover:bg-panel-2/60"
              >
                ..
              </Link>
            ) : null}
            {data.entries.map((e) => (
              <Link
                key={e.path}
                to={e.type === 'tree' ? treeUrl(slug, search.get('ref'), e.path) : blobUrl(slug, search.get('ref'), e.path)}
                className="flex h-9 items-center gap-2.5 border-b border-line px-3.5 text-[13px] last:border-b-0 hover:bg-panel-2/60"
              >
                {e.type === 'tree' ? (
                  <IconFolder size={15} className="shrink-0 text-accent-dim" />
                ) : (
                  <IconFile size={15} className="shrink-0 text-ink-3" />
                )}
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {e.size !== null ? <span className="font-mono text-[11px] text-ink-3 tnum">{formatBytes(e.size)}</span> : null}
              </Link>
            ))}
          </div>
          {data.readme ? (
            <div className="mt-5 overflow-hidden rounded-xl border border-line bg-panel">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px]">
                <IconFile size={14} className="text-ink-3" />
                <Link to={blobUrl(slug, search.get('ref'), data.readme.path)} className="font-medium hover:text-accent">
                  {data.readme.path.split('/').pop()}
                </Link>
              </div>
              <div className="px-6 py-5">
                {/\.(md|markdown)$/i.test(data.readme.path) ? (
                  <Markdown source={data.readme.content} />
                ) : (
                  <pre className="whitespace-pre-wrap font-mono text-[12.5px] text-ink-2">{data.readme.content}</pre>
                )}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function EmptyRepo({ repo, onImported, canUpload }: { repo: RepoSummary; onImported: () => void; canUpload: boolean }) {
  return (
    <div className="space-y-5">
      {canUpload && (repo.canImport || repo.import) ? <ImportCard repo={repo} onDone={onImported} /> : null}
      <div className="rounded-xl border border-line bg-panel p-5">
        <h2 className="text-[15px] font-semibold">Quick setup with GitHub Desktop</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-ink-2">
          <li>
            Create a <Link to="/settings/tokens" className="text-ink underline decoration-line-2 underline-offset-2">personal access token</Link>{' '}
            (once per computer).
          </li>
          <li>
            In GitHub Desktop: <span className="text-ink">File → Clone repository → URL</span>, paste the URL below.
          </li>
          <li>When it asks to sign in, use your gitctx email as the username and the token as the password.</li>
          <li>Add files, commit, and press <span className="text-ink">Publish branch</span>.</li>
        </ol>
        <div className="mt-4 flex items-center gap-1 rounded-lg border border-line bg-ground pl-3">
          <code className="min-w-0 flex-1 truncate py-2 font-mono text-[12px]">{repo.cloneUrl}</code>
          <CopyButton value={repo.cloneUrl} className="mr-1" />
        </div>
        <p className="mt-4 text-[12px] text-ink-3">Or from a terminal:</p>
        <pre className="mt-1.5 overflow-x-auto rounded-lg border border-line bg-ground px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink-2">{`git clone ${repo.cloneUrl}
cd ${repo.cloneUrl.split('/').pop()?.replace(/\.git$/, '')}
git add . && git commit -m "First commit"
git push -u origin ${repo.defaultBranch}`}</pre>
      </div>
    </div>
  );
}

function ImportCard({ repo, onDone }: { repo: RepoSummary; onDone: () => void }) {
  const { project, releases } = useProject();
  const [state, setState] = useState<ImportState | null>(repo.import);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const published = releases.filter((r) => r.status === 'published').length;

  const drive = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      for (;;) {
        const res = await api<{ import: ImportState }>(`/api/projects/${project.slug}/repo/import/step`, { method: 'POST' });
        setState(res.import);
        if (res.import.status !== 'running') break;
      }
    } catch (err) {
      toast(errMsg(err, 'Import step failed — you can resume it'), 'err');
    } finally {
      running.current = false;
      setBusy(false);
      onDone();
    }
  };

  const start = async (mode: 'latest' | 'all') => {
    try {
      const res = await api<{ import: ImportState }>(`/api/projects/${project.slug}/repo/import`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      setState(res.import);
      void drive();
    } catch (err) {
      toast(errMsg(err, 'Could not start the import'), 'err');
    }
  };

  const frac = state && state.bytesTotal > 0 ? state.bytesDone / state.bytesTotal : state?.filesTotal ? state.filesDone / state.filesTotal : 0;

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/[0.04] p-5">
      <h2 className="text-[15px] font-semibold">Start from your releases</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-ink-2">
        Turn what you already uploaded into Git history. Files are fingerprinted where they sit in storage — nothing is
        uploaded again. Each imported release becomes a commit tagged with its version.
      </p>
      {state && state.status !== 'done' ? (
        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline justify-between font-mono text-[11.5px] text-ink-2 tnum">
            <span>
              release {Math.min(state.releaseIndex + 1, state.releases)}/{state.releases} · {state.filesDone}/{state.filesTotal} files
            </span>
            <span>
              {formatBytes(state.bytesDone)} / {formatBytes(state.bytesTotal)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(2, frac * 100)}%` }} />
          </div>
          {state.status === 'failed' ? (
            <p className="mt-3 text-[12.5px] text-danger">{state.error ?? 'The import failed.'}</p>
          ) : null}
          <div className="mt-3 flex gap-2">
            {state.status === 'running' && !busy ? (
              <Button variant="primary" onClick={() => void drive()}>
                Resume import
              </Button>
            ) : null}
            {state.status === 'failed' ? (
              <Button variant="secondary" onClick={() => void start('latest')}>
                Start over
              </Button>
            ) : null}
            {busy ? <span className="text-[12px] text-ink-3">Keep this tab open while it runs.</span> : null}
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void start('latest')}>
            <IconUpload size={14} />
            Import latest release
          </Button>
          {published > 1 ? (
            <Button variant="secondary" onClick={() => void start('all')}>
              Import all {published} releases as history
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
