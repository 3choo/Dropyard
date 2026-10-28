const encPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const refQuery = (ref?: string | null) => (ref ? `?ref=${encodeURIComponent(ref)}` : '');

export const treeUrl = (slug: string, ref: string | null, path = '') =>
  path ? `/p/${slug}/tree/${encPath(path)}${refQuery(ref)}` : `/p/${slug}${refQuery(ref)}`;
export const blobUrl = (slug: string, ref: string | null, path: string) => `/p/${slug}/blob/${encPath(path)}${refQuery(ref)}`;
export const editUrl = (slug: string, ref: string | null, path: string) => `/p/${slug}/edit/${encPath(path)}${refQuery(ref)}`;
export const newFileUrl = (slug: string, ref: string | null, dir: string) =>
  `/p/${slug}/new${refQuery(ref)}${dir ? `${ref ? '&' : '?'}dir=${encodeURIComponent(dir)}` : ''}`;
export const commitUrl = (slug: string, sha: string) => `/p/${slug}/commit/${sha}`;
export const commitsUrl = (slug: string, ref?: string | null) => `/p/${slug}/commits${refQuery(ref)}`;
export const compareUrl = (slug: string, base: string, head: string) =>
  `/p/${slug}/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`;

export const apiQuery = (params: Record<string, string | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
};
