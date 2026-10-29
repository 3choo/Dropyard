import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Markdown } from '../../components/Markdown';
import { Button, Chip, EmptyState, Input, Loading, Select, Textarea, toast } from '../../components/ui';
import { IconAlert, IconCheck, IconComment, IconIssue, IconMerge, IconPlus, IconPullRequest } from '../../components/icons';
import { formatDate, timeAgo } from '../../lib/format';
import { useProject } from '../project/ProjectPage';
import { Avatar } from '../repo/CodeTab';
import { CommitRows } from '../repo/History';
import { DiffStat, DiffView } from '../repo/DiffView';
import { compareUrl } from '../repo/links';
import type { Commit, LineComment, PatchedFile, Person } from '../repo/types';

type Kind = 'issue' | 'pull';

type IssueSummary = {
  number: number;
  kind: Kind;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  author: Person;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  headBranch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  mergeCommit: string | null;
  mergedBy: Person;
  mergedAt: number | null;
  commentCount?: number;
};

type Review = { id: string; author: Person; state: 'approved' | 'changes_requested' | 'commented'; body: string; commitSha: string; createdAt: number };
type Event = { id: string; actor: Person; kind: string; meta: Record<string, unknown> | null; createdAt: number };

type IssueDetail = {
  issue: IssueSummary;
  comments: (LineComment & { commitSha: string | null; reviewId: string | null })[];
  events: Event[];
  reviews: Review[];
  pull: null | {
    headSha: string | null;
    baseSha: string | null;
    mergeBase: string | null;
    ahead: number;
    behind: number;
    mergeable: boolean;
    conflicts: string[];
    branchMissing: boolean;
    commits: Commit[];
    approvals: number;
    changesRequested: number;
    requiresApproval: boolean;
  };
};

function StateIcon({ kind, state, size = 15 }: { kind: Kind; state: IssueSummary['state']; size?: number }) {
  if (kind === 'pull') {
    if (state === 'merged') return <IconMerge size={size} className="text-info" />;
    return <IconPullRequest size={size} className={state === 'open' ? 'text-accent' : 'text-danger'} />;
  }
  return state === 'open' ? <IconIssue size={size} className="text-accent" /> : <IconCheck size={size} className="text-ink-3" />;
}

function StateChip({ kind, state }: { kind: Kind; state: IssueSummary['state'] }) {
  const tone = state === 'open' ? 'accent' : state === 'merged' ? 'info' : 'neutral';
  return (
    <Chip tone={tone} className="h-6 px-2 text-[11.5px]">
      <StateIcon kind={kind} state={state} size={12} />
      {state === 'open' ? 'Open' : state === 'merged' ? 'Merged' : 'Closed'}
    </Chip>
  );
}

