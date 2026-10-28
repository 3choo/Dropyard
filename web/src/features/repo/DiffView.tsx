import { Fragment, useState } from 'react';
import { Markdown } from '../../components/Markdown';
import { Button, Chip, Textarea } from '../../components/ui';
import { IconChevronDown, IconChevronRight, IconComment } from '../../components/icons';
import { formatBytes, timeAgo } from '../../lib/format';
import type { LineComment, PatchedFile } from './types';
import { Avatar } from './CodeTab';

type CommentTarget = { path: string; line: number; side: 'old' | 'new' };

export function DiffStat({ files }: { files: PatchedFile[] }) {
  const add = files.reduce((s, f) => s + f.additions, 0);
  const del = files.reduce((s, f) => s + f.deletions, 0);
  return (
    <span className="font-mono text-[12px] text-ink-2 tnum">
      {files.length} file{files.length === 1 ? '' : 's'} changed · <span className="text-accent">+{add}</span>{' '}
      <span className="text-danger">−{del}</span>
    </span>
  );
}

export function CommentThread({ comments }: { comments: LineComment[] }) {
  return (
    <div className="space-y-2">
      {comments.map((c) => (
        <div key={c.id} className="rounded-lg border border-line bg-panel px-3 py-2">
          <div className="mb-1 flex items-center gap-2 text-[12px]">
            <Avatar name={c.author?.name ?? '?'} size={18} />
            <span className="font-medium">{c.author?.name ?? 'Unknown'}</span>
            <span className="font-mono text-[11px] text-ink-3">{timeAgo(c.createdAt)}</span>
          </div>
          <div className="text-[13px]">
            <Markdown source={c.body} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Composer({ onSubmit, onCancel }: { onSubmit: (body: string) => Promise<void>; onCancel: () => void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <Textarea rows={3} autoFocus value={body} onChange={(e) => setBody(e.target.value)} placeholder="Leave a comment (markdown)" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={!body.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(body);
              setBody('');
              onCancel();
            } finally {
              setBusy(false);
            }
          }}
        >
          Comment
        </Button>
      </div>
    </div>
  );
}

function FileDiff({
  file,
  comments,
  onComment,
}: {
  file: PatchedFile;
  comments: LineComment[];
  onComment?: (target: CommentTarget, body: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const tone = file.status === 'added' ? 'accent' : file.status === 'deleted' ? 'danger' : 'neutral';
  const commentsAt = (line: number, side: 'old' | 'new') =>
    comments.filter((c) => c.path === file.path && c.line === line && (c.side ?? 'new') === side);

  return (
    <div id={`diff-${file.path}`} className="overflow-hidden rounded-xl border border-line bg-panel">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 border-b border-line bg-panel-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        {open ? <IconChevronDown size={14} className="text-ink-3" /> : <IconChevronRight size={14} className="text-ink-3" />}
        <Chip tone={tone}>{file.status}</Chip>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{file.path}</span>
        {file.hunks ? (
          <span className="font-mono text-[11.5px] tnum">
            <span className="text-accent">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
          </span>
        ) : null}
      </button>
      {open ? (
        file.hunks ? (
          file.hunks.length === 0 ? (
            <p className="px-4 py-3 text-[12.5px] text-ink-3">Empty file</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
                <tbody>
                  {file.hunks.map((h, hi) => {
                    let oldNo = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
                    let newNo = h.newLines === 0 ? h.newStart + 1 : h.newStart;
                    return (
                      <Fragment key={hi}>
                        <tr className="bg-info-dim/40 text-info/80">
                          <td colSpan={3} className="px-3 py-0.5">
                            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                          </td>
                        </tr>
                        {h.lines.map((l, li) => {
                          const o = l.t !== '+' ? oldNo++ : null;
                          const n = l.t !== '-' ? newNo++ : null;
                          const side: 'old' | 'new' = l.t === '-' ? 'old' : 'new';
                          const line = (side === 'old' ? o : n)!;
                          const here = commentsAt(line, side);
                          const composing = target && target.line === line && target.side === side;
                          const bg = l.t === '+' ? 'bg-accent/[0.07]' : l.t === '-' ? 'bg-danger/[0.08]' : '';
                          return (
                            <Fragment key={li}>
                              <tr className={`group ${bg}`}>
                                <td className="w-12 select-none border-r border-line px-2 text-right text-ink-3">{o ?? ''}</td>
                                <td className="relative w-12 select-none border-r border-line px-2 text-right text-ink-3">
                                  {onComment ? (
                                    <button
                                      onClick={() => setTarget({ path: file.path, line, side })}
                                      className="absolute -left-2.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded bg-accent text-accent-ink group-hover:flex"
                                      aria-label={`Comment on line ${line}`}
                                    >
                                      <IconComment size={10} />
                                    </button>
                                  ) : null}
                                  {n ?? ''}
                                </td>
                                <td className="whitespace-pre px-3">
                                  <span className={l.t === '+' ? 'text-accent' : l.t === '-' ? 'text-danger' : 'text-ink-3'}>{l.t}</span>
                                  <span className="text-ink"> {l.s}</span>
                                </td>
                              </tr>
                              {here.length > 0 || composing ? (
                                <tr>
                                  <td colSpan={3} className="border-y border-line bg-ground px-4 py-3 font-sans">
                                    <CommentThread comments={here} />
                                    {composing && onComment ? (
                                      <div className={here.length ? 'mt-2' : ''}>
                                        <Composer onSubmit={(body) => onComment(target!, body)} onCancel={() => setTarget(null)} />
                                      </div>
                                    ) : null}
                                  </td>
                                </tr>
                              ) : null}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <p className="px-4 py-3 text-[12.5px] text-ink-3">
            {file.skipped === 'binary'
              ? `Binary file ${file.oldSize !== null && file.newSize !== null ? `(${formatBytes(file.oldSize)} → ${formatBytes(file.newSize)})` : `(${formatBytes(file.newSize ?? file.oldSize ?? 0)})`}`
              : file.skipped === 'large'
                ? 'Diff too large to show'
                : 'Diff not loaded — too many changes in this view'}
          </p>
        )
      ) : null}
    </div>
  );
}

export function DiffView({
  files,
  comments = [],
  onComment,
}: {
  files: PatchedFile[];
  comments?: LineComment[];
  onComment?: (target: CommentTarget, body: string) => Promise<void>;
}) {
  if (files.length === 0) return <p className="py-6 text-center text-[13px] text-ink-3">No file changes.</p>;
  return (
    <div className="space-y-3">
      {files.map((f) => (
        <FileDiff key={f.path} file={f} comments={comments} onComment={onComment} />
      ))}
    </div>
  );
}
