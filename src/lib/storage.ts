import { AwsClient } from 'aws4fetch';

/**
 * Object storage configuration.
 *
 * dropyard talks to storage two ways: through the Cloudflare R2 Worker binding
 * (`BUCKET`) when it exists, and through the S3 API (presigned multipart
 * uploads, the RAR container, and every non-R2 backend). The S3 side is
 * configured with `S3_*` variables; the older `R2_*` names keep working.
 */
export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** https://endpoint/bucket/key (true) or https://bucket.endpoint/key (false). */
  pathStyle: boolean;
};

declare global {
  interface Env {
    /** Set to "s3" to ignore the R2 binding and use the S3 API for everything. */
    STORAGE_BACKEND?: string;
    S3_ENDPOINT?: string;
    S3_REGION?: string;
    S3_BUCKET?: string;
    S3_ACCESS_KEY_ID?: string;
    S3_SECRET_ACCESS_KEY?: string;
    S3_FORCE_PATH_STYLE?: string;
    /** Legacy names, still accepted as fallbacks for the S3_* settings. */
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
  }
}

type S3Env = Pick<
  Env,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
  | 'R2_S3_ACCOUNT_ID'
  | 'R2_BUCKET_NAME'
  | 'R2_ACCESS_KEY_ID'
  | 'R2_SECRET_ACCESS_KEY'
>;

/** Resolve the S3 settings, or null when credentials are missing. */
export function s3Config(env: S3Env): S3Config | null {
  const endpoint =
    env.S3_ENDPOINT || (env.R2_S3_ACCOUNT_ID ? `https://${env.R2_S3_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  const bucket = env.S3_BUCKET || env.R2_BUCKET_NAME;
  const accessKeyId = env.S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    region: env.S3_REGION || 'auto',
    bucket,
    accessKeyId,
    secretAccessKey,
    pathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
  };
}

export function s3ObjectUrl(cfg: S3Config, key: string, query: Record<string, string> = {}): URL {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const base = new URL(cfg.endpoint);
  const url = cfg.pathStyle
    ? new URL(`${base.origin}/${cfg.bucket}/${encodedKey}`)
    : new URL(`${base.protocol}//${cfg.bucket}.${base.host}/${encodedKey}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

function s3BucketUrl(cfg: S3Config, query: Record<string, string>): URL {
  const base = new URL(cfg.endpoint);
  const url = cfg.pathStyle
    ? new URL(`${base.origin}/${cfg.bucket}`)
    : new URL(`${base.protocol}//${cfg.bucket}.${base.host}/`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

function tag(xml: string, name: string): string | null {
  return xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

type PutOptions = { httpMetadata?: { contentType?: string } };
type GetOptions = { range?: { offset: number; length: number } };

class S3Object {
  constructor(
    readonly key: string,
    readonly size: number,
    readonly httpEtag: string,
    readonly body: ReadableStream<Uint8Array>,
  ) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Response(this.body).arrayBuffer();
  }
  async text(): Promise<string> {
    return new Response(this.body).text();
  }
  async json<T = unknown>(): Promise<T> {
    return new Response(this.body).json() as Promise<T>;
  }
}

/**
 * The slice of the R2 bucket API dropyard uses (get / head / put / delete /
 * list), implemented over the S3 REST API so any S3-compatible service works.
 */
export class S3Bucket {
  private readonly client: AwsClient;

  constructor(private readonly cfg: S3Config) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: cfg.region,
    });
  }

  private async fail(res: Response, action: string): Promise<never> {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 ${action} failed (${res.status}): ${text.slice(0, 300)}`);
  }

  async head(key: string): Promise<{ key: string; size: number; httpEtag: string } | null> {
    const res = await this.client.fetch(s3ObjectUrl(this.cfg, key), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, `HEAD ${key}`);
    return {
      key,
      size: parseInt(res.headers.get('content-length') ?? '0', 10),
      httpEtag: res.headers.get('etag') ?? '',
    };
  }

  async get(key: string, options?: GetOptions): Promise<S3Object | null> {
    const headers: Record<string, string> = {};
    const range = options?.range;
    if (range) headers.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const res = await this.client.fetch(s3ObjectUrl(this.cfg, key), { method: 'GET', headers });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) await this.fail(res, `GET ${key}`);
    const contentRange = res.headers.get('content-range');
    const total = contentRange?.match(/\/(\d+)$/)?.[1];
    const size = total ? parseInt(total, 10) : parseInt(res.headers.get('content-length') ?? '0', 10);
    return new S3Object(key, size, res.headers.get('etag') ?? '', res.body ?? new Response(new Uint8Array(0)).body!);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: PutOptions,
  ): Promise<void> {
    // S3 needs a known length and payload hash up front, so streams are buffered.
    const body: ArrayBuffer | ArrayBufferView | string =
      value === null
        ? new Uint8Array(0)
        : value instanceof ReadableStream
          ? await new Response(value).arrayBuffer()
          : value;
    const res = await this.client.fetch(s3ObjectUrl(this.cfg, key), {
      method: 'PUT',
      headers: { 'content-type': options?.httpMetadata?.contentType ?? 'application/octet-stream' },
      body: body as BodyInit,
    });
    if (!res.ok) await this.fail(res, `PUT ${key}`);
    await res.body?.cancel();
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (let i = 0; i < list.length; i += 16) {
      await Promise.all(
        list.slice(i, i + 16).map(async (key) => {
          const res = await this.client.fetch(s3ObjectUrl(this.cfg, key), { method: 'DELETE' });
          if (!res.ok && res.status !== 404) await this.fail(res, `DELETE ${key}`);
          await res.body?.cancel();
        }),
      );
    }
  }

  async list(options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }> {
    const query: Record<string, string> = { 'list-type': '2' };
    if (options.prefix) query.prefix = options.prefix;
    if (options.cursor) query['continuation-token'] = options.cursor;
    if (options.limit) query['max-keys'] = String(options.limit);
    const res = await this.client.fetch(s3BucketUrl(this.cfg, query));
    const xml = await res.text();
    if (!res.ok) throw new Error(`S3 list failed (${res.status}): ${xml.slice(0, 300)}`);
    const objects = (xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []).map((chunk) => ({
      key: unescapeXml(tag(chunk, 'Key') ?? ''),
      size: parseInt(tag(chunk, 'Size') ?? '0', 10),
    }));
    const truncated = tag(xml, 'IsTruncated') === 'true';
    const next = tag(xml, 'NextContinuationToken');
    return { objects, truncated, cursor: truncated && next ? unescapeXml(next) : undefined };
  }
}

/**
 * The bucket every route reads and writes. Uses the R2 binding when present
 * (fastest, no credentials needed) and the S3 API otherwise.
 */
export function getBucket(env: Env): R2Bucket {
  if (env.BUCKET && env.STORAGE_BACKEND !== 's3') return env.BUCKET;
  const cfg = s3Config(env);
  if (!cfg) {
    throw new Error(
      'No storage configured: bind an R2 bucket as BUCKET or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY',
    );
  }
  return new S3Bucket(cfg) as unknown as R2Bucket;
}
