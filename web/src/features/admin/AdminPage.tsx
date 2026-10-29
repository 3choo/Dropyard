import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api, errMsg } from '../../api/client';
import { useAuth, type Role } from '../../auth/AuthProvider';
import { Button, CopyButton, Input, Modal, Select, Spinner, toast } from '../../components/ui';
import { formatDate, timeAgo } from '../../lib/format';
import { IntegrationsTab } from './IntegrationsTab';

const TABS = [
  { id: 'members', label: 'Members' },
  { id: 'invites', label: 'Invites' },
  { id: 'tokens', label: 'Deploy tokens' },
  { id: 'audit', label: 'Audit' },
  { id: 'integrations', label: 'Integrations' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function AdminPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabId | null) ?? 'members';

  if (user?.role !== 'admin') {
    return <div className="px-8 py-10 text-[13px] text-ink-2">Admin area — admins only.</div>;
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 md:px-8 md:py-10">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Admin</h1>
      <div className="mt-5 flex flex-wrap gap-1 border-b border-line pb-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              params.set('tab', t.id);
              setParams(params, { replace: true });
            }}
            className={`h-7 rounded-lg px-3 text-[12.5px] transition-colors ${
              tab === t.id ? 'bg-panel-2 text-ink' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {tab === 'members' ? <MembersTab /> : null}
        {tab === 'invites' ? <InvitesTab /> : null}
        {tab === 'tokens' ? <TokensTab /> : null}
        {tab === 'audit' ? <AuditTab /> : null}
        {tab === 'integrations' ? <IntegrationsTab /> : null}
      </div>
    </div>
  );
}

// --- Members ---------------------------------------------------------------------

type UserRow = { id: string; email: string; name: string; role: Role; created_at: number; last_login_at: number | null };

function MembersTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<{ users: UserRow[] }>('/api/admin/users') });

  const patch = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    onSuccess: () => {
      toast('Role updated');
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (e) => toast(errMsg(e), 'err'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/admin/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Member removed');
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (e) => toast(errMsg(e), 'err'),
  });

  if (q.isLoading) return <Loading />;
  return (
    <div className="border-b border-line">
      {(q.data?.users ?? []).map((u, i) => (
        <motion.div
          key={u.id}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.02, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 font-mono text-[11px] text-accent">
            {u.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">
              {u.name}
              {u.id === user?.id ? <span className="ml-1.5 text-[11px] text-ink-3">(you)</span> : null}
            </p>
            <p className="truncate text-[12px] text-ink-3">{u.email} · last seen {timeAgo(u.last_login_at)}</p>
          </div>
          <Select
            value={u.role}
            disabled={u.id === user?.id || patch.isPending}
            onChange={(e) => patch.mutate({ id: u.id, role: e.target.value as Role })}
            aria-label={`Role for ${u.name}`}
          >
            <option value="admin">admin</option>
            <option value="uploader">uploader</option>
            <option value="viewer">viewer</option>
          </Select>
          {u.id !== user?.id ? (
            <Button variant="ghost" className="h-7 text-danger" onClick={() => remove.mutate(u.id)}>
              Remove
            </Button>
          ) : null}
        </motion.div>
      ))}
    </div>
  );
}

// --- Invites -----------------------------------------------------------------------

type InviteRow = { code: string; email: string | null; role: Role; created_at: number; expires_at: number; used_at: number | null };

function InvitesTab() {
  const qc = useQueryClient();
  const [role, setRole] = useState<Role>('uploader');
  const [email, setEmail] = useState('');
  const q = useQuery({ queryKey: ['admin', 'invites'], queryFn: () => api<{ invites: InviteRow[] }>('/api/admin/invites') });

  const create = useMutation({
    mutationFn: () => api<{ code: string }>('/api/admin/invites', { method: 'POST', body: JSON.stringify({ role, email: email || undefined }) }),
    onSuccess: (res) => {
      toast('Invite created — link copied to your clipboard');
      void navigator.clipboard.writeText(`${window.location.origin}/invite/${res.code}`).catch(() => {});
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
    },
    onError: (e) => toast(errMsg(e), 'err'),
  });

  const revoke = useMutation({
    mutationFn: (code: string) => api(`/api/admin/invites/${code}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'invites'] }),
    onError: (e) => toast(errMsg(e), 'err'),
  });

  return (
    <>
      <form
        className="mb-5 flex flex-wrap items-center gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role for invite">
          <option value="uploader">uploader</option>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </Select>
        <Input
          type="email"
          placeholder="Pin to an email (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="max-w-64"
        />
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create invite
        </Button>
      </form>
      {q.isLoading ? (
        <Loading />
      ) : (
        <div className="border-b border-line">
          {(q.data?.invites ?? []).map((inv) => (
            <div key={inv.code} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[12.5px]">{inv.code.slice(0, 14)}…</p>
                <p className="text-[11.5px] text-ink-3">
                  {inv.role}
                  {inv.email ? ` · ${inv.email}` : ''}
                  {inv.used_at ? ` · used ${timeAgo(inv.used_at)}` : ` · expires ${formatDate(inv.expires_at)}`}
                </p>
              </div>
              {!inv.used_at ? (
                <>
                  <CopyButton value={`${window.location.origin}/invite/${inv.code}`} label="Link" />
                  <Button variant="ghost" className="h-7 text-danger" onClick={() => revoke.mutate(inv.code)}>
                    Revoke
                  </Button>
                </>
              ) : null}
            </div>
          ))}
          {(q.data?.invites.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-3">No invites yet.</p>
          ) : null}
        </div>
      )}
    </>
  );
}

