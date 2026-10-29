import { Suspense, lazy, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../api/client';
import { Markdown } from '../../components/Markdown';
import { Button, CopyButton, EmptyState, Input, Loading, Modal, Textarea, toast } from '../../components/ui';
import { IconDownload, IconEdit, IconFile, IconTrash } from '../../components/icons';
import { formatBytes } from '../../lib/format';
import { useProject } from '../project/ProjectPage';
import { Breadcrumbs, RefPicker } from './CodeTab';
import { apiQuery, blobUrl, compareUrl, editUrl, treeUrl } from './links';

const CodeView = lazy(() => import('../file/CodeView'));
const FileEditor = lazy(() => import('../file/FileEditor'));

type BlobResponse = {
  kind: 'text' | 'binary';
  path: string;
  ref: string;
  commit: string;
  sha: string;
  size: number;
  contentType: string;
  rawUrl: string;
  content?: string;
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;

export function BlobPage() {
  const { project, repo, canUpload } = useProject();
  const slug = project.slug;
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const path = params['*'] ?? '';
  const refParam = search.get('ref');
  const refName = refParam || repo?.defaultBranch || 'main';
  const [preview, setPreview] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const blob = useQuery({
    queryKey: ['blob', slug, refName, path],
    queryFn: () => api<BlobResponse>(`/api/projects/${slug}/repo/blob${apiQuery({ ref: refName, path })}`),
    enabled: !!repo,
  });

  if (!repo) return <Loading />;
  const isBranch = repo.branches.some((b) => b.name === refName);
  const isMarkdown = /\.(md|markdown)$/i.test(path);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <RefPicker repo={repo} value={refName} onChange={(r) => navigate(blobUrl(slug, r === repo.defaultBranch ? null : r, path))} />
        <Breadcrumbs slug={slug} refName={refName} path={path} leafIsFile />
      </div>
      {blob.isError ? (
        <EmptyState
          icon={<IconFile />}
          title="File not found"
          body={errMsg(blob.error, 'It may not exist at this ref.')}
          action={<Button onClick={() => navigate(treeUrl(slug, refParam))}>Back to code</Button>}
        />
      ) : !blob.data ? (
        <Loading />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel-2 px-3.5 py-2">
            <span className="font-mono text-[11.5px] text-ink-3 tnum">
              {formatBytes(blob.data.size)} · {blob.data.sha.slice(0, 7)}
              {blob.data.kind === 'text' ? ` · ${blob.data.content!.split('\n').length} lines` : ''}
            </span>
            {isMarkdown && blob.data.kind === 'text' ? (
              <div className="flex rounded-lg border border-line p-0.5 text-[12px]">
                <button className={`rounded-md px-2 py-0.5 ${preview ? 'bg-panel text-ink' : 'text-ink-3'}`} onClick={() => setPreview(true)}>
                  Preview
                </button>
                <button className={`rounded-md px-2 py-0.5 ${!preview ? 'bg-panel text-ink' : 'text-ink-3'}`} onClick={() => setPreview(false)}>
                  Code
                </button>
              </div>
            ) : null}
            <div className="flex-1" />
            {blob.data.kind === 'text' ? <CopyButton value={blob.data.content!} label="Copy" /> : null}
            <a href={blob.data.rawUrl} className="inline-flex h-6 items-center gap-1 rounded-lg px-1.5 text-[11px] text-ink-2 hover:bg-panel hover:text-ink">
              <IconDownload size={12} /> Download
            </a>
            {canUpload && isBranch && blob.data.kind === 'text' ? (
              <Button variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => navigate(editUrl(slug, refParam, path))}>
                <IconEdit size={12} /> Edit
              </Button>
            ) : null}
            {canUpload && isBranch ? (
              <Button variant="ghost" className="h-6 px-1.5 text-[11px] hover:text-danger" onClick={() => setDeleteOpen(true)} aria-label="Delete file">
                <IconTrash size={12} />
              </Button>
            ) : null}
          </div>
          {blob.data.kind === 'text' ? (
            isMarkdown && preview ? (
              <div className="px-6 py-5">
                <Markdown source={blob.data.content!} />
              </div>
            ) : (
              <Suspense fallback={<Loading />}>
                <CodeView path={path} code={blob.data.content!} />
              </Suspense>
            )
          ) : IMAGE_RE.test(path) ? (
            <div className="flex justify-center bg-ground p-6">
              <img src={blob.data.rawUrl} alt={path} className="max-h-[60vh] max-w-full" />
            </div>
          ) : (
            <div className="px-6 py-12 text-center text-[13px] text-ink-2">
              Binary file ({formatBytes(blob.data.size)}).{' '}
              <a href={blob.data.rawUrl} className="text-accent underline-offset-2 hover:underline">
                Download it
              </a>
              .
            </div>
          )}
        </div>
      )}
      {blob.data ? (
        <DeleteFileModal open={deleteOpen} onClose={() => setDeleteOpen(false)} branch={refName} path={path} />
      ) : null}
    </div>
  );
}

