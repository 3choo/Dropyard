import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { ApiError, api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Input, Modal, Textarea, toast } from '../../components/ui';
import { IconAlert, IconArrowLeft, IconPause, IconPlay, IconUpload, IconX } from '../../components/icons';
import { formatBytes, formatThroughput, shortHash, timeAgo } from '../../lib/format';
import { ChunkMosaic } from '../upload/ChunkMosaic';
import { UploadEngine, type PickedFile, type UploadItem } from '../upload/uploader';

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader: () => { readEntries: (cb: (entries: FileSystemEntryLike[]) => void, err: (e: unknown) => void) => void };
}

async function entriesToPicked(items: DataTransferItemList): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const roots: FileSystemEntryLike[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]!.webkitGetAsEntry?.() as FileSystemEntryLike | null;
    if (entry) roots.push(entry);
  }
  const walk = async (entry: FileSystemEntryLike, dir: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)));
      if (file && file.size > 0) out.push({ file, path: dir ? `${dir}/${file.name}` : file.name });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntryLike[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (batch.length === 0) break;
        for (const child of batch) {
          await walk(child, dir ? `${dir}/${entry.name}` : entry.name);
        }
      }
    }
  };
  for (const root of roots) await walk(root, '');
  return out;
}

export function NewReleasePage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const project = useQuery({
    queryKey: ['project', slug],
    queryFn: () => api<{ project: { name: string } }>(`/api/projects/${slug}`),
  });

  // --- Phase A: draft metadata -------------------------------------------------
  const [version, setVersion] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [releaseId, setReleaseId] = useState<string | null>(null);

  const createDraft = useMutation({
    mutationFn: () =>
      api<{ release: { id: string; version: string } }>(`/api/projects/${slug}/releases`, {
        method: 'POST',
        body: JSON.stringify({ version, title, notes }),
      }),
    onSuccess: (res) => {
      setReleaseId(res.release.id);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Could not create the draft', 'err'),
  });

  if (project.isLoading) return <div className="px-8 py-10 text-[13px] text-ink-3">Loading…</div>;
  if (project.isError || user?.role === 'viewer') {
    return (
      <div className="px-8 py-10">
        <p className="text-[13px] text-ink-2">You need the uploader role to ship releases.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 md:px-8 md:py-10">
      <Link
        to={`/p/${slug}`}
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 transition-colors hover:text-ink-2"
      >
        <IconArrowLeft size={14} />
        {project.data?.project.name ?? slug}
      </Link>
      <h1 className="mb-6 text-[22px] font-semibold tracking-[-0.02em]">New release</h1>

      {releaseId === null ? (
        <DraftForm
          version={version}
          setVersion={setVersion}
          title={title}
          setTitle={setTitle}
          notes={notes}
          setNotes={setNotes}
          busy={createDraft.isPending}
          onSubmit={(e) => {
            e.preventDefault();
            createDraft.mutate();
          }}
          error={createDraft.isError ? (createDraft.error as Error).message : null}
        />
      ) : (
        <UploadPhase slug={slug} releaseId={releaseId} version={version} title={title} notes={notes} />
      )}
    </div>
  );
}

function DraftForm({
  version,
  setVersion,
  title,
  setTitle,
  notes,
  setNotes,
  busy,
  onSubmit,
  error,
}: {
  version: string;
  setVersion: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  busy: boolean;
  onSubmit: (e: FormEvent) => void;
  error: string | null;
}) {
  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-4">
      <div>
        <label className="mb-1.5 block text-[12px] text-ink-2">Version</label>
        <div className="flex h-8 items-center rounded-lg border border-line bg-panel transition-colors focus-within:border-accent/60">
          <span className="pl-2.5 font-mono text-[13px] text-ink-3">v</span>
          <input
            required
            pattern="[vV]?[0-9]+(\.[0-9]+){0,3}(-[A-Za-z0-9.]+)?"
            title="Like 1.2.3 or 1.2.3-beta"
            placeholder="1.0.0"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            className="h-full w-full bg-transparent px-1.5 font-mono text-[13px] text-ink placeholder:text-ink-3 focus:outline-none"
          />
        </div>
        <p className="mt-1.5 text-[11.5px] text-ink-3">Like 1.2.3 or 1.2.3-beta. Immutable once published.</p>
      </div>
      <div>
        <label className="mb-1.5 block text-[12px] text-ink-2">Title</label>
        <Input maxLength={200} placeholder="Nightcity traffic fix + new PD interior" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="mb-1.5 block text-[12px] text-ink-2">Release notes (markdown)</label>
        <Textarea
          rows={7}
          maxLength={20000}
          placeholder={'### Changed\n- retuned traffic density\n\n### Added\n- PD interior by @mapper'}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="font-mono text-[12.5px]"
        />
      </div>
      {error ? (
        <p className="rounded-lg border border-danger/30 bg-danger-dim/60 px-3 py-2 text-[12.5px] text-danger">{error}</p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" loading={busy}>
          Create draft &amp; add files
        </Button>
      </div>
    </form>
  );
}

function UploadPhase({
  slug,
  releaseId,
  version,
  title,
  notes,
}: {
  slug: string;
  releaseId: string;
  version: string;
  title: string;
  notes: string;
}) {
  const navigate = useNavigate();
  const engine = useMemo(() => new UploadEngine(releaseId), [releaseId]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [resumable, setResumable] = useState(0);
  const [discardOpen, setDiscardOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => engine.subscribe(setItems), [engine]);

  useEffect(() => {
    void engine.loadPersisted().then((n) => setResumable(n));
  }, [engine]);

  const addPicked = useCallback(
    (picked: PickedFile[]) => {
      if (picked.length === 0) return;
      engine.addFiles(picked);
      setResumable(0);
    },
    [engine],
  );

  const publish = useMutation({
    mutationFn: () => api(`/api/projects/${slug}/releases/${version}/publish`, { method: 'POST' }),
    onSuccess: () => {
      toast(`v${version} published — the server can pull it now`);
      navigate(`/p/${slug}/r/${version}`);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Publish failed', 'err'),
  });

  const discard = useMutation({
    mutationFn: () => api(`/api/projects/${slug}/releases/${version}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Draft discarded');
      navigate(`/p/${slug}`);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Could not discard', 'err'),
  });

  const busy = engine.busy;
  const doneCount = items.filter((i) => i.status === 'done').length;
  const pausedCount = items.filter((i) => i.status === 'paused' || i.status === 'error').length;
  const anyError = items.find((i) => i.status === 'error');
  const canPublish = doneCount > 0 && !busy && !anyError;

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_280px]">
      <div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragOver(false);
            const picked = await entriesToPicked(e.dataTransfer.items);
            addPicked(picked);
          }}
          className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 transition-colors ${
            dragOver ? 'border-accent/70 bg-accent/5' : 'border-line-2 bg-panel/50'
          }`}
        >
          <motion.div
            animate={dragOver ? { scale: 1.06 } : { scale: 1 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-panel-2 text-accent"
          >
            <IconUpload size={20} />
          </motion.div>
          <p className="text-[14px] font-medium">Drop files or whole folders here</p>
          <p className="mb-4 mt-1 text-[12.5px] text-ink-2">Multi-GB uploads are resumable — close the tab and come back.</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => fileInput.current?.click()}>
              Browse files
            </Button>
            <Button variant="secondary" onClick={() => folderInput.current?.click()}>
              Browse folder
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].map((f) => ({ file: f, path: f.name }));
              addPicked(files);
              e.target.value = '';
            }}
          />
          <input
            ref={(el) => {
              folderInput.current = el;
              if (el) {
                el.setAttribute('webkitdirectory', '');
                el.setAttribute('directory', '');
              }
            }}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].map((f) => ({
                file: f,
                path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
              }));
              addPicked(files);
              e.target.value = '';
            }}
          />
        </div>

        {resumable > 0 ? (
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
            <IconAlert size={15} className="shrink-0 text-warn" />
            <p className="flex-1 text-[12.5px] text-ink-2">
              {resumable} interrupted upload{resumable > 1 ? 's' : ''} from a previous session — parts already on
              R2 are kept.
            </p>
            <Button variant="secondary" onClick={() => engine.resumeAll()}>
              <IconPlay size={13} />
              Resume all
            </Button>
          </div>
        ) : null}

        <div className="mt-5 space-y-2.5">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <UploadRow key={item.id} item={item} engine={engine} />
            ))}
          </AnimatePresence>
        </div>
      </div>

      <aside className="h-fit rounded-2xl border border-line bg-panel p-4 lg:sticky lg:top-6">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[15px] font-semibold">v{version}</span>
        </div>
        {title ? <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{title}</p> : null}
        <dl className="mt-4 space-y-2 border-t border-line pt-4 font-mono text-[11.5px] tnum">
          <div className="flex justify-between">
            <dt className="text-ink-3">Files done</dt>
            <dd>
              {doneCount}/{items.length}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-3">Bytes landed</dt>
            <dd>{formatBytes(items.reduce((s, i) => s + i.uploadedBytes, 0))}</dd>
          </div>
          {pausedCount > 0 ? (
            <div className="flex justify-between">
              <dt className="text-ink-3">Paused / failed</dt>
              <dd className="text-warn">{pausedCount}</dd>
            </div>
          ) : null}
        </dl>
        {notes ? (
          <p className="mt-4 line-clamp-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-ink-3">{notes}</p>
        ) : null}
        <div className="mt-5 space-y-2">
          <Button
            variant="primary"
            className="h-9 w-full"
            disabled={!canPublish}
            loading={publish.isPending}
            onClick={() => publish.mutate()}
          >
            {busy ? 'Uploading…' : `Publish v${version}`}
          </Button>
          <Button variant="ghost" className="h-8 w-full" onClick={() => setDiscardOpen(true)}>
            Discard draft
          </Button>
        </div>
      </aside>

      <Modal open={discardOpen} onClose={() => setDiscardOpen(false)} title="Discard this draft?">
        <p className="mb-4 text-[13px] leading-relaxed text-ink-2">
          Uploaded parts are removed from R2 and the draft disappears. This does not affect any published
          release.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDiscardOpen(false)}>
            Keep draft
          </Button>
          <Button variant="danger" loading={discard.isPending} onClick={() => discard.mutate()}>
            Discard
          </Button>
        </div>
      </Modal>
    </div>
  );
}

