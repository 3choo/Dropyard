import { AwsClient } from 'aws4fetch';
import { ApiError } from './http';

export const DEFAULT_PART_SIZE = 64 * 1024 * 1024;
export const MAX_PARTS = 10_000;
export const MAX_OBJECT_BYTES = 4_500 * 1024 * 1024 * 1024;

declare global {
  interface Env {
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    EXTRACT_CALLBACK_SECRET?: string;
  }
}

export function partSizeFor(size: number): number {
  const parts = Math.ceil(size / DEFAULT_PART_SIZE);
  if (parts <= MAX_PARTS) return DEFAULT_PART_SIZE;
  const needed = Math.ceil(size / MAX_PARTS);
  return Math.ceil(needed / (1024 * 1024)) * 1024 * 1024;
}

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? null;
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

export type ListedPart = { n: number; etag: string; size: number };

export class R2S3 {
  readonly enabled: boolean;
  private readonly client: AwsClient;
  private readonly account: string;
  private readonly bucket: string;

  constructor(env: Env) {
    this.account = env.R2_S3_ACCOUNT_ID;
    this.bucket = env.R2_BUCKET_NAME;
    this.enabled = !!(this.account && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
    this.client = this.enabled
      ? new AwsClient({
          accessKeyId: env.R2_ACCESS_KEY_ID!,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
          service: 's3',
          region: 'auto',
        })
      : (undefined as unknown as AwsClient);
  }

  private objectUrl(key: string, query: Record<string, string> = {}): URL {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`https://${this.account}.r2.cloudflarestorage.com/${this.bucket}/${encodedKey}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new ApiError(
        400,
        'presign_unavailable',
        'Large multipart uploads need R2 S3 API credentials configured on the Worker (R2_S3_ACCOUNT_ID var plus R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY secrets). Small files up to the single-upload limit work without them.',
      );
    }
  }

  async initiate(key: string): Promise<string> {
    this.requireEnabled();
    const res = await this.client.fetch(this.objectUrl(key, { uploads: '' }), { method: 'POST' });
    const body = await res.text();
    if (!res.ok) throw new ApiError(502, 's3_error', `R2 rejected multipart initiate: ${body.slice(0, 300)}`);
    const uploadId = extractTag(body, 'UploadId');
    if (!uploadId) throw new ApiError(502, 's3_error', 'R2 initiate response missing UploadId');
    return unescapeXml(uploadId);
  }

  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentType?: string,
  ): Promise<string> {
    this.requireEnabled();
    const url = this.objectUrl(key, { partNumber: String(partNumber), uploadId });
    const headers = new Headers();
    headers.set('content-type', contentType || 'application/octet-stream');
    const signed = await this.client.sign(new Request(url, { method: 'PUT', headers }), {
      aws: { signQuery: true, allHeaders: true },
    });
    return signed.url;
  }

  async presignGet(key: string, expiresSeconds = 900): Promise<string> {
    this.requireEnabled();
    const url = this.objectUrl(key, { 'X-Amz-Expires': String(expiresSeconds) });
    const signed = await this.client.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
    return signed.url;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: ArrayBuffer): Promise<string> {
    this.requireEnabled();
    const res = await this.client.fetch(this.objectUrl(key, { partNumber: String(partNumber), uploadId }), {
      method: 'PUT',
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(502, 's3_error', `R2 rejected part ${partNumber}: ${text.slice(0, 300)}`);
    }
    return res.headers.get('etag') ?? '';
  }

  async listParts(key: string, uploadId: string): Promise<ListedPart[]> {
    this.requireEnabled();
    const parts: ListedPart[] = [];
    let marker = '';
    for (;;) {
      const query: Record<string, string> = { uploadId };
      if (marker) query['part-number-marker'] = marker;
      const res = await this.client.fetch(this.objectUrl(key, query));
      const body = await res.text();
      if (!res.ok) throw new ApiError(502, 's3_error', `R2 ListParts failed: ${body.slice(0, 300)}`);
      const chunks = body.match(/<Part>[\s\S]*?<\/Part>/g) ?? [];
      for (const chunk of chunks) {
        const n = parseInt(extractTag(chunk, 'PartNumber') ?? '0', 10);
        const etag = extractTag(chunk, 'ETag');
        const size = parseInt(extractTag(chunk, 'Size') ?? '0', 10);
        if (n && etag) parts.push({ n, etag: unescapeXml(etag), size });
      }
      const truncated = extractTag(body, 'IsTruncated') === 'true';
      marker = extractTag(body, 'NextPartNumberMarker') ?? '';
      if (!truncated || !marker) break;
    }
    return parts.sort((a, b) => a.n - b.n);
  }

  async complete(key: string, uploadId: string, parts: { n: number; etag: string }[]): Promise<string> {
    this.requireEnabled();
    const xml =
      '<CompleteMultipartUpload>' +
      parts
        .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>';
    const res = await this.client.fetch(this.objectUrl(key, { uploadId }), {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: xml,
    });
    const body = await res.text();
    if (!res.ok) throw new ApiError(502, 's3_complete_failed', `R2 rejected multipart complete: ${body.slice(0, 300)}`);
    const etag = extractTag(body, 'ETag');
    return etag ? unescapeXml(etag) : '';
  }

  async abort(key: string, uploadId: string): Promise<void> {
    this.requireEnabled();
    await this.client.fetch(this.objectUrl(key, { uploadId }), { method: 'DELETE' });
  }
}
