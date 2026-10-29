import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, jsonBody } from '../../api/client';
import { Button, Chip, Input, Modal, Select, Spinner, toast } from '../../components/ui';
import { timeAgo } from '../../lib/format';

type Field = { key: string; label: string; type: 'text' | 'url' | 'secret'; required?: boolean; placeholder?: string; help?: string };
type TypeDef = { type: string; label: string; description: string; fields: Field[] };
type Integration = {
  id: string;
  type: string;
  name: string;
  project: { slug: string; name: string } | null;
  events: string[];
  config: Record<string, string>;
  enabled: boolean;
  lastDelivery: { ok: boolean; at: number; error: string | null } | null;
};
type Delivery = { id: number; event: string; ok: number; status: number | null; attempts: number; error: string | null; created_at: number };

const EVENT_LABELS: Record<string, string> = {
  'release.published': 'Release published',
  'release.deleted': 'Release deleted',
  push: 'Git push',
  'issue.opened': 'Issue opened',
  'pr.opened': 'Pull request opened',
  'pr.merged': 'Pull request merged',
};

export function IntegrationsTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Integration | 'new' | null>(null);
  const [history, setHistory] = useState<Integration | null>(null);

  const types = useQuery({
    queryKey: ['integrations', 'types'],
    queryFn: () => api<{ events: string[]; types: TypeDef[] }>('/api/integrations/types'),
  });
  const list = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api<{ integrations: Integration[] }>('/api/integrations'),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['integrations'] });

  const toggle = useMutation({
    mutationFn: (i: Integration) => api(`/api/integrations/${i.id}`, { method: 'PUT', ...jsonBody({ enabled: !i.enabled }) }),
    onSuccess: refresh,
    onError: (e) => toast(errMsg(e), 'err'),
  });
  const test = useMutation({
    mutationFn: (i: Integration) => api<{ ok: boolean; error: string | null }>(`/api/integrations/${i.id}/test`, { method: 'POST' }),
    onSuccess: (r) => {
      toast(r.ok ? 'Test message sent' : `Test failed: ${r.error ?? 'unknown error'}`, r.ok ? 'ok' : 'err');
      refresh();
    },
    onError: (e) => toast(errMsg(e), 'err'),
  });

  if (types.isLoading || list.isLoading) {
    return (
      <div className="flex justify-center py-10 text-ink-3">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }
  const defs = types.data?.types ?? [];
  const label = (type: string) => defs.find((d) => d.type === type)?.label ?? type;
  const items = list.data?.integrations ?? [];

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="max-w-xl text-[13px] leading-relaxed text-ink-2">
          Send events to chat, push services or your own server. Each integration picks the events it cares about and,
          optionally, one project.
        </p>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add integration
        </Button>
      </div>

      <div className="border-b border-line">
        {items.map((i) => (
          <div key={i.id} className="flex flex-wrap items-center gap-3 border-t border-line py-3 first:border-t-0">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13.5px] font-medium">{i.name}</span>
                <Chip>{label(i.type)}</Chip>
                {!i.enabled ? <Chip tone="warn">off</Chip> : null}
              </div>
              <div className="mt-1 text-[12px] text-ink-3">
                {i.project ? i.project.name : 'All projects'} ·{' '}
                {i.events.includes('*') ? 'all events' : i.events.map((e) => EVENT_LABELS[e] ?? e).join(', ')}
                {i.lastDelivery ? (
                  <>
                    {' · '}
                    <span className={i.lastDelivery.ok ? 'text-ink-3' : 'text-danger'}>
                      last {i.lastDelivery.ok ? 'delivered' : 'failed'} {timeAgo(i.lastDelivery.at)}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex gap-1.5">
              <Button variant="ghost" loading={test.isPending && test.variables?.id === i.id} onClick={() => test.mutate(i)}>
                Test
              </Button>
              <Button variant="ghost" onClick={() => setHistory(i)}>
                Deliveries
              </Button>
              <Button variant="ghost" onClick={() => toggle.mutate(i)}>
                {i.enabled ? 'Turn off' : 'Turn on'}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(i)}>
                Edit
              </Button>
            </div>
          </div>
        ))}
        {items.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">No integrations yet. Add Discord, Slack or a webhook to get started.</p>
        ) : null}
      </div>

      <EditModal
        key={editing === 'new' ? 'new' : editing?.id ?? 'closed'}
        target={editing}
        defs={defs}
        events={types.data?.events ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
      <DeliveriesModal integration={history} onClose={() => setHistory(null)} onChanged={refresh} />
    </>
  );
}

