import { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { Button } from '../../components/ui';

// Same token palette as the Shiki viewer theme, expressed for Lezer.
const editorHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#C9F24F' },
  { tag: [tags.string], color: '#B8D94E' },
  { tag: [tags.number, tags.bool, tags.null], color: '#FFC24B' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#6BB0FF' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#6BB0FF' },
  { tag: tags.comment, color: '#7E8896', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.attributeName], color: '#A6B0BC' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: '#A6B0BC' },
  { tag: tags.heading, color: '#C9F24F', fontWeight: 'bold' },
  { tag: tags.link, color: '#6BB0FF' },
  { tag: tags.invalid, color: '#FF6B5E' },
]);

function langExtensionForPath(path: string): Extension {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return javascript();
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true });
    case 'json':
    case 'jsonc':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    case 'css':
      return css();
    case 'html':
    case 'htm':
      return html();
    case 'xml':
    case 'svg':
      return xml();
    case 'yml':
    case 'yaml':
      return yaml();
    case 'sql':
      return sql();
    case 'lua':
      return StreamLanguage.define(lua);
    default:
      return [];
  }
}

export default function FileEditor({
  path,
  initialContent,
  saving,
  onSave,
  onCancel,
}: {
  path: string;
  initialContent: string;
  saving: boolean;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          dropCursor(),
          history(),
          search({ top: true }),
          foldGutter(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(editorHighlight),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                saveRef.current(viewRef.current?.state.doc.toString() ?? initialContent);
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          langExtensionForPath(path),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              dirtyRef.current = true;
              setDirty(true);
            }
          }),
        ],
      }),
      parent: containerRef.current!,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once per open; content changes go through onSave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const save = () => {
    if (!viewRef.current) return;
    saveRef.current(viewRef.current.state.doc.toString());
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div ref={containerRef} className="max-h-[65vh] overflow-auto" />
      <div className="flex items-center gap-3 border-t border-line bg-panel-2 px-3 py-2">
        <span className="font-mono text-[11px] text-ink-3 tnum">
          {dirty ? 'unsaved changes' : 'no changes'} · Ctrl+S to save
        </span>
        <div className="flex-1" />
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" loading={saving} onClick={save} disabled={!dirty}>
          Save
        </Button>
      </div>
    </div>
  );
}