function DeleteFileModal({ open, onClose, branch, path }: { open: boolean; onClose: () => void; branch: string; path: string }) {
  const { project, refetchRepo } = useProject();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [message, setMessage] = useState(`Delete ${path}`);
  const del = useMutation({
    mutationFn: () =>
      api(`/api/projects/${project.slug}/repo/contents${apiQuery({ path })}`, {
        method: 'DELETE',
        body: JSON.stringify({ branch, message }),
      }),
    onSuccess: () => {
      toast(`Deleted ${path}`);
      void qc.invalidateQueries({ queryKey: ['tree', project.slug] });
      refetchRepo();
      navigate(treeUrl(project.slug, branch, path.split('/').slice(0, -1).join('/')));
    },
    onError: (err) => toast(errMsg(err, 'Delete failed'), 'err'),
  });
  return (
    <Modal open={open} onClose={onClose} title={`Delete ${path.split('/').pop()}?`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          del.mutate();
        }}
        className="space-y-3"
      >
        <p className="text-[13px] text-ink-2">
          This commits the deletion to <span className="font-mono text-ink">{branch}</span>. Older commits keep the file.
        </p>
        <Input value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={del.isPending}>
            Commit deletion
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Edit an existing file (/edit/*) or create one (/new?dir=), then commit. */
export function EditPage({ creating = false }: { creating?: boolean }) {
  const { project, repo, refetchRepo, canUpload } = useProject();
  const slug = project.slug;
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const refParam = search.get('ref');
  const branch = refParam || repo?.defaultBranch || 'main';
  const originalPath = creating ? '' : params['*'] ?? '';
  const dir = search.get('dir') ?? '';
  const [name, setName] = useState(creating ? (dir ? `${dir}/` : '') : originalPath);
  const [pending, setPending] = useState<string | null>(null);

  const blob = useQuery({
    queryKey: ['blob', slug, branch, originalPath],
    queryFn: () => api<BlobResponse>(`/api/projects/${slug}/repo/blob${apiQuery({ ref: branch, path: originalPath })}`),
    enabled: !creating && !!repo,
  });
  const parent = repo?.branches.find((b) => b.name === branch)?.sha;

  const commit = useMutation({
    mutationFn: (input: { content: string; message: string; newBranch: string | null }) =>
      api<{ commit: string; branch: string; path: string }>(`/api/projects/${slug}/repo/contents${apiQuery({ path: name.trim() })}`, {
        method: 'PUT',
        body: JSON.stringify({
          content: input.content,
          message: input.message,
          branch,
          parent,
          previousPath: !creating && originalPath !== name.trim() ? originalPath : undefined,
          newBranch: input.newBranch ?? undefined,
        }),
      }),
    onSuccess: (res) => {
      toast(`Committed ${res.commit.slice(0, 7)} to ${res.branch}`);
      void qc.invalidateQueries({ queryKey: ['tree', slug] });
      void qc.invalidateQueries({ queryKey: ['blob', slug] });
      refetchRepo();
      if (res.branch !== branch) navigate(compareUrl(slug, branch, res.branch));
      else navigate(blobUrl(slug, refParam, res.path));
    },
    onError: (err) => toast(errMsg(err, 'Commit failed'), 'err'),
  });

  if (!canUpload) return <p className="text-[13px] text-ink-2">You need the uploader role to commit from the browser.</p>;
  if (!repo || (!creating && !blob.data)) {
    return blob.isError ? <p className="text-[13px] text-danger">This file cannot be edited.</p> : <Loading />;
  }
  if (!creating && blob.data?.kind !== 'text') return <p className="text-[13px] text-ink-2">Binary files can't be edited in the browser.</p>;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[13px]">
        <Link to={treeUrl(slug, refParam)} className="font-medium hover:text-accent">
          {slug}
        </Link>
        <span className="text-ink-3">/</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="path/to/file.lua"
          className="max-w-md font-mono"
          aria-label="File path"
          autoFocus={creating}
        />
        <span className="text-[12px] text-ink-3">
          in <span className="text-ink-2">{branch}</span>
        </span>
      </div>
      <Suspense fallback={<Loading />}>
        <FileEditor
          path={name || 'untitled.txt'}
          initialContent={creating ? '' : blob.data!.content!}
          saving={commit.isPending}
          onSave={(content) => {
            if (!name.trim() || name.trim().endsWith('/')) {
              toast('Name the file first', 'err');
              return;
            }
            setPending(content);
          }}
          onCancel={() => navigate(creating ? treeUrl(slug, refParam, dir) : blobUrl(slug, refParam, originalPath))}
        />
      </Suspense>
      <CommitModal
        open={pending !== null}
        onClose={() => setPending(null)}
        branch={branch}
        protectedBranch={repo.protectDefault && branch === repo.defaultBranch}
        defaultMessage={creating ? `Create ${name.trim()}` : `Update ${name.trim()}`}
        busy={commit.isPending}
        onCommit={(message, newBranch) => commit.mutate({ content: pending ?? '', message, newBranch })}
      />
    </div>
  );
}

function CommitModal({
  open,
  onClose,
  branch,
  protectedBranch,
  defaultMessage,
  busy,
  onCommit,
}: {
  open: boolean;
  onClose: () => void;
  branch: string;
  protectedBranch: boolean;
  defaultMessage: string;
  busy: boolean;
  onCommit: (message: string, newBranch: string | null) => void;
}) {
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'direct' | 'branch'>(protectedBranch ? 'branch' : 'direct');
  const [newBranch, setNewBranch] = useState(`patch-${Math.random().toString(36).slice(2, 7)}`);
  const effectiveMode = protectedBranch ? 'branch' : mode;
  return (
    <Modal open={open} onClose={onClose} title="Commit changes" width="max-w-lg">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const subject = summary.trim() || defaultMessage;
          onCommit(description.trim() ? `${subject}\n\n${description.trim()}` : subject, effectiveMode === 'branch' ? newBranch.trim() : null);
        }}
        className="space-y-3"
      >
        <Input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={defaultMessage} aria-label="Commit message" />
        <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Extended description (optional)" />
        <div className="space-y-2 rounded-lg border border-line bg-panel-2/50 p-3 text-[12.5px]">
          <label className={`flex items-center gap-2 ${protectedBranch ? 'opacity-50' : 'cursor-pointer'}`}>
            <input type="radio" checked={effectiveMode === 'direct'} disabled={protectedBranch} onChange={() => setMode('direct')} className="accent-[#C9F24F]" />
            Commit directly to <span className="font-mono text-ink">{branch}</span>
            {protectedBranch ? <span className="text-ink-3">(protected)</span> : null}
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" checked={effectiveMode === 'branch'} onChange={() => setMode('branch')} className="accent-[#C9F24F]" />
            Create a new branch and start a pull request
          </label>
          {effectiveMode === 'branch' ? (
            <Input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} className="font-mono" aria-label="New branch name" />
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {effectiveMode === 'branch' ? 'Commit and propose' : 'Commit changes'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
