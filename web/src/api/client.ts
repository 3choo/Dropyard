export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof Blob) && !(init.body instanceof File)
        ? { 'content-type': 'application/json' }
        : {}),
      ...init.headers,
    },
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = data as { error?: string; message?: string } | null;
    throw new ApiError(res.status, err?.error ?? 'http_error', err?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** The server's message for an API error, else `fallback`. */
export function errMsg(e: unknown, fallback = 'Something went wrong'): string {
  return e instanceof ApiError ? e.message : fallback;
}

export const jsonBody = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
