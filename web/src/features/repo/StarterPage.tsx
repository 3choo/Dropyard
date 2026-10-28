import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../../api/client';
import { Button, CopyButton, toast } from '../../components/ui';
import { IconArrowLeft, IconDownload } from '../../components/icons';
import { formatBytes, timeAgo } from '../../lib/format';
import { useProject } from '../project/ProjectPage';

type Starter = {
  id: string;
  status: 'building' | 'ready' | 'failed';
  head: string | null;
  refs: number;
  createdAt: number;
  files: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  size: number | null;
  error: string | null;
};

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-panel-2 font-mono text-[11px] text-ink-2">{n}</span>
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">{children}</div>
    </li>
  );
}

function Command({ value }: { value: string }) {
  return (
    <div className="mt-1.5 flex items-start gap-1 rounded-lg border border-line bg-ground pl-3">
      <pre className="min-w-0 flex-1 overflow-x-auto py-2 font-mono text-[12px] text-ink">{value}</pre>
      <CopyButton value={value} className="mr-1 mt-1" />
    </div>
  );
}

/**
 * First clone of a big repository: a git bundle the browser downloads with
 * resume, then GitHub Desktop only fetches what changed since.
 */
export function StarterPage() {
  const { project, repo } = useProject();
  const slug = project.slug;
  const q = useQuery({
    queryKey: ['starter', slug],
    queryFn: () => api<{ starter: Starter | null; head: string | null }>(`/api/projects/${slug}/repo/starter`),
  });
  const [live, setLive] = useState<Starter | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const starter = live ?? q.data?.starter ?? null;
  const stale = starter && q.data?.head && starter.head !== q.data.head;

  const drive = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      for (;;) {
        const res = await api<{ starter: Starter }>(`/api/projects/${slug}/repo/starter/step`, { method: 'POST' });
        setLive(res.starter);
        if (res.starter.status !== 'building') break;
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'A step failed — press Resume to continue', 'err');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const start = async () => {
    try {
      const res = await api<{ starter: Starter }>(`/api/projects/${slug}/repo/starter`, { method: 'POST' });
      setLive(res.starter);
      void q.refetch();
      void drive();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start', 'err');
    }
  };

  const frac = starter && starter.bytesTotal > 0 ? starter.bytesDone / starter.bytesTotal : starter?.files ? starter.filesDone / starter.files : 0;
  const cloneUrl = repo?.cloneUrl ?? '';
  const folder = slug;

  return (
    <div className="max-w-3xl">
      <Link to={`/p/${slug}`} className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink">
        <IconArrowLeft size={13} />
        Code
      </Link>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Starter download</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        A first clone of a large project is one long download, and Git cannot resume it if the connection drops. Instead,
        download the whole repository once as a single file your browser can pause and resume, then let GitHub Desktop
        fetch only what changed since.
      </p>

      <div className="mt-5 rounded-xl border border-line bg-panel p-5">
        {!starter ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-ink-2">Nothing prepared yet. Preparing reads every file once to fingerprint it; nothing is copied.</p>
            <Button variant="primary" onClick={() => void start()} disabled={!q.data}>
              Prepare download
            </Button>
          </div>
        ) : starter.status === 'ready' ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[13.5px] font-medium">
                {slug}.bundle · {formatBytes(starter.size ?? 0)}
              </p>
              <p className="mt-0.5 font-mono text-[11.5px] text-ink-3">
                {starter.head?.slice(0, 7)} · {starter.refs} refs · prepared {timeAgo(starter.createdAt)}
                {stale ? ' · newer commits will come with the first fetch' : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => void start()} loading={busy}>
                Prepare again
              </Button>
              <a
                href={`/api/projects/${slug}/repo/starter/download`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-ink hover:brightness-105"
              >
                <IconDownload size={14} />
                Download
              </a>
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-1.5 flex items-baseline justify-between font-mono text-[11.5px] text-ink-2 tnum">
              <span>
                {starter.filesDone}/{starter.files} files
              </span>
              <span>
                {formatBytes(starter.bytesDone)} / {formatBytes(starter.bytesTotal)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(2, frac * 100)}%` }} />
            </div>
            {starter.status === 'failed' ? <p className="mt-3 text-[12.5px] text-danger">{starter.error}</p> : null}
            <div className="mt-3 flex items-center gap-2">
              {starter.status === 'building' && !busy ? (
                <Button variant="primary" onClick={() => void drive()}>
                  Resume
                </Button>
              ) : null}
              {starter.status === 'failed' ? (
                <Button variant="secondary" onClick={() => void start()}>
                  Start over
                </Button>
              ) : null}
              {busy ? <span className="text-[12px] text-ink-3">Preparing — keep this tab open. You can resume later if it closes.</span> : null}
            </div>
          </div>
        )}
      </div>

      <h3 className="mt-8 text-[14px] font-semibold">Then, on your computer</h3>
      <ol className="mt-3 space-y-4">
        <Step n={1}>
          Download the file above. If the download stops, resume it from your browser's downloads list.
        </Step>
        <Step n={2}>
          Open a terminal (in GitHub Desktop: <em>Repository → Open in Command Prompt</em> works from any repo) in the folder
          that holds the downloaded file and run:
          <Command value={`git clone ${folder}.bundle ${folder}\ncd ${folder}\ngit remote set-url origin ${cloneUrl}`} />
          <p className="mt-1.5 text-[12px] text-ink-3">
            If Windows says <code className="font-mono">git</code> is not recognized, install{' '}
            <a href="https://git-scm.com/download/win" target="_blank" rel="noreferrer" className="underline decoration-line-2 underline-offset-2">
              Git for Windows
            </a>{' '}
            first.
          </p>
        </Step>
        <Step n={3}>
          In GitHub Desktop choose <em>File → Add local repository</em>, pick the new <code className="font-mono">{folder}</code> folder,
          then press <em>Fetch origin</em>. Sign in with your email and a{' '}
          <Link to="/settings/tokens" className="text-ink underline decoration-line-2 underline-offset-2">
            personal access token
          </Link>
          . Only commits made after the download are transferred.
        </Step>
      </ol>
    </div>
  );
}
