import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../api/client';
import { Button, Chip, CopyButton, EmptyState, Input, Loading, Textarea, toast } from '../../components/ui';
import { IconBranch, IconCommit, IconPullRequest, IconTag, IconTrash } from '../../components/icons';
import { formatDate, timeAgo } from '../../lib/format';
import { useProject } from '../project/ProjectPage';
import { Avatar, RefPicker } from './CodeTab';
import { CommentThread, DiffStat, DiffView } from './DiffView';
import { apiQuery, commitUrl, commitsUrl, compareUrl, treeUrl } from './links';
import type { Commit, LineComment, PatchedFile } from './types';

function dayLabel(ts: number) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function CommitRows({ slug, commits }: { slug: string; commits: (Commit & { releases?: string[] })[] }) {
  const groups: { day: string; items: (Commit & { releases?: string[] })[] }[] = [];
  for (const c of commits) {
    const day = dayLabel(c.committedAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(c);
    else groups.push({ day, items: [c] });
  }
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.day}>
          <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-3">
            <IconCommit size={14} />
            Commits on {g.day}
          </div>
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {g.items.map((c) => (
              <div key={c.sha} className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link to={commitUrl(slug, c.sha)} className="truncate text-[13px] font-medium hover:text-accent">
                      {c.subject || '(no message)'}
                    </Link>
                    {c.releases?.map((v) => (
                      <Chip key={v} tone="accent">
                        v{v}
                      </Chip>
                    ))}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-3">
                    <Avatar name={c.authorName} size={16} />
                    <span className="text-ink-2">{c.authorName}</span> committed {timeAgo(c.committedAt)}
                  </div>
                </div>
                <Link to={commitUrl(slug, c.sha)} className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2 hover:border-line-2 hover:text-ink">
                  {c.sha.slice(0, 7)}
                </Link>
                <CopyButton value={c.sha} label="SHA" />
                <Link to={treeUrl(slug, c.sha)} className="hidden text-[11.5px] text-ink-3 hover:text-ink sm:inline">
                  Browse
                </Link>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CommitsTab() {
  const { project, repo } = useProject();
  const slug = project.slug;
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const refName = search.get('ref') || repo?.defaultBranch || 'main';
  const page = parseInt(search.get('page') ?? '1', 10) || 1;
  const log = useQuery({
    queryKey: ['commits', slug, refName, page],
    queryFn: () =>
      api<{ commits: (Commit & { releases: string[] })[]; hasMore: boolean }>(
        `/api/projects/${slug}/repo/commits${apiQuery({ ref: refName, page: String(page) })}`,
      ),
    enabled: !!repo && !repo.empty,
  });
  if (!repo) return <Loading />;
  if (repo.empty) {
    return <EmptyState icon={<IconCommit />} title="No commits yet" body="Push from GitHub Desktop or import your releases from the Code tab." />;
  }
  const go = (p: number) => navigate(`${commitsUrl(slug, refName === repo.defaultBranch ? null : refName)}${refName === repo.defaultBranch ? '?' : '&'}page=${p}`);
  return (
    <div>
      <div className="mb-4">
        <RefPicker repo={repo} value={refName} onChange={(r) => navigate(commitsUrl(slug, r === repo.defaultBranch ? null : r))} />
      </div>
      {log.isError ? (
        <p className="text-[13px] text-danger">{errMsg(log.error, 'Could not load history')}</p>
      ) : !log.data ? (
        <Loading />
      ) : (
        <>
          <CommitRows slug={slug} commits={log.data.commits} />
          <div className="mt-5 flex justify-center gap-2">
            <Button disabled={page <= 1} onClick={() => go(page - 1)}>
              Newer
            </Button>
            <Button disabled={!log.data.hasMore} onClick={() => go(page + 1)}>
              Older
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function CommitPage() {
  const { project, canUpload } = useProject();
  const slug = project.slug;
  const { sha = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: ['commit', slug, sha],
    queryFn: () => api<{ commit: Commit; files: PatchedFile[]; branches: string[] }>(`/api/projects/${slug}/repo/commits/${sha}`),
  });
  const comments = useQuery({
    queryKey: ['commit-comments', slug, sha],
    queryFn: () => api<{ comments: LineComment[] }>(`/api/projects/${slug}/repo/commits/${sha}/comments`),
  });
  const [body, setBody] = useState('');
  const post = useMutation({
    mutationFn: (input: { body: string; path?: string; line?: number; side?: string }) =>
      api(`/api/projects/${slug}/repo/commits/${sha}/comments`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['commit-comments', slug, sha] }),
    onError: (err) => toast(errMsg(err, 'Comment failed'), 'err'),
  });

  if (data.isError) {
    return <EmptyState icon={<IconCommit />} title="Commit not found" body={errMsg(data.error, '')} />;
  }
  if (!data.data) return <Loading />;
  const { commit, files, branches } = data.data;
  const body0 = commit.message.split('\n').slice(1).join('\n').trim();
  const all = comments.data?.comments ?? [];
  const general = all.filter((c) => !c.path);

  return (
    <div>
      <div className="rounded-xl border border-line bg-panel">
        <div className="px-5 py-4">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{commit.subject || '(no message)'}</h2>
          {body0 ? <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink-2">{body0}</pre> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {branches.map((b) => (
              <Chip key={b}>
                <IconBranch size={11} /> {b}
              </Chip>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel-2 px-5 py-2.5 text-[12.5px]">
          <Avatar name={commit.authorName} />
          <span className="font-medium">{commit.authorName}</span>
          <span className="text-ink-3" title={formatDate(commit.committedAt)}>
            committed {timeAgo(commit.committedAt)}
          </span>
          <div className="flex-1" />
          {commit.parents.map((p) => (
            <span key={p} className="text-ink-3">
              parent{' '}
              <Link to={commitUrl(slug, p)} className="font-mono text-ink-2 hover:text-accent">
                {p.slice(0, 7)}
              </Link>
            </span>
          ))}
          <span className="font-mono text-ink-2">{commit.sha}</span>
          <CopyButton value={commit.sha} label="Copy" />
        </div>
      </div>

      <div className="my-4 flex flex-wrap items-center gap-2">
        <DiffStat files={files} />
        <div className="flex-1" />
        <Button onClick={() => navigate(treeUrl(slug, commit.sha))}>Browse files</Button>
        {canUpload ? (
          <Button onClick={() => navigate(`/p/${slug}/new-release?ref=${commit.sha}`)}>
            <IconTag size={14} />
            Release this commit
          </Button>
        ) : null}
      </div>

      <DiffView
        files={files}
        comments={all}
        onComment={async (t, text) => {
          await post.mutateAsync({ body: text, path: t.path, line: t.line, side: t.side });
        }}
      />

      <div className="mt-8">
        <h3 className="mb-3 text-[15px] font-semibold">Comments</h3>
        {general.length ? <CommentThread comments={general} /> : <p className="text-[12.5px] text-ink-3">No comments on this commit yet.</p>}
        <form
          className="mt-3 space-y-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!body.trim()) return;
            post.mutate({ body }, { onSuccess: () => setBody('') });
          }}
        >
          <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Comment on this commit (markdown)" />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={post.isPending} disabled={!body.trim()}>
              Comment
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ComparePage() {
  const { project, repo, canUpload } = useProject();
  const slug = project.slug;
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const base = search.get('base') || repo?.defaultBranch || 'main';
  const head = search.get('head') || '';
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [composing, setComposing] = useState(false);

  const cmp = useQuery({
    queryKey: ['compare', slug, base, head],
    queryFn: () =>
      api<{ mergeBase: string | null; commits: Commit[]; files: PatchedFile[] }>(`/api/projects/${slug}/repo/compare${apiQuery({ base, head })}`),
    enabled: !!head,
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ number: number }>(`/api/projects/${slug}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title: title || cmp.data?.commits[0]?.subject || head, body, head, base }),
      }),
    onSuccess: (res) => navigate(`/p/${slug}/pulls/${res.number}`),
    onError: (err) => toast(errMsg(err, 'Could not open the pull request'), 'err'),
  });

  if (!repo) return <Loading />;
  const isBranch = (name: string) => repo.branches.some((b) => b.name === name);

  return (
    <div>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Compare changes</h2>
      <p className="mt-1 text-[13px] text-ink-2">Pick a branch to merge into the base. Changes are shown since they diverged.</p>
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2.5 text-[12.5px]">
        <span className="text-ink-3">base</span>
        <RefPicker repo={repo} value={base} onChange={(r) => navigate(compareUrl(slug, r, head))} />
        <span className="text-ink-3">←</span>
        <span className="text-ink-3">compare</span>
        <RefPicker repo={repo} value={head || base} onChange={(r) => navigate(compareUrl(slug, base, r))} />
      </div>

      {!head ? null : cmp.isError ? (
        <p className="mt-4 text-[13px] text-danger">{errMsg(cmp.error, 'Compare failed')}</p>
      ) : !cmp.data ? (
        <Loading />
      ) : cmp.data.commits.length === 0 ? (
        <EmptyState icon={<IconCommit />} title="Nothing to compare" body={`${base} already has everything in ${head}.`} />
      ) : (
        <div className="mt-4">
          {canUpload && isBranch(head) && isBranch(base) ? (
            composing ? (
              <form
                className="mb-6 space-y-2.5 rounded-xl border border-line bg-panel p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate();
                }}
              >
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={cmp.data.commits[0]?.subject || 'Title'} aria-label="Title" />
                <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe the change (markdown)" />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setComposing(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary" loading={create.isPending}>
                    <IconPullRequest size={14} />
                    Create pull request
                  </Button>
                </div>
              </form>
            ) : (
              <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent/[0.04] px-4 py-3">
                <span className="text-[13px] text-ink-2">Discuss and review these changes before merging them into {base}.</span>
                <Button variant="primary" onClick={() => setComposing(true)}>
                  <IconPullRequest size={14} />
                  Create pull request
                </Button>
              </div>
            )
          ) : null}
          <div className="mb-3 flex items-center gap-3">
            <span className="font-mono text-[12px] text-ink-2 tnum">{cmp.data.commits.length} commits</span>
            <DiffStat files={cmp.data.files} />
          </div>
          <CommitRows slug={slug} commits={cmp.data.commits} />
          <div className="mt-6">
            <DiffView files={cmp.data.files} />
          </div>
        </div>
      )}
    </div>
  );
}

export function BranchesPage() {
  const { project, repo, refetchRepo, canUpload } = useProject();
  const slug = project.slug;
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const create = useMutation({
    mutationFn: () => api(`/api/projects/${slug}/repo/branches`, { method: 'POST', body: JSON.stringify({ name, from: from || undefined }) }),
    onSuccess: () => {
      toast(`Branch ${name} created`);
      setName('');
      refetchRepo();
    },
    onError: (err) => toast(errMsg(err, 'Could not create branch'), 'err'),
  });
  const remove = useMutation({
    mutationFn: (branch: string) => api(`/api/projects/${slug}/repo/branches/${branch}`, { method: 'DELETE' }),
    onSuccess: () => refetchRepo(),
    onError: (err) => toast(errMsg(err, 'Could not delete branch'), 'err'),
  });
  if (!repo) return <Loading />;
  return (
    <div>
      <h2 className="mb-4 text-[17px] font-semibold tracking-[-0.01em]">Branches</h2>
      {canUpload && !repo.empty ? (
        <form
          className="mb-4 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="new-branch-name" className="max-w-xs font-mono" aria-label="Branch name" required />
          <span className="text-[12px] text-ink-3">from</span>
          <RefPicker repo={repo} value={from || repo.defaultBranch} onChange={setFrom} />
          <Button type="submit" loading={create.isPending}>
            <IconBranch size={14} />
            Create branch
          </Button>
        </form>
      ) : null}
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {repo.branches.map((b) => (
          <div key={b.name} className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
            <Link to={treeUrl(slug, b.name === repo.defaultBranch ? null : b.name)} className="font-mono text-[13px] hover:text-accent">
              {b.name}
            </Link>
            {b.name === repo.defaultBranch ? <Chip tone="accent">default</Chip> : null}
            {b.name === repo.defaultBranch && repo.protectDefault ? <Chip>protected</Chip> : null}
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
              {b.commit ? `${b.commit.subject} · ${timeAgo(b.commit.committedAt)}` : ''}
            </span>
            {b.name !== repo.defaultBranch ? (
              <>
                <Button className="h-7" onClick={() => navigate(compareUrl(slug, repo.defaultBranch, b.name))}>
                  <IconPullRequest size={13} />
                  Compare
                </Button>
                {canUpload ? (
                  <Button variant="ghost" className="h-7 hover:text-danger" onClick={() => remove.mutate(b.name)} aria-label={`Delete ${b.name}`}>
                    <IconTrash size={13} />
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
