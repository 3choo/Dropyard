import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Chip, CopyButton, EmptyState, Modal, toast } from '../../components/ui';
import { FileTree } from '../../components/FileTree';
import { Markdown } from '../../components/Markdown';
import { IconArrowLeft, IconDownload, IconFile, IconTerminal, IconTrash } from '../../components/icons';
import { formatBytes, formatDate, shortHash } from '../../lib/format';
import { pullSnippets } from '../../lib/snippets';

type Project = { id: string; slug: string; name: string; description: string };
type Release = {
  id: string;
  version: string;
  title: string;
  notes: string;
  status: 'draft' | 'published';
  is_latest: number;
  digest: string | null;
  download_count: number;
  created_at: number;
  published_at: number | null;
};
type FileRow = { id: string; path: string; size: number; digest: string | null; download_count: number };
type Extraction = {
  id: string;
  kind: 'zip' | 'rar';
  status: 'queued' | 'running' | 'done' | 'failed';
  filesAdded: number;
  bytesAdded: number;
  error: string | null;
  archives: string[];
  createdAt: number;
  finishedAt: number | null;
};

export function ReleasePage() {
  const { slug = '', version = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [snippetsOpen, setSnippetsOpen] = useState(false);

  const query = useQuery({
    queryKey: ['release', slug, version],
    queryFn: () =>
      api<{ project: Project; release: Release; files: FileRow[]; extractions?: Extraction[] }>(
        `/api/projects/${slug}/releases/${version}`,
      ),
    // Keep live while an archive is unpacking so the tree fills in as files land.
    refetchInterval: (q) =>
      (q.state.data?.extractions ?? []).some((j) => j.status === 'queued' || j.status === 'running') ? 2500 : false,
  });

  const retry = useMutation({
    mutationFn: (jobId: string) =>
      api(`/api/projects/${slug}/releases/${version}/extractions/${jobId}/retry`, { method: 'POST' }),
    onSuccess: () => {
      toast('Extraction restarted');
      void query.refetch();
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Retry failed', 'err'),
  });

  const publish = useMutation({
    mutationFn: () => api(`/api/projects/${slug}/releases/${version}/publish`, { method: 'POST' }),
    onSuccess: () => {
      toast(`v${version} published — it is now the latest release`);
      void qc.invalidateQueries({ queryKey: ['project', slug] });
      void query.refetch();
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Publish failed', 'err'),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/projects/${slug}/releases/${version}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast(`v${version} deleted`);
      void qc.invalidateQueries({ queryKey: ['project', slug] });
      navigate(`/p/${slug}`);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Delete failed', 'err'),
  });

  if (query.isLoading) return <div className="px-8 py-10 text-[13px] text-ink-3">Loading…</div>;
  if (query.isError || !query.data) {
    return (
      <div className="px-8 py-10">
        <EmptyState icon={<IconFile />} title="Release not found" body="It may have been deleted, or the version in the URL is off." />
      </div>
    );
  }

  const { project, release, files } = query.data;
  const extractions = query.data.extractions ?? [];
  const canUpload = user?.role === 'admin' || user?.role === 'uploader';
  const isAdmin = user?.role === 'admin';
  const dlHref = (path: string) => `/dl/${slug}/v/${version}?path=${encodeURIComponent(path)}`;
  const base = window.location.origin;

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 md:px-8 md:py-10">
      <Link
        to={`/p/${slug}`}
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 transition-colors hover:text-ink-2"
      >
        <IconArrowLeft size={14} />
        {project.name}
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-[22px] font-semibold tracking-[-0.01em]">v{release.version}</h1>
            {release.is_latest ? <Chip tone="accent">latest</Chip> : null}
            {release.status === 'draft' ? <Chip tone="warn">draft</Chip> : null}
          </div>
          {release.title ? <p className="mt-1 text-[14px] text-ink-2">{release.title}</p> : null}
          <p className="mt-2 font-mono text-[11.5px] text-ink-3 tnum">
            {release.status === 'published' ? `published ${formatDate(release.published_at)}` : `drafted ${formatDate(release.created_at)}`}
            {' · '}
            {files.length} files · {formatBytes(files.reduce((s, f) => s + f.size, 0))} · {release.download_count} downloads
            {release.digest ? ` · digest ${shortHash(release.digest)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {release.status === 'draft' && canUpload ? (
            <Button variant="primary" loading={publish.isPending} disabled={files.length === 0} onClick={() => publish.mutate()}>
              Publish
            </Button>
          ) : null}
          {release.status === 'published' ? (
            <>
              {files.length === 1 ? (
                <a href={dlHref(files[0]!.path)} download>
                  <Button variant="primary">
                    <IconDownload size={14} />
                    Download
                  </Button>
                </a>
              ) : null}
              <Button variant="secondary" onClick={() => setSnippetsOpen(true)}>
                <IconTerminal size={14} />
                Server pull
              </Button>
            </>
          ) : null}
          {(release.status === 'draft' && canUpload) || isAdmin ? (
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()} aria-label="Delete release">
              <IconTrash size={14} />
            </Button>
          ) : null}
        </div>
      </div>

      {release.status === 'draft' ? (
        <div className="mt-5 rounded-xl border border-warn/30 bg-warn-dim/50 px-4 py-3 text-[12.5px] leading-relaxed text-warn">
          This release is a draft — invisible to deploy tokens and the updater. Publish it once every file has
          landed; after that it is immutable.
        </div>
      ) : null}

      {extractions.length > 0 ? (
        <div className="mt-4 space-y-2">
          {extractions.map((job) => {
            const archive = job.archives[0]?.split('/').pop() ?? 'archive';
            const live = job.status === 'queued' || job.status === 'running';
            return (
              <div
                key={job.id}
                className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 text-[12.5px] ${
                  job.status === 'failed'
                    ? 'border-danger/40 bg-danger-dim/40'
                    : live
                      ? 'border-line bg-panel'
                      : 'border-accent/25 bg-panel'
                }`}
              >
                <span
                  className={`shrink-0 font-mono text-[11px] uppercase ${
                    job.status === 'failed' ? 'text-danger' : live ? 'text-ink-2' : 'text-accent'
                  }`}
                >
                  {job.status === 'queued' || job.status === 'running'
                    ? `unpacking ${job.kind}…`
                    : job.status === 'done'
                      ? `unpacked ${job.kind}`
                      : `unpack failed`}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-ink-2" title={job.error ?? archive}>
                  {job.status === 'failed' ? job.error : `${archive} → ${job.filesAdded} files · ${formatBytes(job.bytesAdded)}`}
                </span>
                {job.status === 'failed' && canUpload && release.status === 'draft' ? (
                  <Button variant="secondary" className="h-7" loading={retry.isPending && retry.variables === job.id} onClick={() => retry.mutate(job.id)}>
                    Retry
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {release.notes ? (
        <section className="mt-8">
          <h2 className="mb-3 text-[15px] font-semibold">Release notes</h2>
          <div className="rounded-xl border border-line bg-panel px-5 py-4">
            <Markdown source={release.notes} />
          </div>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="mb-3 text-[15px] font-semibold">
          Files <span className="ml-1 font-mono text-[12px] font-normal text-ink-3 tnum">{files.length}</span>
        </h2>
        <div className="rounded-xl border border-line bg-panel px-2 py-2">
          {files.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-ink-3">No files in this release yet.</p>
          ) : (
            <FileTree files={files.map((f) => ({ path: f.path, size: f.size, digest: f.digest }))} hrefFor={(f) => dlHref(f.path)} />
          )}
        </div>
      </section>

      <SnippetsModal open={snippetsOpen} onClose={() => setSnippetsOpen(false)} base={base} slug={slug} />
    </div>
  );
}

function SnippetsModal({ open, onClose, base, slug }: { open: boolean; onClose: () => void; base: string; slug: string }) {
  const snippets = pullSnippets(base, slug);
  const [active, setActive] = useState(snippets[0]!.id);
  const current = snippets.find((s) => s.id === active) ?? snippets[0]!;

  return (
    <Modal open={open} onClose={onClose} title="Server pull" width="max-w-2xl">
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-2">
        Run these on the FiveM server. Deploy tokens live under Admin → Tokens — put one in place of{' '}
        <code className="rounded border border-line bg-panel-2 px-1 font-mono text-[11px]">gctx_YOUR_DEPLOY_TOKEN</code>.
        A full updater script ships in the repo at <code className="rounded border border-line bg-panel-2 px-1 font-mono text-[11px]">scripts/updater/</code>.
      </p>
      <div className="mb-2 flex gap-1">
        {snippets.map((s) => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            className={`h-7 rounded-lg px-2.5 text-[12px] transition-colors ${
              s.id === active ? 'bg-panel-2 text-ink' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {s.label}
          </button>
        ))}
        <div className="flex-1" />
        <CopyButton value={current.code} label="Copy" />
      </div>
      <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-ground px-4 py-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
        {current.code}
      </pre>
    </Modal>
  );
}