// --- Tokens -------------------------------------------------------------------------

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  project_id: string | null;
  project_slug: string | null;
  last_used_at: number | null;
  created_at: number;
};

function TokensTab() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const tokens = useQuery({ queryKey: ['admin', 'tokens'], queryFn: () => api<{ tokens: TokenRow[] }>('/api/tokens') });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: Array<{ id: string; slug: string }> }>('/api/projects'),
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ token: string }>('/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ name, projectId: projectId || undefined }),
      }),
    onSuccess: (res) => {
      setFreshToken(res.token);
      setName('');
      void qc.invalidateQueries({ queryKey: ['admin', 'tokens'] });
    },
    onError: (e) => toast(errMsg(e), 'err'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Token revoked');
      void qc.invalidateQueries({ queryKey: ['admin', 'tokens'] });
    },
    onError: (e) => toast(errMsg(e), 'err'),
  });

  return (
    <>
      <form
        className="mb-5 flex flex-wrap items-center gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (name.trim().length >= 2) create.mutate();
        }}
      >
        <Input
          required
          minLength={2}
          placeholder="Token name (e.g. fivem-prod-1)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="max-w-56"
        />
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Token scope">
          <option value="">All projects</option>
          {(projects.data?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.slug}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create token
        </Button>
      </form>
      {tokens.isLoading ? (
        <Loading />
      ) : (
        <div className="border-b border-line">
          {(tokens.data?.tokens ?? []).map((t) => (
            <div key={t.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{t.name}</p>
                <p className="font-mono text-[11.5px] text-ink-3">
                  {t.prefix}…
                  {t.project_slug ? ` · scoped to ${t.project_slug}` : ' · all projects'} · last used{' '}
                  {t.last_used_at ? timeAgo(t.last_used_at) : 'never'}
                </p>
              </div>
              <Button variant="ghost" className="h-7 text-danger" onClick={() => revoke.mutate(t.id)}>
                Revoke
              </Button>
            </div>
          ))}
          {(tokens.data?.tokens.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-3">
              No deploy tokens. The FiveM server needs one to pull releases.
            </p>
          ) : null}
        </div>
      )}

      <Modal open={!!freshToken} onClose={() => setFreshToken(null)} title="Token created">
        <p className="mb-3 text-[13px] leading-relaxed text-ink-2">
          This is the only time the full token is shown. Treat it like a password — the FiveM server sends it with
          every pull.
        </p>
        <div className="flex items-center gap-2 rounded-xl border border-line bg-ground px-3 py-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-accent">{freshToken}</code>
          <CopyButton value={freshToken ?? ''} />
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={() => setFreshToken(null)}>
            Done
          </Button>
        </div>
      </Modal>
    </>
  );
}

// --- Audit -----------------------------------------------------------------------------

type AuditRow = { id: number; actor: string; action: string; target: string; meta: string | null; created_at: number };

function AuditTab() {
  const q = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => api<{ entries: AuditRow[] }>('/api/admin/audit') });
  if (q.isLoading) return <Loading />;
  return (
    <div className="border-b border-line">
      {(q.data?.entries ?? []).map((e) => (
        <div key={e.id} className="flex items-baseline gap-3 border-t border-line py-2 first:border-t-0">
          <span className="w-28 shrink-0 font-mono text-[11px] text-ink-3 tnum">{timeAgo(e.created_at)}</span>
          <span className="w-36 shrink-0 truncate text-[12.5px]">{e.actor}</span>
          <span className="w-36 shrink-0 truncate font-mono text-[11.5px] text-accent/80">{e.action}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{e.target}</span>
        </div>
      ))}
      {(q.data?.entries.length ?? 0) === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-3">Nothing recorded yet.</p>
      ) : null}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-10 text-ink-3">
      <Spinner className="h-4 w-4" />
    </div>
  );
}
