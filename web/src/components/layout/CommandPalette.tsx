import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { IconPlus, IconSearch, IconUpload, IconUsers } from '../icons';

type ProjectSummary = { id: string; slug: string; name: string; latest_version: string | null };
type Action = { id: string; label: string; hint: string; to: string; adminOnly?: boolean };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: ProjectSummary[] }>('/api/projects'),
    enabled: open,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const actions: Action[] = useMemo(() => {
    const list: Action[] = [
      { id: 'new-project', label: 'Create a new project', hint: 'Action', to: '/?new=1' },
      { id: 'invite', label: 'Invite a teammate', hint: 'Action', to: '/admin?tab=invites', adminOnly: true },
    ];
    for (const p of data?.projects ?? []) {
      list.push({ id: `go-${p.slug}`, label: p.name, hint: p.slug, to: `/p/${p.slug}` });
      list.push({
        id: `release-${p.slug}`,
        label: `New release · ${p.name}`,
        hint: 'Upload',
        to: `/p/${p.slug}/new-release`,
      });
    }
    return list.filter((a) => !a.adminOnly || user?.role === 'admin');
  }, [data, user]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions.slice(0, 10);
    return actions
      .filter((a) => a.label.toLowerCase().includes(q) || a.hint.toLowerCase().includes(q))
      .slice(0, 10);
  }, [actions, query]);

  const run = (a: Action) => {
    setOpen(false);
    navigate(a.to);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <div className="fixed inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden />
          <motion.div
            role="dialog"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.99 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-line-2 bg-overlay/85 shadow-overlay backdrop-blur-xl"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <IconSearch size={15} className="shrink-0 text-ink-3" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCursor((c) => Math.min(c + 1, filtered.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCursor((c) => Math.max(c - 1, 0));
                  } else if (e.key === 'Enter' && filtered[cursor]) {
                    e.preventDefault();
                    run(filtered[cursor]);
                  }
                }}
                placeholder="Search projects and actions…"
                className="h-12 w-full bg-transparent text-[14px] text-ink placeholder:text-ink-3 focus:outline-none"
              />
              <kbd className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
                esc
              </kbd>
            </div>
            <div className="max-h-80 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-[13px] text-ink-3">Nothing matches “{query}”.</p>
              ) : (
                filtered.map((a, i) => (
                  <button
                    key={a.id}
                    onClick={() => run(a)}
                    onMouseEnter={() => setCursor(i)}
                    className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13px] transition-colors ${
                      i === cursor ? 'bg-accent/12 text-ink' : 'text-ink-2'
                    }`}
                  >
                    {a.hint === 'Upload' ? (
                      <IconUpload size={14} className="shrink-0 text-ink-3" />
                    ) : a.hint === 'Action' ? (
                      <IconPlus size={14} className="shrink-0 text-ink-3" />
                    ) : (
                      <IconUsers size={14} className="shrink-0 text-ink-3" />
                    )}
                    <span className="flex-1 truncate">{a.label}</span>
                    <span className="font-mono text-[11px] text-ink-3">{a.hint}</span>
                  </button>
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
