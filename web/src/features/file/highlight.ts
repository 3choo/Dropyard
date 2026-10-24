import { createHighlighter, type BundledLanguage, type Highlighter, type ThemeRegistrationRaw } from 'shiki';

/**
 * A Shiki theme authored from the gitctx design tokens: charcoal panels, ink
 * text, and the product's state palette doing syntax duty — chartreuse for
 * keywords, amber for constants, info blue for names, muted chartreuse for
 * strings. Restrained on purpose: the console stays legible, not neon.
 */
export const consoleTheme: ThemeRegistrationRaw = {
  name: 'gitctx-console',
  type: 'dark',
  colors: {
    'editor.background': '#12151A',
    'editor.foreground': '#E8EBEF',
  },
  settings: [
    { settings: { foreground: '#E8EBEF', background: '#12151A' } },
    { scope: 'comment', settings: { foreground: '#7E8896', fontStyle: 'italic' } },
    { scope: 'punctuation', settings: { foreground: '#A6B0BC' } },
    { scope: 'string', settings: { foreground: '#B8D94E' } },
    { scope: 'string.regexp', settings: { foreground: '#FFC24B' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.other'], settings: { foreground: '#FFC24B' } },
    { scope: ['keyword', 'storage.type', 'storage.modifier'], settings: { foreground: '#C9F24F' } },
    { scope: 'keyword.operator', settings: { foreground: '#A6B0BC' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call'], settings: { foreground: '#6BB0FF' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#6BB0FF' } },
    { scope: ['variable', 'variable.other'], settings: { foreground: '#E8EBEF' } },
    { scope: ['variable.language', 'support.variable', 'variable.other.property'], settings: { foreground: '#A6B0BC' } },
    { scope: 'entity.name.tag', settings: { foreground: '#C9F24F' } },
    { scope: 'entity.other.attribute-name', settings: { foreground: '#A6B0BC' } },
    { scope: ['entity.name.section', 'markup.heading'], settings: { foreground: '#C9F24F', fontStyle: 'bold' } },
    { scope: 'markup.bold', settings: { fontStyle: 'bold' } },
    { scope: 'markup.italic', settings: { fontStyle: 'italic' } },
    { scope: ['markup.inline.raw', 'markup.raw'], settings: { foreground: '#B8D94E' } },
    { scope: ['meta.link', 'string.other.link'], settings: { foreground: '#6BB0FF' } },
    { scope: 'invalid', settings: { foreground: '#FF6B5E' } },
  ],
};

const LANG_BY_EXT: Partial<Record<string, BundledLanguage>> = {
  lua: 'lua',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  ps1: 'powershell',
  psm1: 'powershell',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  diff: 'diff',
  patch: 'diff',
};

export function langForPath(path: string): BundledLanguage | null {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  return LANG_BY_EXT[ext] ?? null;
}

const LANGS = [...new Set(Object.values(LANG_BY_EXT))] as BundledLanguage[];

let highlighterPromise: Promise<Highlighter> | null = null;

/** Lazily created, process-wide highlighter (bundle arrives via dynamic import). */
export function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [consoleTheme], langs: LANGS });
  return highlighterPromise;
}
