const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv',
  lua: 'text/plain; charset=utf-8',
  cfg: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  dds: 'image/vnd-ms.dds',
  tga: 'image/x-tga',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  wasm: 'application/wasm',
  ytd: 'application/x-gtav-ytd',
  ydr: 'application/x-gtav-ydr',
  ydd: 'application/x-gtav-ydd',
  yft: 'application/x-gtav-yft',
  ymap: 'application/x-gtav-ymap',
  ymt: 'application/x-gtav-ymt',
  ynd: 'application/x-gtav-ynd',
  ynf: 'application/x-gtav-ynf',
  ybn: 'application/x-gtav-ybn',
  ypt: 'application/x-gtav-ypt',
  awc: 'application/x-gtav-awc',
  gxt2: 'application/x-gtav-gxt2',
  meta: 'application/x-gtav-meta',
};

const EXT_RE = /\.([a-z0-9]+)$/i;

export function contentTypeForPath(path: string): string {
  const match = EXT_RE.exec(path);
  return (match && TYPES[match[1]!.toLowerCase()]) || 'application/octet-stream';
}

const TEXT_EXTS = new Set([
  'txt', 'text', 'md', 'markdown', 'log', 'csv', 'tsv',
  'lua', 'cfg', 'conf', 'ini', 'env', 'properties', 'meta', 'toml', 'yml', 'yaml', 'json', 'jsonc',
  'xml', 'html', 'htm', 'svg', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
  'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'c', 'h', 'cpp', 'hpp', 'cs', 'py', 'rb', 'go', 'java', 'rs', 'php',
  'diff', 'patch', 'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc', 'lock',
]);

export function isTextPath(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  const match = EXT_RE.exec(base);
  if (!match) return !base.includes('.'); // LICENSE, Dockerfile, .gitignore-style names
  return TEXT_EXTS.has(match[1]!.toLowerCase());
}

export const MAX_TEXT_BLOB_BYTES = 1_000_000;
