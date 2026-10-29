import { use } from 'react';
import { getHighlighter, langForPath } from './highlight';

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Same structure Shiki emits, for paths without a grammar. */
function plainHtml(code: string): string {
  const lines = code.split('\n').map((l) => `<span class="line">${escapeHtml(l) || ' '}</span>`);
  return `<pre><code>${lines.join('\n')}</code></pre>`;
}

export default function CodeView({ path, code }: { path: string; code: string }) {
  const highlighter = use(getHighlighter());
  const lang = langForPath(path);
  const html = lang
    ? highlighter.codeToHtml(code, { lang, theme: 'dropyard-console' })
    : plainHtml(code);
  return (
    <div className="codeview" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
