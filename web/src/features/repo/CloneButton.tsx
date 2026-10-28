import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button, CopyButton } from '../../components/ui';
import { IconChevronDown, IconCode } from '../../components/icons';

/** GitHub's green "Code" button: clone URL plus an Open-in-GitHub-Desktop link. */
export function CloneButton({ cloneUrl, slug }: { cloneUrl: string; slug: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button variant="primary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <IconCode size={14} />
        Clone
        <IconChevronDown size={13} />
      </Button>
      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-[22rem] rounded-xl border border-line bg-overlay p-3.5 shadow-overlay">
          <p className="mb-1.5 text-[12px] font-medium">Clone over HTTPS</p>
          <div className="flex items-center gap-1 rounded-lg border border-line bg-panel pl-2.5">
            <input
              readOnly
              value={cloneUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink focus:outline-none"
              aria-label="Clone URL"
            />
            <CopyButton value={cloneUrl} className="mr-1" />
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
            Sign in with your email as the username and a{' '}
            <Link to="/settings/tokens" className="text-ink-2 underline decoration-line-2 underline-offset-2 hover:text-ink">
              personal access token
            </Link>{' '}
            as the password.
          </p>
          <a
            href={`x-github-client://openRepo/${cloneUrl}`}
            className="mt-3 flex h-8 items-center justify-center rounded-lg border border-line bg-panel-2 text-[12.5px] text-ink transition-colors hover:border-line-2 hover:bg-panel"
          >
            Open with GitHub Desktop
          </a>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-3">
            Many GB?{' '}
            <Link
              to={`/p/${slug}/starter`}
              onClick={() => setOpen(false)}
              className="text-ink-2 underline decoration-line-2 underline-offset-2 hover:text-ink"
            >
              Use the resumable starter download
            </Link>{' '}
            for the first copy.
          </p>
        </div>
      ) : null}
    </div>
  );
}
