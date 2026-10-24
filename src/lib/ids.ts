const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomId(bytes = 12): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256B64(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input as unknown as BufferSource);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `p-${randomId(4).toLowerCase()}`;
}

/** Sanitize a user-supplied release path: forward slashes, no .., no leading /. */
export function sanitizeFilePath(path: string): string | null {
  const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!cleaned || cleaned.length > 900) return null;
  if (cleaned.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return cleaned;
}

export function nowMs(): number {
  return Date.now();
}