export function IssueList({ kind }: { kind: Kind }) {
  const { project, repo, canUpload } = useProject();
  const slug = project.slug;
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const state = search.get('state') === 'closed' ? 'closed' : 'open';
  const list = useQuery({
    queryKey: ['issues', slug, kind, state],
    queryFn: () => api<{ items: IssueSummary[]; open: number; closed: number }>(`/api/projects/${slug}/issues?kind=${kind}&state=${state}`),
  });
  const base = `/p/${slug}/${kind === 'pull' ? 'pulls' : 'issues'}`;
  const canCreate = kind === 'issue' || (canUpload && repo && !repo.empty);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex rounded-lg border border-line p-0.5 text-[12.5px]">
          {(['open', 'closed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSearch(s === 'open' ? {} : { state: s })}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 ${state === s ? 'bg-panel-2 text-ink' : 'text-ink-3 hover:text-ink'}`}
            >
              {s === 'open' ? 'Open' : 'Closed'}
              <span className="font-mono text-[11px] tnum">{s === 'open' ? list.data?.open ?? '' : list.data?.closed ?? ''}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {canCreate ? (
          <Button
            variant="primary"
            onClick={() => navigate(kind === 'pull' ? compareUrl(slug, repo!.defaultBranch, '') : `${base}/new`)}
          >
            <IconPlus size={14} />
            {kind === 'pull' ? 'New pull request' : 'New issue'}
          </Button>
        ) : null}
      </div>
      {!list.data ? (
        <Loading />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          icon={kind === 'pull' ? <IconPullRequest /> : <IconIssue />}
          title={state === 'open' ? `No open ${kind === 'pull' ? 'pull requests' : 'issues'}` : `Nothing ${kind === 'pull' ? 'merged or closed' : 'closed'} yet`}
          body={
            kind === 'pull'
              ? 'Push a branch from GitHub Desktop, then propose it here to review it before it lands.'
              : 'Track bugs and to-dos for this project. Viewers can file issues too.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {list.data.items.map((i) => (
            <Link
              key={i.number}
              to={`${base}/${i.number}`}
              className="flex items-start gap-3 border-b border-line px-3.5 py-3 last:border-b-0 hover:bg-panel-2/60"
            >
              <span className="mt-0.5">
                <StateIcon kind={kind} state={i.state} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium">{i.title}</p>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  #{i.number} {i.state === 'merged' ? `merged ${timeAgo(i.mergedAt)}` : `opened ${timeAgo(i.createdAt)}`} by{' '}
                  {i.author?.name ?? 'unknown'}
                  {i.kind === 'pull' ? (
                    <span className="font-mono">
                      {' '}
                      · {i.headBranch} → {i.baseBranch}
                    </span>
                  ) : null}
                </p>
              </div>
              {i.commentCount ? (
                <span className="flex items-center gap-1 font-mono text-[11.5px] text-ink-3">
                  <IconComment size={13} />
                  {i.commentCount}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewIssuePage() {
  const { project } = useProject();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ number: number }>(`/api/projects/${project.slug}/issues`, { method: 'POST', body: JSON.stringify({ title, body }) }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['issues', project.slug] });
      navigate(`/p/${project.slug}/issues/${res.number}`);
    },
    onError: (err) => toast(errMsg(err, 'Could not create the issue'), 'err'),
  });
  return (
    <form
      className="max-w-3xl space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">New issue</h2>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" required maxLength={256} autoFocus />
      <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe the problem or idea (markdown)" />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={create.isPending}>
          Submit issue
        </Button>
      </div>
    </form>
  );
}

function Card({ author, at, children, tone }: { author: Person; at: number; children: ReactNode; tone?: 'accent' | 'danger' }) {
  const border = tone === 'accent' ? 'border-accent/40' : tone === 'danger' ? 'border-danger/40' : 'border-line';
  return (
    <div className="flex gap-3">
      <span className="pt-2">
        <Avatar name={author?.name ?? '?'} size={28} />
      </span>
      <div className={`min-w-0 flex-1 overflow-hidden rounded-xl border ${border} bg-panel`}>
        <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-3.5 py-2 text-[12.5px]">
          <span className="font-medium">{author?.name ?? 'Unknown'}</span>
          <span className="text-ink-3" title={formatDate(at)}>
            {timeAgo(at)}
          </span>
        </div>
        <div className="px-4 py-3 text-[13px]">{children}</div>
      </div>
    </div>
  );
}

function EventLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 pl-1.5 text-[12.5px] text-ink-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-panel-2">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

export function IssuePage({ kind }: { kind: Kind }) {
  const { project, repo, canUpload, refetchRepo } = useProject();
  const { user } = useAuth();
  const slug = project.slug;
  const { number = '' } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'conversation' | 'commits' | 'files'>('conversation');
  const [comment, setComment] = useState('');
  const [reviewBody, setReviewBody] = useState('');
  const [reviewState, setReviewState] = useState<Review['state']>('commented');
  const [method, setMethod] = useState<'merge' | 'squash'>('merge');
  const [deleteBranch, setDeleteBranch] = useState(true);

  const detail = useQuery({
    queryKey: ['issue', slug, number],
    queryFn: () => api<IssueDetail>(`/api/projects/${slug}/issues/${number}`),
  });
  const files = useQuery({
    queryKey: ['pull-files', slug, number, detail.data?.pull?.headSha],
    queryFn: () => api<{ files: PatchedFile[]; headSha: string }>(`/api/projects/${slug}/pulls/${number}/files`),
    enabled: kind === 'pull' && !!detail.data?.pull,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['issue', slug, number] });
    void qc.invalidateQueries({ queryKey: ['issues', slug] });
  };
  const fail = (err: unknown) => toast(errMsg(err, 'Something went wrong'), 'err');

  const addComment = useMutation({
    mutationFn: (input: { body: string; path?: string; line?: number; side?: string }) =>
      api(`/api/projects/${slug}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: refresh,
    onError: fail,
  });
  const setState = useMutation({
    mutationFn: (state: 'open' | 'closed') => api(`/api/projects/${slug}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state }) }),
    onSuccess: refresh,
    onError: fail,
  });
  const review = useMutation({
    mutationFn: () => api(`/api/projects/${slug}/pulls/${number}/reviews`, { method: 'POST', body: JSON.stringify({ state: reviewState, body: reviewBody }) }),
    onSuccess: () => {
      setReviewBody('');
      toast('Review submitted');
      refresh();
    },
    onError: fail,
  });
  const merge = useMutation({
    mutationFn: (bypass: boolean) =>
      api<{ commit: string }>(`/api/projects/${slug}/pulls/${number}/merge`, {
        method: 'POST',
        body: JSON.stringify({ method, deleteBranch, bypass }),
      }),
    onSuccess: (res) => {
      toast(`Merged as ${res.commit.slice(0, 7)}`);
      refresh();
      refetchRepo();
    },
    onError: fail,
  });

  if (detail.isError) {
    return <EmptyState icon={<IconIssue />} title="Not found" body={errMsg(detail.error, '')} />;
  }
  if (!detail.data) return <Loading />;
  const { issue, comments, events, reviews, pull } = detail.data;
  const isAuthor = issue.author?.id === user?.id;
  const canManage = canUpload || isAuthor;

  type Item = { at: number; node: ReactNode };
  const timeline: Item[] = [];
  for (const c of comments) {
    if (c.reviewId) continue;
    timeline.push({
      at: c.createdAt,
      node: (
        <Card key={c.id} author={c.author} at={c.createdAt}>
          {c.path ? (
            <p className="mb-2 font-mono text-[11.5px] text-ink-3">
              {c.path}:{c.line}
            </p>
          ) : null}
          <Markdown source={c.body} />
        </Card>
      ),
    });
  }
  for (const r of reviews) {
    const label = r.state === 'approved' ? 'approved these changes' : r.state === 'changes_requested' ? 'requested changes' : 'reviewed';
    timeline.push({
      at: r.createdAt,
      node: r.body ? (
        <Card key={r.id} author={r.author} at={r.createdAt} tone={r.state === 'approved' ? 'accent' : r.state === 'changes_requested' ? 'danger' : undefined}>
          <p className="mb-2 text-[12px] text-ink-2">
            {label} at <span className="font-mono">{r.commitSha.slice(0, 7)}</span>
          </p>
          <Markdown source={r.body} />
        </Card>
      ) : (
        <EventLine key={r.id} icon={r.state === 'approved' ? <IconCheck size={12} className="text-accent" /> : <IconAlert size={12} className="text-danger" />}>
          <span className="text-ink">{r.author?.name}</span> {label} {timeAgo(r.createdAt)}
        </EventLine>
      ),
    });
  }
  for (const e of events) {
    const who = e.actor?.name ?? 'Someone';
    const text =
      e.kind === 'merged'
        ? e.meta?.external
          ? 'This pull request was merged from outside gitctx (pushed directly)'
          : `${who} merged this (${String(e.meta?.method ?? 'merge')}) as ${String(e.meta?.commit ?? '').slice(0, 7)}`
        : e.kind === 'closed'
          ? `${who} closed this`
          : e.kind === 'reopened'
            ? `${who} reopened this`
            : e.kind === 'branch_deleted'
              ? `${who} deleted the ${String(e.meta?.branch ?? '')} branch`
              : `${who} ${e.kind}`;
    timeline.push({
      at: e.createdAt,
      node: (
        <EventLine key={e.id} icon={e.kind === 'merged' ? <IconMerge size={12} className="text-info" /> : <IconIssue size={12} className="text-ink-3" />}>
          {text} · {timeAgo(e.createdAt)}
        </EventLine>
      ),
    });
  }
  timeline.sort((a, b) => a.at - b.at);

  const tabBtn = (id: typeof tab, label: string, n?: number) => (
    <button
      onClick={() => setTab(id)}
      className={`relative flex h-9 items-center gap-1.5 px-1 text-[13px] ${
        tab === id ? 'text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent' : 'text-ink-2 hover:text-ink'
      }`}
    >
      {label}
      {n !== undefined ? <span className="rounded-full bg-panel-2 px-1.5 font-mono text-[10.5px] leading-[18px] tnum">{n}</span> : null}
    </button>
  );

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-[-0.02em]">
        {issue.title} <span className="font-normal text-ink-3">#{issue.number}</span>
      </h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
        <StateChip kind={kind} state={issue.state} />
        <span>
          <span className="text-ink">{issue.author?.name ?? 'Someone'}</span>{' '}
          {kind === 'pull' ? (
            <>
              {issue.state === 'merged' ? 'merged' : 'wants to merge'} {pull?.ahead ?? pull?.commits.length ?? 0} commit
              {(pull?.ahead ?? 0) === 1 ? '' : 's'} into <Chip>{issue.baseBranch}</Chip> from <Chip>{issue.headBranch}</Chip>
            </>
          ) : (
            <>opened this {timeAgo(issue.createdAt)}</>
          )}
        </span>
      </div>

      {kind === 'pull' ? (
        <div className="mt-5 flex gap-5 border-b border-line">
          {tabBtn('conversation', 'Conversation', comments.filter((c) => !c.path).length)}
          {tabBtn('commits', 'Commits', pull?.commits.length)}
          {tabBtn('files', 'Files changed', files.data?.files.length)}
        </div>
      ) : null}

      {tab === 'commits' && pull ? (
        <div className="mt-5">
          <CommitRows slug={slug} commits={pull.commits} />
        </div>
      ) : tab === 'files' ? (
        <div className="mt-5">
          {!files.data ? (
            <Loading />
          ) : (
            <>
              <div className="mb-3">
                <DiffStat files={files.data.files} />
                <span className="ml-3 text-[12px] text-ink-3">Hover a line number and press the comment marker to leave a review comment.</span>
              </div>
              <DiffView
                files={files.data.files}
                comments={comments.filter((c) => c.path)}
                onComment={async (t, body) => {
                  await addComment.mutateAsync({ body, path: t.path, line: t.line, side: t.side });
                }}
              />
            </>
          )}
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <Card author={issue.author} at={issue.createdAt}>
            {issue.body ? <Markdown source={issue.body} /> : <p className="text-ink-3">No description provided.</p>}
          </Card>
          {timeline.map((t) => t.node)}

          {kind === 'pull' && pull ? (
            <MergeBox
              issue={issue}
              pull={pull}
              canMerge={canUpload}
              isAdmin={user?.role === 'admin'}
              method={method}
              setMethod={setMethod}
              deleteBranch={deleteBranch}
              setDeleteBranch={setDeleteBranch}
              merging={merge.isPending}
              onMerge={(bypass) => merge.mutate(bypass)}
            />
          ) : null}

          {kind === 'pull' && issue.state === 'open' ? (
            <div className="rounded-xl border border-line bg-panel p-4">
              <p className="mb-2 text-[13px] font-medium">Review</p>
              <Textarea rows={3} value={reviewBody} onChange={(e) => setReviewBody(e.target.value)} placeholder="Leave review feedback (markdown)" />
              <div className="mt-2 flex flex-wrap items-center gap-4 text-[12.5px]">
                {(
                  [
                    ['commented', 'Comment'],
                    ['approved', 'Approve'],
                    ['changes_requested', 'Request changes'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className={`flex items-center gap-1.5 ${value !== 'commented' && (isAuthor || !canUpload) ? 'opacity-40' : 'cursor-pointer'}`}>
                    <input
                      type="radio"
                      name="review"
                      checked={reviewState === value}
                      disabled={value !== 'commented' && (!canUpload || (value === 'approved' && isAuthor))}
                      onChange={() => setReviewState(value)}
                      className="accent-[#C9F24F]"
                    />
                    {label}
                  </label>
                ))}
                <div className="flex-1" />
                <Button variant="primary" loading={review.isPending} onClick={() => review.mutate()}>
                  Submit review
                </Button>
              </div>
            </div>
          ) : null}

          <form
            className="rounded-xl border border-line bg-panel p-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!comment.trim()) return;
              addComment.mutate({ body: comment }, { onSuccess: () => setComment('') });
            }}
          >
            <Textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment (markdown)" />
            <div className="mt-2 flex justify-end gap-2">
              {canManage && issue.state !== 'merged' ? (
                <Button type="button" loading={setState.isPending} onClick={() => setState.mutate(issue.state === 'open' ? 'closed' : 'open')}>
                  {issue.state === 'open' ? `Close ${kind === 'pull' ? 'pull request' : 'issue'}` : 'Reopen'}
                </Button>
              ) : null}
              <Button type="submit" variant="primary" loading={addComment.isPending} disabled={!comment.trim()}>
                Comment
              </Button>
            </div>
          </form>
          {repo && issue.state === 'merged' && issue.mergeCommit ? (
            <p className="text-[12px] text-ink-3">
              Merge commit{' '}
              <Link to={`/p/${slug}/commit/${issue.mergeCommit}`} className="font-mono text-ink-2 hover:text-accent">
                {issue.mergeCommit.slice(0, 7)}
              </Link>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MergeBox({
  issue,
  pull,
  canMerge,
  isAdmin,
  method,
  setMethod,
  deleteBranch,
  setDeleteBranch,
  merging,
  onMerge,
}: {
  issue: IssueSummary;
  pull: NonNullable<IssueDetail['pull']>;
  canMerge: boolean;
  isAdmin: boolean;
  method: 'merge' | 'squash';
  setMethod: (m: 'merge' | 'squash') => void;
  deleteBranch: boolean;
  setDeleteBranch: (v: boolean) => void;
  merging: boolean;
  onMerge: (bypass: boolean) => void;
}) {
  if (issue.state === 'merged') {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-info/40 bg-info-dim/40 px-4 py-3 text-[13px]">
        <IconMerge size={16} className="text-info" />
        Merged {issue.mergedBy ? `by ${issue.mergedBy.name} ` : ''}
        {timeAgo(issue.mergedAt)}.
      </div>
    );
  }
  if (issue.state === 'closed') {
    return <div className="rounded-xl border border-line bg-panel px-4 py-3 text-[13px] text-ink-2">Closed without merging.</div>;
  }
  const needsReview = pull.requiresApproval && (pull.approvals === 0 || pull.changesRequested > 0);
  const checks: { ok: boolean; text: string }[] = [];
  if (pull.branchMissing) checks.push({ ok: false, text: 'The head or base branch was deleted.' });
  else if (pull.ahead === 0) checks.push({ ok: false, text: 'There is nothing to merge.' });
  else if (!pull.mergeable)
    checks.push({
      ok: false,
      text: `Conflicts in ${pull.conflicts.slice(0, 4).join(', ')}${pull.conflicts.length > 4 ? '…' : ''}. In GitHub Desktop, choose Branch → Update from ${issue.baseBranch}, resolve, and push.`,
    });
  else checks.push({ ok: true, text: pull.behind > 0 ? `No conflicts with ${issue.baseBranch} (${pull.behind} commits behind; a merge commit will combine them).` : `This branch can be merged cleanly.` });
  if (pull.requiresApproval) {
    checks.push({
      ok: !needsReview,
      text: pull.changesRequested > 0 ? 'Changes were requested.' : pull.approvals > 0 ? `${pull.approvals} approving review${pull.approvals > 1 ? 's' : ''}.` : `${issue.baseBranch} is protected: one approving review is required.`,
    });
  } else if (pull.approvals > 0) {
    checks.push({ ok: true, text: `${pull.approvals} approving review${pull.approvals > 1 ? 's' : ''}.` });
  }
  const blocked = pull.branchMissing || pull.ahead === 0 || !pull.mergeable;
  return (
    <div className={`rounded-xl border bg-panel p-4 ${blocked || needsReview ? 'border-line' : 'border-accent/40'}`}>
      <div className="space-y-1.5">
        {checks.map((c, i) => (
          <p key={i} className="flex items-start gap-2 text-[13px]">
            {c.ok ? <IconCheck size={15} className="mt-0.5 shrink-0 text-accent" /> : <IconAlert size={15} className="mt-0.5 shrink-0 text-warn" />}
            <span className={c.ok ? 'text-ink' : 'text-ink-2'}>{c.text}</span>
          </p>
        ))}
      </div>
      {canMerge ? (
        <div className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-line pt-3">
          <Select value={method} onChange={(e) => setMethod(e.target.value as 'merge' | 'squash')} aria-label="Merge method">
            <option value="merge">Create a merge commit</option>
            <option value="squash">Squash and merge</option>
          </Select>
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
            <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} className="accent-[#C9F24F]" />
            Delete {issue.headBranch} after merging
          </label>
          <div className="flex-1" />
          {needsReview && isAdmin && !blocked ? (
            <Button variant="danger" loading={merging} onClick={() => onMerge(true)}>
              Merge without review
            </Button>
          ) : null}
          <Button variant="primary" loading={merging} disabled={blocked || needsReview} onClick={() => onMerge(false)}>
            <IconMerge size={14} />
            Merge pull request
          </Button>
        </div>
      ) : null}
    </div>
  );
}
