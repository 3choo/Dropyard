import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, jsonBody } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import {
  Button,
  Chip,
  CopyButton,
  EmptyState,
  Input,
  Modal,
  Spinner,
  Textarea,
  toast,
} from '../../components/ui';
import { FileTree } from '../../components/FileTree';
import { Markdown } from '../../components/Markdown';
import { IconArrowLeft, IconDownload, IconEdit, IconFile, IconLayers } from '../../components/icons';
import { formatBytes, shortHash } from '../../lib/format';

// Heavy viewers load on demand — the file page itself stays light.
const CodeView = lazy(() => import('./CodeView'));
const FileEditor = lazy(() => import('./FileEditor'));

type Project = { id: string; slug: string; name: string; description: string };
type Release = {
  id: string;
  version: string;
  status: 'draft' | 'published';
  is_latest: number;
  digest: string | null;
};
type FileRow = { id: string; path: string; size: number; digest: string | null };
type ReleaseData = { project: Project; release: Release; files: FileRow[] };
type BlobData = {
  kind: 'text' | 'binary';
  path: string;
  size: number;
  digest: string | null;
  contentType: string;
  content?: string | null;
  truncated?: boolean;
  downloadUrl?: string;
};

/** 1.2.3 → 1.2.4 · 1.2 → 1.3 · 1.2.3-beta → 1.2.4 */
function suggestVersion(v: string): string {
  const m = /^(\d+(?:\.\d+){0,3})(?:-[a-z0-9.]+)?$/i.exec(v.trim());
  if (!m) return '';
  const parts = m[1]!.split('.').map(Number);
  parts[parts.length - 1]! += 1;
  return parts.join('.');
}