function EditModal({
  target,
  defs,
  events,
  onClose,
  onSaved,
}: {
  target: Integration | 'new' | null;
  defs: TypeDef[];
  events: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = target && target !== 'new' ? target : null;
  const [type, setType] = useState(existing?.type ?? defs[0]?.type ?? 'discord');
  const [name, setName] = useState(existing?.name ?? '');
  const [project, setProject] = useState(existing?.project?.slug ?? '');
  const [selected, setSelected] = useState<string[]>(existing ? existing.events : ['release.published']);
  const [config, setConfig] = useState<Record<string, string>>(existing?.config ?? {});
  const def = defs.find((d) => d.type === type);

  const projects = useQuery({
    queryKey: ['admin', 'projects-list'],
    queryFn: () => api<{ projects: Array<{ id: string; slug: string; name: string }> }>('/api/projects'),
    enabled: !!target,
  });

  const allEvents = selected.includes('*');
  const save = useMutation({
    mutationFn: () => {
      const payload = { name: name.trim() || undefined, events: selected, config };
      return existing
        ? api(`/api/integrations/${existing.id}`, { method: 'PUT', ...jsonBody(payload) })
        : api('/api/integrations', { method: 'POST', ...jsonBody({ ...payload, type, project: project || null }) });
    },
    onSuccess: () => {
      toast(existing ? 'Integration saved' : 'Integration added');
      onSaved();
    },
    onError: (e) => toast(errMsg(e), 'err'),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/integrations/${existing?.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Integration removed');
      onSaved();
    },
    onError: (e) => toast(errMsg(e), 'err'),
  });

  const flip = (ev: string) =>
    setSelected((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur.filter((x) => x !== '*'), ev]));

  return (
    <Modal open={!!target} onClose={onClose} title={existing ? `Edit ${existing.name}` : 'Add integration'} width="max-w-lg">
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {!existing ? (
          <Row label="Type">
            <Select
              className="w-full"
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setConfig({});
              }}
            >
              {defs.map((d) => (
                <option key={d.type} value={d.type}>
                  {d.label}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[12px] text-ink-3">{def?.description}</p>
          </Row>
        ) : null}
        <Row label="Name">
          <Input placeholder={def?.label} value={name} onChange={(e) => setName(e.target.value)} />
        </Row>
        {!existing ? (
          <Row label="Project">
            <Select className="w-full" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {(projects.data?.projects ?? []).map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Row>
        ) : null}
        {def?.fields.map((f) => (
          <Row key={f.key} label={f.label + (f.required ? '' : ' (optional)')}>
            <Input
              type={f.type === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              placeholder={f.placeholder}
              value={config[f.key] ?? ''}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
            />
            {f.help ? <p className="mt-1 text-[12px] text-ink-3">{f.help}</p> : null}
          </Row>
        ))}
        <Row label="Events">
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={allEvents} onChange={() => setSelected(allEvents ? ['release.published'] : ['*'])} />
              Everything
            </label>
            {!allEvents
              ? events.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 pl-5 text-[13px] text-ink-2">
                    <input type="checkbox" checked={selected.includes(ev)} onChange={() => flip(ev)} />
                    {EVENT_LABELS[ev] ?? ev}
                  </label>
                ))
              : null}
          </div>
        </Row>
        <div className="flex items-center justify-between pt-2">
          {existing ? (
            <Button
              type="button"
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm(`Remove "${existing.name}"? Its delivery history is deleted too.`)) remove.mutate();
              }}
            >
              Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={selected.length === 0}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-ink-2">{label}</div>
      {children}
    </div>
  );
}

function DeliveriesModal({
  integration,
  onClose,
  onChanged,
}: {
  integration: Integration | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['integrations', integration?.id, 'deliveries'],
    queryFn: () => api<{ deliveries: Delivery[] }>(`/api/integrations/${integration?.id}/deliveries`),
    enabled: !!integration,
  });
  const redeliver = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean; error: string | null }>(`/api/integrations/${integration?.id}/deliveries/${id}/redeliver`, { method: 'POST' }),
    onSuccess: (r) => {
      toast(r.ok ? 'Delivered' : `Failed again: ${r.error ?? 'unknown error'}`, r.ok ? 'ok' : 'err');
      void qc.invalidateQueries({ queryKey: ['integrations', integration?.id, 'deliveries'] });
      onChanged();
    },
    onError: (e) => toast(errMsg(e), 'err'),
  });

  return (
    <Modal open={!!integration} onClose={onClose} title={`Deliveries — ${integration?.name ?? ''}`} width="max-w-2xl">
      {q.isLoading ? (
        <div className="flex justify-center py-6 text-ink-3">
          <Spinner className="h-4 w-4" />
        </div>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto">
          {(q.data?.deliveries ?? []).map((d) => (
            <div key={d.id} className="flex items-center gap-3 border-t border-line py-2 first:border-t-0">
              <Chip tone={d.ok ? 'accent' : 'danger'}>{d.ok ? 'ok' : 'failed'}</Chip>
              <span className="w-36 shrink-0 truncate font-mono text-[11.5px] text-ink-2">{d.event}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                {timeAgo(d.created_at)}
                {d.status ? ` · HTTP ${d.status}` : ''}
                {d.attempts > 1 ? ` · ${d.attempts} attempts` : ''}
                {d.error && !d.ok ? ` · ${d.error}` : ''}
              </span>
              <Button variant="ghost" loading={redeliver.isPending && redeliver.variables === d.id} onClick={() => redeliver.mutate(d.id)}>
                Redeliver
              </Button>
            </div>
          ))}
          {(q.data?.deliveries.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-3">Nothing sent yet. Press Test to try it.</p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
