import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../../api/client';
import { Button, CopyButton, EmptyState, Input, toast } from '../../components/ui';
import { IconKey, IconTrash } from '../../components/icons';
import { timeAgo } from '../../lib/format';

type Token = { id: string; name: string; prefix: string; created_at: number; last_used_at: number | null };

/** Personal access tokens: the password GitHub Desktop and git use. */
export function TokensPage() {
  const list = useQuery({ queryKey: ['me-tokens'], queryFn: () => api<{ tokens: Token[] }>('/api/me/tokens') });
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ token: string }>('/api/me/tokens', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: (res) => {
      setFresh(res.token);
      setName('');
      void list.refetch();
    },
    onError: (err) => toast(errMsg(err, 'Could not create the token'), 'err'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/me/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => void list.refetch(),
    onError: (err) => toast(errMsg(err, 'Could not revoke the token'), 'err'),
  });

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 md:px-8 md:py-10">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Access tokens</h1>
      <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-ink-2">
        GitHub Desktop and git sign in with a token instead of your password. Create one per computer, paste it as the
        password when Desktop asks, and revoke it here if that computer is lost. Tokens act with your role.
      </p>

      <form
        className="mt-6 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Desktop on my PC" className="max-w-xs" required minLength={2} maxLength={80} />
        <Button type="submit" variant="primary" loading={create.isPending}>
          <IconKey size={14} />
          Create token
        </Button>
      </form>

      {fresh ? (
        <div className="mt-4 rounded-xl border border-accent/40 bg-accent/[0.05] p-4">
          <p className="text-[13px] font-medium">Copy this token now — it will not be shown again.</p>
          <div className="mt-2 flex items-center gap-1 rounded-lg border border-line bg-ground pl-3">
            <code className="min-w-0 flex-1 truncate py-2 font-mono text-[12.5px] text-accent">{fresh}</code>
            <CopyButton value={fresh} className="mr-1" />
          </div>
        </div>
      ) : null}

      <div className="mt-6">
        {!list.data ? null : list.data.tokens.length === 0 ? (
          <EmptyState icon={<IconKey />} title="No tokens yet" body="Create one to clone and push from GitHub Desktop." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {list.data.tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
                <IconKey size={15} className="text-ink-3" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{t.name}</p>
                  <p className="font-mono text-[11px] text-ink-3">
                    {t.prefix}… · created {timeAgo(t.created_at)} · {t.last_used_at ? `last used ${timeAgo(t.last_used_at)}` : 'never used'}
                  </p>
                </div>
                <Button variant="danger" className="h-7" loading={revoke.isPending && revoke.variables === t.id} onClick={() => revoke.mutate(t.id)}>
                  <IconTrash size={13} />
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
