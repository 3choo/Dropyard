import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { ApiError, api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Chip, EmptyState, Input, Modal, Textarea, toast } from '../../components/ui';
import { IconFolder, IconSettings, IconTrash, IconUpload } from '../../components/icons';
import { formatBytes, timeAgo } from '../../lib/format';

type Project = {
  id: string;
  slug: string;
  name: string;
  description: string;
  updated_at: number;
};

type ReleaseRow = {
  id: string;
  version: string;
  title: string;
  status: 'draft' | 'published';
  is_latest: number;
  download_count: number;
  created_at: number;
  published_at: number | null;
  files_count: number;
  size: number;
};

export function ProjectPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const query = useQuery({
    queryKey: ['project', slug],
    queryFn: () => api<{ project: Project; releases: ReleaseRow[] }>(`/api/projects/${slug}`),
  });

  if (query.isLoading) {
    return <div className="px-8 py-10 text-[13px] text-ink-3">Loading…</div>;
  }
  if (query.isError || !query.data) {
    return (
      <div className="px-8 py-10">
        <EmptyState icon={<IconFolder />} title="Project not found" body="It may have been renamed or removed by an admin." />
      </div>
    );
  }

  const { project, releases } = query.data;
  const canUpload = user?.role === 'admin' || user?.role === 'uploader';
  const isAdmin = user?.role === 'admin';

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 md:px-8 md:py-10">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-[22px] font-semibold tracking-[-0.02em]">{project.name}</h1>
            <span className="rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink-3">
              {project.slug}
            </span>
          </div>
          {project.description ? (
            <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-ink-2">{project.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canUpload ? (
            <Button variant="primary" onClick={() => navigate(`/p/${slug}/new-release`)}>
              <IconUpload size={14} />
              New release
            </Button>
          ) : null}
          {canUpload ? (
            <Button variant="secondary" onClick={() => setSettingsOpen(true)} aria-label="Project settings">
              <IconSettings size={14} />
            </Button>
          ) : null}
          {isAdmin ? (
            <Button variant="danger" onClick={() => setDeleteOpen(true)} aria-label="Delete project">
              <IconTrash size={14} />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mb-2 mt-9 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold">Releases</h2>
        <span className="font-mono text-[11.5px] text-ink-3 tnum">
          {formatBytes(releases.reduce((s, r) => s + r.size, 0), 0)} stored
        </span>
      </div>

      {releases.length === 0 ? (
        <EmptyState
          icon={<IconUpload />}
          title="No releases yet"
          body="A release is an immutable snapshot: version, notes, files. Ship the first one and the server can pull it forever."
          action={canUpload ? (
            <Button variant="primary" onClick={() => navigate(`/p/${slug}/new-release`)}>
              <IconUpload size={14} />
              New release
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="relative ml-1 border-l border-line pl-6">
          {releases.map((r, i) => (
            <motion.div
              key={r.id}
              className="relative pb-5"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i * 0.04, 0.35), duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <span
                className={`absolute -left-[31px] top-1.5 h-2 w-2 rounded-full border-2 ${
                  r.is_latest ? 'border-accent bg-accent' : 'border-line-2 bg-ground'
                }`}
              />
              <Link
                to={`/p/${slug}/r/${r.version}`}
                className="group block rounded-xl border border-line bg-panel px-4 py-3 transition-colors hover:border-line-2 hover:bg-panel-2/60"
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[13.5px] font-medium">v{r.version}</span>
                  {r.is_latest ? <Chip tone="accent">latest</Chip> : null}
                  {r.status === 'draft' ? <Chip tone="warn">draft</Chip> : null}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{r.title || '—'}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-4 font-mono text-[11px] text-ink-3 tnum">
                  <span>{r.files_count} files</span>
                  <span>{formatBytes(r.size, 0)}</span>
                  <span>{r.download_count} downloads</span>
                  <span className="ml-auto">{timeAgo(r.published_at ?? r.created_at)}</span>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        project={project}
        onSaved={() => void query.refetch()}
      />
      <DeleteModal open={deleteOpen} onClose={() => setDeleteOpen(false)} project={project} />
    </div>
  );
}

function SettingsModal({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);

  const save = useMutation({
    mutationFn: () => api(`/api/projects/${project.slug}`, { method: 'PATCH', body: JSON.stringify({ name, description }) }),
    onSuccess: () => {
      toast('Project updated');
      onSaved();
      onClose();
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Update failed', 'err'),
  });

  return (
    <Modal open={open} onClose={onClose} title="Project settings">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3.5"
      >
        <div>
          <label className="mb-1.5 block text-[12px] text-ink-2">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} required />
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] text-ink-2">Description</label>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </div>
        <div className="flex items-center justify-between pt-1">
          <span className="font-mono text-[11px] text-ink-3">slug: {project.slug} (fixed)</span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function DeleteModal({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api(`/api/projects/${project.slug}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast(`Project “${project.name}” deleted with all its files`);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      navigate('/');
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Delete failed', 'err'),
  });

  return (
    <Modal open={open} onClose={onClose} title={`Delete ${project.name}?`}>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-2">
        This removes every release and every stored file for this project — from R2 and from the database. The
        FiveM server will lose access immediately. There is no undo.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Keep project
        </Button>
        <Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>
          <IconTrash size={14} />
          Delete everything
        </Button>
      </div>
    </Modal>
  );
}
