import { NavLink, Outlet, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { formatBytes } from '../../lib/format';
import { IconActivity, IconKey, IconLayers, IconLogout } from '../icons';
import { CommandPalette } from './CommandPalette';

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#C9F24F" />
        <path
          d="M9 11l6 5-6 5"
          stroke="#131608"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="17" y="19" width="7" height="3" rx="1.5" fill="#131608" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.02em]">gitctx</span>
    </div>
  );
}

function StorageMeter() {
  const { data } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api<{ storageBytes: number; releaseCount: number }>('/api/stats'),
  });
  const bytes = data?.storageBytes ?? 0;
  // Visual cap at 250 GB; the number itself always tells the truth.
  const frac = Math.min(1, bytes / (250 * 1024 ** 3));
  return (
    <div className="px-3 pb-2">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11px] text-ink-3">R2 storage</span>
        <span className="font-mono text-[11px] text-ink-2 tnum">{formatBytes(bytes)}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-panel-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${Math.max(frac * 100, bytes > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;

  const navItem = (active: boolean) =>
    `flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors ${
      active ? 'bg-panel-2 text-ink' : 'text-ink-2 hover:bg-panel-2/60 hover:text-ink'
    }`;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <header className="sticky top-0 z-40 flex h-12 w-full items-center justify-between border-b border-line bg-ground px-4 md:hidden">
        <Logo />
        <nav className="flex items-center gap-1 text-[13px]">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `rounded-lg px-2.5 py-1.5 ${isActive ? 'bg-panel-2 text-ink' : 'text-ink-2'}`
            }
          >
            Projects
          </NavLink>
          <NavLink
            to="/settings/tokens"
            className={({ isActive }) =>
              `rounded-lg px-2.5 py-1.5 ${isActive ? 'bg-panel-2 text-ink' : 'text-ink-2'}`
            }
          >
            Tokens
          </NavLink>
          {user.role === 'admin' ? (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `rounded-lg px-2.5 py-1.5 ${isActive ? 'bg-panel-2 text-ink' : 'text-ink-2'}`
              }
            >
              Admin
            </NavLink>
          ) : null}
          <button
            onClick={() => void logout()}
            className="rounded-lg px-2.5 py-1.5 text-ink-3"
            aria-label="Sign out"
          >
            <IconLogout size={14} />
          </button>
        </nav>
      </header>
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-ground md:flex">
        <div className="px-4 pb-5 pt-5">
          <Logo />
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2">
          <NavLink to="/" end className={({ isActive }) => navItem(isActive)}>
            {({ isActive }) => (
              <>
                <span className={`h-1.5 w-1.5 rounded-[2px] ${isActive ? 'bg-accent' : 'bg-line-2'}`} />
                <IconLayers size={15} className="text-ink-3" />
                Projects
              </>
            )}
          </NavLink>
          <NavLink to="/settings/tokens" className={({ isActive }) => navItem(isActive)}>
            {({ isActive }) => (
              <>
                <span className={`h-1.5 w-1.5 rounded-[2px] ${isActive ? 'bg-accent' : 'bg-line-2'}`} />
                <IconKey size={15} className="text-ink-3" />
                Access tokens
              </>
            )}
          </NavLink>
          {user.role === 'admin' ? (
            <NavLink to="/admin" className={({ isActive }) => navItem(isActive)}>
              {({ isActive }) => (
                <>
                  <span className={`h-1.5 w-1.5 rounded-[2px] ${isActive ? 'bg-accent' : 'bg-line-2'}`} />
                  <IconActivity size={15} className="text-ink-3" />
                  Admin
                </>
              )}
            </NavLink>
          ) : null}
        </nav>
        <StorageMeter />
        <div className="mx-2 mb-3 flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 font-mono text-[11px] text-accent">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[12px] font-medium">{user.name}</p>
            <p className="text-[11px] text-ink-3">{user.role}</p>
          </div>
          <button
            onClick={() => void logout().then(() => navigate('/login'))}
            className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
            aria-label="Sign out"
            title="Sign out"
          >
            <IconLogout size={14} />
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
      <CommandPalette />
    </div>
  );
}