const STATUS_LABEL: Record<UploadItem['status'], string> = {
  queued: 'queued',
  starting: 'starting',
  active: 'uploading',
  paused: 'paused',
  completing: 'assembling',
  done: 'complete',
  error: 'failed',
};

function UploadRow({ item, engine }: { item: UploadItem; engine: UploadEngine }) {
  const pct = item.size > 0 ? Math.min(100, Math.round((item.uploadedBytes / item.size) * 100)) : 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={`rounded-xl border bg-panel px-4 py-3 ${
        item.status === 'error' ? 'border-danger/40' : item.status === 'done' ? 'border-accent/25' : 'border-line'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-panel-2 font-mono text-[10px] text-ink-3">
          {String(item.totalParts > 1 ? item.totalParts : 1).padStart(2, '0')}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[12.5px]" title={item.path}>
            {item.path}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-3 tnum">
            {formatBytes(item.uploadedBytes)} / {formatBytes(item.size)} · {pct}%
            {item.status === 'active' ? ` · ${formatThroughput(item.bps)}` : ''}
            {item.status === 'done' && item.digest ? ` · ${shortHash(item.digest, 8)}` : ''}
          </p>
        </div>
        <span
          className={`shrink-0 font-mono text-[11px] ${
            item.status === 'done'
              ? 'text-accent'
              : item.status === 'error'
                ? 'text-danger'
                : item.status === 'active' || item.status === 'completing'
                  ? 'text-ink-2'
                  : 'text-ink-3'
          }`}
        >
          {STATUS_LABEL[item.status]}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {['paused', 'error'].includes(item.status) ? (
            <button
              onClick={() => engine.resume(item.id)}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-panel-2 hover:text-accent"
              aria-label="Resume upload"
              title="Resume"
            >
              <IconPlay size={14} />
            </button>
          ) : null}
          {['queued', 'starting', 'active'].includes(item.status) ? (
            <button
              onClick={() => engine.pause(item.id)}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
              aria-label="Pause upload"
              title="Pause"
            >
              <IconPause size={14} />
            </button>
          ) : null}
          {item.status !== 'done' ? (
            <button
              onClick={() => void engine.remove(item.id)}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-panel-2 hover:text-danger"
              aria-label="Remove upload"
              title="Remove"
            >
              <IconX size={14} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-2.5">
        <ChunkMosaic states={item.partStates} done={item.status === 'done'} />
      </div>

      {item.status === 'error' && item.error ? (
        <p className="mt-2 rounded-lg border border-danger/30 bg-danger-dim/50 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-danger">
          {item.error} — resume to retry from where it stopped.
        </p>
      ) : null}
      {item.status === 'paused' ? (
        <p className="mt-1.5 font-mono text-[11px] text-ink-3">paused {timeAgo(item.addedAt)} · parts kept on R2</p>
      ) : null}
    </motion.div>
  );
}