function fileHref(slug: string, version: string, path: string): string {
  return `/p/${slug}/r/${version}/file/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function FilePage() {
  const { slug = '', version = '', '*': splat = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const path = splat.replace(/\/+$/, '');
  const [editing, setEditing] = useState(false);
  const [mdView, setMdView] = useState<'preview' | 'source'>('preview');
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [pendingContent, setPendingContent] = useState('');

  useEffect(() => {
    setEditing(false);
    setMdView('preview');
  }, [path]);

  const releaseQ = useQuery({
    queryKey: ['release', slug, version],
    queryFn: () => api<ReleaseData>(`/api/projects/${slug}/releases/${version}`),
  });
  const files = releaseQ.data?.files ?? [];
  const fileRow = files.find((f) => f.path === path);
  const isDir = !fileRow && files.some((f) => f.path.startsWith(`${path}/`));

  const blobQ = useQuery({
    queryKey: ['blob', slug, version, path],
    queryFn: () =>
      api<BlobData>(`/api/projects/${slug}/releases/${version}/blob?path=${encodeURIComponent(path)}`),
    enabled: !!fileRow,
  });

  const canUpload = user?.role === 'admin' || user?.role === 'uploader';
  const isDraft = releaseQ.data?.release.status === 'draft';
  const blob = blobQ.data;
  const isMarkdown = /\.(md|markdown)$/i.test(path);

  // --- mutations ---------------------------------------------------------------

  const draftSave = useMutation({
    mutationFn: (content: string) =>
      api(`/api/projects/${slug}/releases/${version}/files/content?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        body: new Blob([content], { type: 'text/plain; charset=utf-8' }),
      }),
    onSuccess: () => {
      toast('Saved to draft');
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['blob', slug, version, path] });
      void qc.invalidateQueries({ queryKey: ['release', slug, version] });
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Save failed', 'err'),
  });

  const forkSave = useMutation({
    mutationFn: (input: { version: string; title: string; notes: string; content: string }) =>
      api<{ release: { version: string } }>(`/api/projects/${slug}/releases/${version}/fork`, {
        method: 'POST',
        ...jsonBody({
          version: input.version,
          title: input.title,
          notes: input.notes,
          path,
          content: input.content,
        }),
      }),
    onSuccess: (data) => {
      const next = data.release.version;
      toast(`Saved as draft v${next} — publish it when ready`);
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['project', slug] });
      navigate(`/p/${slug}/r/${next}`);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Save failed', 'err'),
  });

  // --- render ------------------------------------------------------------------

  if (!path) return <Navigate to={`/p/${slug}/r/${version}`} replace />;

  if (releaseQ.isLoading) return <div className="px-8 py-10 text-[13px] text-ink-3">Loading…</div>;
  if (releaseQ.isError || !releaseQ.data) {
    return (
      <div className="px-8 py-10">
        <EmptyState icon={<IconFile />} title="Release not found" body="The file's release may have been deleted, or the URL is off." />
      </div>
    );
  }

  const { project, release } = releaseQ.data;
  const dlHref = `/dl/${slug}/v/${version}?path=${encodeURIComponent(path)}`;
  const segments = path.split('/');
  const dirFiles = isDir ? files.filter((f) => f.path.startsWith(`${path}/`)) : [];

  const startEdit = () => {
    if (!blob?.content) return;
    setEditing(true);
  };

  const content = blob?.content ?? '';

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 md:px-8 md:py-10">
      <Link
        to={`/p/${slug}/r/${version}`}
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 transition-colors hover:text-ink-2"
      >
        <IconArrowLeft size={14} />
        v{version}
      </Link>

      {/* Breadcrumb + actions */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <nav aria-label="File path" className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[13px]">
          <Link to={`/p/${slug}`} className="shrink-0 text-ink-2 transition-colors hover:text-ink">
            {project.name}
          </Link>
          {segments.map((seg, i) => {
            const prefix = segments.slice(0, i + 1).join('/');
            const isLast = i === segments.length - 1;
            const linked = !isLast || isDir;
            return (
              <span key={prefix} className="flex min-w-0 items-center gap-1.5">
                <span className="text-ink-3">/</span>
                {linked ? (
                  <Link to={fileHref(slug, version, prefix)} className="truncate text-ink-2 transition-colors hover:text-ink">
                    {seg}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-ink">{seg}</span>
                )}
              </span>
            );
          })}
        </nav>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {fileRow && blob?.kind === 'text' && !blob.truncated && content ? <CopyButton value={content} /> : null}
          {fileRow ? (
            <a href={dlHref} download>
              <Button variant="secondary">
                <IconDownload size={14} />
                Download
              </Button>
            </a>
          ) : null}
          {fileRow && canUpload && !editing && !(blob?.truncated ?? false) ? (
            <Button variant="primary" onClick={startEdit} disabled={!blob?.content}>
              <IconEdit size={14} />
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      {/* Meta strip */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-line py-2 font-mono text-[11.5px] text-ink-3 tnum">
        {isDir ? (
          <>
            <span className="text-ink-2">directory</span>
            <span>{dirFiles.length} files</span>
            <span>{formatBytes(dirFiles.reduce((s, f) => s + f.size, 0))}</span>
          </>
        ) : (
          <>
            {release.is_latest ? <Chip tone="accent">latest</Chip> : null}
            {isDraft ? <Chip tone="warn">draft</Chip> : null}
            <span>{formatBytes(fileRow?.size ?? 0)}</span>
            {blob?.kind === 'text' && !blob.truncated ? <span>{content.split('\n').length} lines</span> : null}
            <span>{blob?.contentType ?? '…'}</span>
            <span>{shortHash(fileRow?.digest ?? null)}</span>
          </>
        )}
      </div>

      {/* Body */}
      {isDir ? (
        <div className="mt-5 rounded-xl border border-line bg-panel px-2 py-2">
          <FileTree
            files={dirFiles}
            hrefFor={(f) => `/dl/${slug}/v/${version}?path=${encodeURIComponent(f.path)}`}
            viewHrefFor={(f) => fileHref(slug, version, f.path)}
          />
        </div>
      ) : !fileRow ? (
        <div className="mt-5">
          <EmptyState
            icon={<IconFile />}
            title="File not found"
            body={`No file or directory at this path in v${version}. Open the release to browse its files.`}
            action={
              <Link to={`/p/${slug}/r/${version}`}>
                <Button variant="secondary">Browse release</Button>
              </Link>
            }
          />
        </div>
      ) : editing && blob?.kind === 'text' && !blob.truncated ? (
        <div className="mt-5">
          <Suspense
            fallback={
              <div className="flex h-64 items-center justify-center rounded-xl border border-line bg-panel text-ink-3">
                <Spinner className="h-5 w-5" />
              </div>
            }
          >
            <FileEditor
              path={path}
              initialContent={content}
              saving={draftSave.isPending || forkSave.isPending}
              onCancel={() => setEditing(false)}
              onSave={(next) => {
                if (isDraft) draftSave.mutate(next);
                else {
                  setPendingContent(next);
                  setSaveModalOpen(true);
                }
              }}
            />
          </Suspense>
        </div>
      ) : blobQ.isLoading ? (
        <div className="mt-5 flex h-64 items-center justify-center rounded-xl border border-line bg-panel text-ink-3">
          <Spinner className="h-5 w-5" />
        </div>
      ) : blobQ.isError || !blob ? (
        <div className="mt-5">
          <EmptyState icon={<IconFile />} title="File could not be loaded" body="The stored object may be missing; contact an admin." />
        </div>
      ) : blob.kind === 'binary' ? (
        <div className="mt-5 rounded-xl border border-line bg-panel">
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-panel-2 text-ink-3">
              <IconLayers size={20} />
            </div>
            <p className="text-[14px] font-medium">Binary file</p>
            <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">
              This file can't be previewed — download it to inspect or use it with the game server.
            </p>
            <a href={dlHref} download className="mt-5">
              <Button variant="primary">
                <IconDownload size={14} />
                Download {formatBytes(blob.size)}
              </Button>
            </a>
          </div>
        </div>
      ) : blob.truncated ? (
        <div className="mt-5 rounded-xl border border-line bg-panel">
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <p className="text-[14px] font-medium">File too large to preview</p>
            <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">
              {project.name} v{version} holds this text file at {formatBytes(blob.size)} — above the 1 MB inline
              preview cap. Download it instead.
            </p>
            <a href={dlHref} download className="mt-5">
              <Button variant="primary">
                <IconDownload size={14} />
                Download
              </Button>
            </a>
          </div>
        </div>
      ) : isMarkdown ? (
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-1">
            {(['preview', 'source'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setMdView(v)}
                className={`h-7 rounded-lg px-2.5 text-[12px] capitalize transition-colors ${
                  mdView === v ? 'bg-panel-2 text-ink' : 'text-ink-3 hover:text-ink-2'
                }`}
              >
                {v}
              </button>
            ))}
            <div className="flex-1" />
            <CopyButton value={content} label="Copy source" />
          </div>
          {mdView === 'preview' ? (
            <div className="rounded-xl border border-line bg-panel px-5 py-4">
              <Markdown source={content} />
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex h-64 items-center justify-center rounded-xl border border-line bg-panel text-ink-3">
                  <Spinner className="h-5 w-5" />
                </div>
              }
            >
              <CodeView path={path} code={content} />
            </Suspense>
          )}
        </div>
      ) : (
        <div className="mt-5 overflow-hidden rounded-xl border border-line bg-panel">
          <Suspense
            fallback={
              <div className="flex h-64 items-center justify-center text-ink-3">
                <Spinner className="h-5 w-5" />
              </div>
            }
          >
            <CodeView path={path} code={content} />
          </Suspense>
        </div>
      )}

      <SaveVersionModal
        open={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        suggested={suggestVersion(release.version)}
        sourceVersion={release.version}
        saving={forkSave.isPending}
        onSave={(input) => forkSave.mutate({ ...input, content: pendingContent })}
      />
    </div>
  );
}

function SaveVersionModal({
  open,
  onClose,
  suggested,
  sourceVersion,
  saving,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  suggested: string;
  sourceVersion: string;
  saving: boolean;
  onSave: (input: { version: string; title: string; notes: string }) => void;
}) {
  const [version, setVersion] = useState(suggested);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (open) {
      setVersion(suggested);
      setTitle('');
      setNotes('');
    }
  }, [open, suggested]);

  return (
    <Modal open={open} onClose={onClose} title="Save into a new draft release">
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-2">
        Published releases are immutable. Your edit lands in a new draft release carrying every other file from
        v{sourceVersion} — publish it when you're ready.
      </p>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-mono text-[11px] uppercase text-ink-3">New version</span>
          <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder={suggested} className="font-mono" />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[11px] uppercase text-ink-3">Title (optional)</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Config tweak" />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[11px] uppercase text-ink-3">Notes (optional)</span>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="What changed?" />
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={!version.trim()}
          onClick={() => onSave({ version: version.trim(), title, notes })}
        >
          Save draft
        </Button>
      </div>
    </Modal>
  );
}
