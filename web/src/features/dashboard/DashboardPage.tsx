import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { ApiError, api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Chip, EmptyState, Input, Modal, Textarea, toast } from '../../components/ui';
import { IconFolder, IconPlus } from '../../components/icons';
import { formatBytes, timeAgo } from '../../lib/format';

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  updated_at: number;
  latest_version: string | null;
  latest_published_at: number | null;
  release_count: number;
  storage_bytes: number;
};

type Stats = { storageBytes: number; projectCount: number; releaseCount: number; downloadCount: number };

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [newOpen, setNewOpen] = useState(params.has('new'));

  useEffect(() => {
    if (params.has('new')) {
      setNewOpen(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: ProjectRow[] }>('/api/projects'),
  });
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api<Stats>('/api/stats'),
  });

  const canUpload = user?.role === 'admin' || user?.role === 'uploader';

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 md:px-8 md:py-10">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Projects</h1>
        {canUpload ? (
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            <IconPlus size={14} />
            New project
          </Button>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-line pt-4">
        <Stat label="R2 storage" value={formatBytes(stats.data?.storageBytes ?? 0)} />
        <Stat label="Projects" value={String(stats.data?.projectCount ?? 0)} />
        <Stat label="Published releases" value={String(stats.data?.releaseCount ?? 0)} />
        <Stat label="Downloads" value={String(stats.data?.downloadCount ?? 0)} />
      </div>

      {projects.isLoading ? (
        <div className="py-16 text-center text-[13px] text-ink-3">Loading projects…</div>
      ) : (projects.data?.projects.length ?? 0) === 0 ? (
        <EmptyState
          icon={<IconFolder />}
          title="No projects yet"
          body="A project holds versioned releases of one thing — a MLO pack, a vehicle set, the whole resources folder. Create the first one and drop files into it."
          action={canUpload ? (
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              <IconPlus size={14} />
              New project
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="border-b border-line">
          {projects.data!.projects.map((p, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <Link
                to={`/p/${p.slug}`}
                className="group flex items-center gap-4 border-t border-line py-3.5 transition-colors first:border-t-0 hover:bg-panel/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <span className="truncate text-[14px] font-medium">{p.name}</span>
                    {p.latest_version ? (
                      <Chip tone="accent">v{p.latest_version}</Chip>
                    ) : (
                      <Chip>no releases</Chip>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[12.5px] text-ink-2">
                    {p.description || <span className="text-ink-3">No description</span>}
                  </p>
                </div>
                <div className="hidden shrink-0 items-center gap-5 font-mono text-[11.5px] text-ink-3 tnum sm:flex">
                  <span className="w-20 text-right">{formatBytes(p.storage_bytes, 0)}</span>
                  <span className="w-14 text-right">{p.release_count} rel</span>
                  <span className="w-16 text-right">{timeAgo(p.latest_published_at ?? p.updated_at)}</span>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      )}

      <NewProjectModal open={newOpen} onClose={() => setNewOpen(false)} onCreated={(slug) => navigate(`/p/${slug}`)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-[15px] font-medium text-ink tnum">{value}</span>
      <span className="text-[12px] text-ink-3">{label}</span>
    </div>
  );
}

function NewProjectModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api<{ project: { slug: string } }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, description }),
      }),
    onSuccess: (res) => {
      toast(`Project “${name}” created`);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      setName('');
      setDescription('');
      onClose();
      onCreated(res.project.slug);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Could not create the project', 'err'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim().length >= 2) create.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} title="New project">
      <form onSubmit={submit} className="space-y-3.5">
        <div>
          <label className="mb-1.5 block text-[12px] text-ink-2">Name</label>
          <Input
            required
            minLength={2}
            maxLength={80}
            placeholder="Nightcity MLO pack"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] text-ink-2">Description</label>
          <Textarea
            rows={3}
            maxLength={2000}
            placeholder="What lives in this project — one line is plenty."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
