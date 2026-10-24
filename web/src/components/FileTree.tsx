import { useMemo, useState } from 'react';
import { formatBytes } from '../lib/format';
import { IconChevronDown, IconChevronRight, IconDownload, IconFile } from './icons';

export type TreeFile = { path: string; size: number; digest: string | null };

type Node = { name: string; children: Map<string, Node> } | { name: string; file: TreeFile };

function buildTree(files: TreeFile[]): Map<string, Node> {
  const root = new Map<string, Node>();
  for (const file of files) {
    const segments = file.path.split('/');
    let level = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const isLast = i === segments.length - 1;
      if (isLast) {
        level.set(seg, { name: seg, file });
      } else {
        const existing = level.get(seg);
        if (!existing || 'file' in existing) {
          const dir: Node = { name: seg, children: new Map() };
          level.set(seg, dir);
          level = dir.children;
        } else {
          level = existing.children;
        }
      }
    }
  }
  return root;
}

function FileRow({ file, href }: { file: TreeFile; href: string }) {
  return (
    <div className="group flex h-8 items-center gap-2 rounded-lg pl-10 pr-2 hover:bg-panel-2/70">
      <IconFile size={14} className="shrink-0 text-ink-3" />
      <span className="flex-1 truncate font-mono text-[12px] text-ink">{file.path.split('/').pop()}</span>
      <span className="font-mono text-[11px] text-ink-3 tnum">{formatBytes(file.size)}</span>
      <a
        href={href}
        className="rounded-md p-1.5 text-ink-3 opacity-0 transition-opacity hover:bg-overlay hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Download ${file.path}`}
        download
      >
        <IconDownload size={14} />
      </a>
    </div>
  );
}

function DirNode({
  name,
  children,
  depth,
  hrefFor,
  defaultOpen,
}: {
  name: string;
  children: Map<string, Node>;
  depth: number;
  hrefFor: (f: TreeFile) => string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const entries = useMemo(
    () =>
      [...children.entries()].sort((a, b) => {
        const aDir = !('file' in a[1]);
        const bDir = !('file' in b[1]);
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a[0].localeCompare(b[0]);
      }),
    [children],
  );
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-2 rounded-lg pr-2 hover:bg-panel-2/70"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {open ? (
          <IconChevronDown size={13} className="shrink-0 text-ink-3" />
        ) : (
          <IconChevronRight size={13} className="shrink-0 text-ink-3" />
        )}
        <span className="truncate text-[13px] text-ink-2">{name}</span>
      </button>
      {open
        ? entries.map(([childName, node]) =>
            'file' in node ? (
              <div key={childName} style={{ paddingLeft: 0 }}>
                <div style={{ paddingLeft: `${depth * 20}px` }}>
                  <FileRow file={node.file} href={hrefFor(node.file)} />
                </div>
              </div>
            ) : (
              <DirNode
                key={childName}
                name={childName}
                children={node.children}
                depth={depth + 1}
                hrefFor={hrefFor}
                defaultOpen={defaultOpen}
              />
            ),
          )
        : null}
    </div>
  );
}

export function FileTree({ files, hrefFor }: { files: TreeFile[]; hrefFor: (f: TreeFile) => string }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const defaultOpen = files.length <= 40;
  const entries = useMemo(
    () =>
      [...tree.entries()].sort((a, b) => {
        const aDir = !('file' in a[1]);
        const bDir = !('file' in b[1]);
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a[0].localeCompare(b[0]);
      }),
    [tree],
  );
  return (
    <div className="select-none">
      {entries.map(([name, node]) =>
        'file' in node ? (
          <FileRow key={name} file={node.file} href={hrefFor(node.file)} />
        ) : (
          <DirNode key={name} name={name} children={node.children} depth={0} hrefFor={hrefFor} defaultOpen={defaultOpen} />
        ),
      )}
    </div>
  );
}
