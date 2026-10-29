import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Bucket, getBucket, s3Config, s3ObjectUrl } from '../src/lib/storage';

const base = {
  S3_ENDPOINT: 'https://s3.example.com/',
  S3_BUCKET: 'media',
  S3_ACCESS_KEY_ID: 'AKID',
  S3_SECRET_ACCESS_KEY: 'secret',
};

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    return handler(req);
  });
  return calls;
}

describe('s3Config', () => {
  it('prefers S3_* settings and trims the endpoint', () => {
    const cfg = s3Config(base as never)!;
    expect(cfg.endpoint).toBe('https://s3.example.com');
    expect(cfg.region).toBe('auto');
    expect(cfg.pathStyle).toBe(true);
  });

  it('falls back to the legacy R2_* names', () => {
    const cfg = s3Config({
      R2_S3_ACCOUNT_ID: 'acct',
      R2_BUCKET_NAME: 'gitctx',
      R2_ACCESS_KEY_ID: 'a',
      R2_SECRET_ACCESS_KEY: 'b',
    } as never)!;
    expect(cfg.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
    expect(cfg.bucket).toBe('gitctx');
  });

  it('returns null without credentials', () => {
    expect(s3Config({ S3_ENDPOINT: 'https://x', S3_BUCKET: 'b' } as never)).toBeNull();
  });
});

describe('s3ObjectUrl', () => {
  const cfg = s3Config({ ...base, S3_REGION: 'eu-west-1' } as never)!;

  it('builds path-style URLs and encodes each key segment', () => {
    expect(s3ObjectUrl(cfg, 'p/1/a b.txt').toString()).toBe('https://s3.example.com/media/p/1/a%20b.txt');
  });

  it('builds virtual-hosted URLs', () => {
    const url = s3ObjectUrl({ ...cfg, pathStyle: false }, 'k/x', { uploads: '' });
    expect(url.toString()).toBe('https://media.s3.example.com/k/x?uploads=');
  });
});

describe('S3Bucket', () => {
  const cfg = s3Config(base as never)!;

  it('returns null for a missing object', async () => {
    stubFetch(() => new Response('', { status: 404 }));
    expect(await new S3Bucket(cfg).get('nope')).toBeNull();
    expect(await new S3Bucket(cfg).head('nope')).toBeNull();
  });

  it('sends a Range header and reads the total size from Content-Range', async () => {
    const calls = stubFetch(
      () => new Response('abc', { status: 206, headers: { 'content-range': 'bytes 2-4/100', etag: '"e"' } }),
    );
    const obj = (await new S3Bucket(cfg).get('k', { range: { offset: 2, length: 3 } }))!;
    expect(calls[0]!.headers.get('range')).toBe('bytes=2-4');
    expect(obj.size).toBe(100);
    expect(obj.httpEtag).toBe('"e"');
    expect(await obj.text()).toBe('abc');
  });

  it('buffers streams on put and signs the request', async () => {
    const calls = stubFetch(() => new Response('', { status: 200 }));
    await new S3Bucket(cfg).put('k', new Response('hello').body!, { httpMetadata: { contentType: 'text/plain' } });
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers.get('content-type')).toBe('text/plain');
    expect(calls[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(await calls[0]!.text()).toBe('hello');
  });

  it('surfaces storage errors', async () => {
    stubFetch(() => new Response('<Error>AccessDenied</Error>', { status: 403 }));
    await expect(new S3Bucket(cfg).put('k', 'x')).rejects.toThrow(/PUT k failed \(403\)/);
  });

  it('deletes many keys and ignores 404', async () => {
    const calls = stubFetch((req) => new Response('', { status: req.url.endsWith('/gone') ? 404 : 204 }));
    await new S3Bucket(cfg).delete(['a', 'gone', 'b']);
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE', 'DELETE']);
  });

  it('lists with continuation tokens', async () => {
    const calls = stubFetch(
      () =>
        new Response(
          '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken>' +
            '<Contents><Key>p/a&amp;b</Key><Size>5</Size></Contents><Contents><Key>p/c</Key><Size>7</Size></Contents></ListBucketResult>',
        ),
    );
    const page = await new S3Bucket(cfg).list({ prefix: 'p/', cursor: 'prev' });
    expect(page.objects).toEqual([
      { key: 'p/a&b', size: 5 },
      { key: 'p/c', size: 7 },
    ]);
    expect(page.truncated).toBe(true);
    expect(page.cursor).toBe('tok&1');
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('p/');
    expect(url.searchParams.get('continuation-token')).toBe('prev');
  });
});

describe('getBucket', () => {
  const binding = {} as R2Bucket;

  it('uses the R2 binding by default', () => {
    expect(getBucket({ BUCKET: binding, ...base } as never)).toBe(binding);
  });

  it('uses S3 when STORAGE_BACKEND=s3', () => {
    expect(getBucket({ BUCKET: binding, STORAGE_BACKEND: 's3', ...base } as never)).toBeInstanceOf(S3Bucket);
  });

  it('uses S3 when no binding exists, and fails clearly with no config', () => {
    expect(getBucket(base as never)).toBeInstanceOf(S3Bucket);
    expect(() => getBucket({} as never)).toThrow(/No storage configured/);
  });
});
