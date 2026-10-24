import { ApiError, api } from '../../api/client';

export type PartState = 'pending' | 'uploading' | 'done' | 'failed';

export interface UploadItem {
  id: string;
  releaseId: string;
  path: string;
  fileName: string;
  size: number;
  contentType: string;
  serverId: string | null;
  mode: 'single' | 'presigned' | null;
  partSize: number;
  totalParts: number;
  partStates: PartState[];
  etags: Record<number, string>;
  partHashes: Record<number, string>;
  uploadedBytes: number;
  status: 'queued' | 'starting' | 'active' | 'paused' | 'completing' | 'unpacking' | 'done' | 'error';
  error?: string;
  digest?: string;
  /** Set when the server started auto-unpacking this archive after upload. */
  extractionId?: string;
  bps: number;
  addedAt: number;
}

export interface PickedFile {
  file: File;
  path: string;
}

export interface ExtractionJob {
  id: string;
  kind: 'zip' | 'rar';
  status: 'queued' | 'running' | 'done' | 'failed';
  filesAdded: number;
  bytesAdded: number;
  error: string | null;
  archives: string[];
  createdAt: number;
  finishedAt: number | null;
}

type Listener = (items: UploadItem[]) => void;

export type UploadNotify = (kind: 'ok' | 'err', message: string) => void;

// --- IndexedDB persistence (File blobs survive reloads) -------------------------

const DB_NAME = 'gitctx-uploads';
const STORE = 'items';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'item.id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface PersistedRecord {
  item: UploadItem;
  file: File;
}

async function idbPut(item: UploadItem, file: File): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ item: { ...item }, file } satisfies PersistedRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* persistence is best-effort */
  }
}

async function idbDelete(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}

async function idbListFor(releaseId: string): Promise<PersistedRecord[]> {
  try {
    const db = await openDb();
    const all = await new Promise<PersistedRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as PersistedRecord[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return all.filter((r) => r.item.releaseId === releaseId);
  } catch {
    return [];
  }
}

// --- Engine ------------------------------------------------------------------------

const PART_CONCURRENCY = 3;
const PRESIGN_BATCH = 24;
const MAX_PART_RETRIES = 4;

function randomId(): string {
  return crypto.randomUUID();
}

async function sha256B64(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/**
 * PUT a blob with upload progress. fetch() exposes no upload-progress events,
 * so parts are sent over XHR to keep the progress bar live mid-part.
 * Rejects with TypeError on network/CORS failure (matches fetch semantics —
 * callers special-case it) and with an "AbortError" DOMException on abort.
 */
function xhrPut(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  label: string,
  onProgress: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.getResponseHeader('etag') ?? '');
      } else {
        reject(new Error(`${label} failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new TypeError(`${label} blocked by the browser (CORS or network)`));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

export class UploadEngine {
  private items = new Map<string, UploadItem>();
  private files = new Map<string, File>();
  private listeners = new Set<Listener>();
  private aborts = new Map<string, AbortController>();
  private xhrs = new Map<string, XMLHttpRequest>();
  private pumping = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private releaseId: string,
    private pollTarget?: { slug: string; version: string; notify?: UploadNotify },
  ) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.list());
    return () => this.listeners.delete(fn);
  }

  list(): UploadItem[] {
    return [...this.items.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  private notify(): void {
    const snapshot = this.list();
    for (const fn of this.listeners) fn(snapshot);
  }

  private update(id: string, patch: Partial<UploadItem>, persist = true): UploadItem | null {
    const item = this.items.get(id);
    if (!item) return null;
    Object.assign(item, patch);
    if (persist) {
      void idbPut(item, this.files.get(id) ?? new File([], item.fileName));
    }
    this.notify();
    return item;
  }

  addFiles(picked: PickedFile[]): void {
    const now = Date.now();
    for (let i = 0; i < picked.length; i++) {
      const { file, path } = picked[i]!;
      const id = randomId();
      const item: UploadItem = {
        id,
        releaseId: this.releaseId,
        path,
        fileName: file.name,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
        serverId: null,
        mode: null,
        partSize: 0,
        totalParts: 1,
        partStates: ['pending'],
        etags: {},
        partHashes: {},
        uploadedBytes: 0,
        status: 'queued',
        bps: 0,
        addedAt: now + i,
      };
      this.items.set(id, item);
      this.files.set(id, file);
      void idbPut(item, file);
    }
    this.notify();
    void this.pump();
  }

  /** Reload persisted uploads after a page refresh; marks them paused. */
  async loadPersisted(): Promise<number> {
    const records = await idbListFor(this.releaseId);
    let resumed = 0;
    for (const r of records) {
      if (r.item.status === 'done' || r.item.status === 'error' || r.item.status === 'unpacking') {
        // 'unpacking' records are settled server-side; the file tree refreshes.
        void idbDelete(r.item.id);
        continue;
      }
      this.items.set(r.item.id, { ...r.item, status: 'paused', bps: 0 });
      this.files.set(r.item.id, r.file);
      resumed++;
    }
    if (resumed > 0) this.notify();
    return resumed;
  }

  pause(id: string): void {
    this.aborts.get(id)?.abort();
    this.xhrs.get(id)?.abort();
    this.update(id, { status: 'paused', bps: 0 });
  }

  pauseAll(): void {
    for (const item of this.items.values()) {
      if (['queued', 'starting', 'active'].includes(item.status)) this.pause(item.id);
    }
  }

  resume(id: string): void {
    const item = this.items.get(id);
    if (!item || !['paused', 'error'].includes(item.status)) return;
    this.update(id, { status: 'queued', error: undefined });
    void this.pump();
  }

  resumeAll(): void {
    for (const item of this.items.values()) {
      if (['paused', 'error'].includes(item.status)) this.resume(item.id);
    }
  }

  async remove(id: string): Promise<void> {
    this.aborts.get(id)?.abort();
    this.xhrs.get(id)?.abort();
    const item = this.items.get(id);
    if (item?.serverId && item.status !== 'done') {
      void api(`/api/uploads/${item.serverId}/abort`, { method: 'POST' }).catch(() => {});
    }
    this.items.delete(id);
    this.files.delete(id);
    void idbDelete(id);
    this.notify();
  }

  get busy(): boolean {
    return [...this.items.values()].some((i) =>
      ['queued', 'starting', 'active', 'completing', 'unpacking'].includes(i.status),
    );
  }

  get completedCount(): number {
    return [...this.items.values()].filter((i) => i.status === 'done').length;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = [...this.items.values()].find((i) => i.status === 'queued');
        if (!next) break;
        await this.process(next.id);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async process(id: string): Promise<void> {
    let item = this.items.get(id);
    if (!item) return;
    const file = this.files.get(id);
    if (!file) {
      this.update(id, { status: 'error', error: 'The file is no longer available (page was reloaded without persistence).' });
      return;
    }

    try {
      const ctrl = new AbortController();
      this.aborts.set(id, ctrl);
      // 1. Create (or reuse) the server session.
      if (!item.serverId) {
        this.update(id, { status: 'starting' });
        const res = await api<{
          uploadId: string;
          mode: 'single' | 'presigned';
          partSize: number;
          totalParts: number;
        }>(`/api/uploads`, {
          method: 'POST',
          body: JSON.stringify({
            releaseId: this.releaseId,
            path: item.path,
            size: item.size,
            contentType: item.contentType,
          }),
        });
        this.update(id, {
          serverId: res.uploadId,
          mode: res.mode,
          partSize: res.partSize,
          totalParts: res.totalParts,
          partStates: Array.from({ length: res.totalParts }, () => 'pending' as PartState),
        });
        item = this.items.get(id)!;
      } else if (item.mode === 'presigned') {
        // Reconnect: ask R2 which parts already landed.
        try {
          const res = await api<{ parts: Array<{ n: number; etag: string; size: number }> }>(
            `/api/uploads/${item.serverId}/resume`,
            { method: 'POST' },
          );
          const states = [...item.partStates];
          const etags = { ...item.etags };
          for (const p of res.parts) {
            states[p.n - 1] = 'done';
            etags[p.n] = p.etag;
          }
          const doneBytes = res.parts.reduce((sum, p) => sum + p.size, 0);
          this.update(id, { partStates: states, etags, uploadedBytes: doneBytes });
          item = this.items.get(id)!;
        } catch {
          /* server session may be gone; the next step will fail loudly */
        }
      }

      if (item.mode === 'single') {
        await this.processSingle(id, file);
      } else {
        await this.processMultipart(id, file);
      }
      this.aborts.delete(id);
    } catch (err) {
      const wasPaused = this.aborts.get(id)?.signal.aborted ?? false;
      this.aborts.delete(id);
      if (wasPaused) return; // deliberate pause
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Upload failed';
      this.update(id, { status: 'error', error: message, bps: 0 });
    }
  }

  private processSingle(id: string, file: File): Promise<void> {
    const item = this.items.get(id)!;
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.xhrs.set(id, xhr);
      const started = performance.now();
      this.update(id, { status: 'active', partStates: ['uploading'] });
      xhr.upload.onprogress = (e) => {
        const elapsed = (performance.now() - started) / 1000;
        this.update(id, {
          uploadedBytes: e.loaded,
          bps: elapsed > 0 ? e.loaded / elapsed : 0,
        }, false);
      };
      xhr.onload = () => {
        this.xhrs.delete(id);
        if (xhr.status >= 200 && xhr.status < 300) {
          let extraction: { id: string } | null = null;
          try {
            extraction = (JSON.parse(xhr.responseText) as { extraction?: { id: string } | null }).extraction ?? null;
          } catch {
            /* no body */
          }
          if (extraction) {
            this.update(id, {
              status: 'unpacking',
              extractionId: extraction.id,
              uploadedBytes: item.size,
              bps: 0,
            });
            this.wakeExtractionPoller();
          } else {
            this.update(id, {
              status: 'done',
              partStates: ['done'],
              uploadedBytes: item.size,
              bps: 0,
            });
            void idbDelete(id);
          }
          resolve();
        } else {
          let message = `Server answered ${xhr.status}`;
          try {
            message = (JSON.parse(xhr.responseText) as { message?: string }).message ?? message;
          } catch {
            /* keep default */
          }
          reject(new Error(message));
        }
      };
      xhr.onerror = () => {
        this.xhrs.delete(id);
        reject(new Error('Network error during upload'));
      };
      xhr.onabort = () => {
        this.xhrs.delete(id);
        resolve(); // pause() already set the status
      };
      xhr.open('PUT', `/api/uploads/${item.serverId}/body`);
      xhr.setRequestHeader('content-type', item.contentType);
      xhr.send(file);
    });
  }

  private async processMultipart(id: string, file: File): Promise<void> {
    const item = this.items.get(id)!;
    this.update(id, { status: 'active' });
    const started = performance.now();

    const setPart = (n: number, state: PartState) => {
      const states = [...this.items.get(id)!.partStates];
      states[n - 1] = state;
      this.update(id, { partStates: states }, false);
    };

    const missing: number[] = [];
    for (let n = 1; n <= item.totalParts; n++) {
      if (this.items.get(id)?.partStates[n - 1] !== 'done') missing.push(n);
    }

    // Bytes already on R2 when this run started (resumed sessions), plus the
    // live per-part counters; uploadedBytes is recomputed from both so the
    // progress bar moves while a single 64 MB part is still in flight.
    const baseBytes = this.items.get(id)!.uploadedBytes;
    const partLoaded = new Map<number, number>();
    const reportProgress = (n: number, loaded: number) => {
      partLoaded.set(n, loaded);
      let uploaded = baseBytes;
      for (const v of partLoaded.values()) uploaded += v;
      const elapsed = (performance.now() - started) / 1000;
      this.update(id, { uploadedBytes: uploaded, bps: elapsed > 0 ? uploaded / elapsed : 0 }, false);
    };

    let cursorIdx = 0;
    const workers = Array.from({ length: Math.min(PART_CONCURRENCY, missing.length) }, async () => {
      for (;;) {
        const idx = cursorIdx++;
        if (idx >= missing.length) return;
        const n = missing[idx]!;
        const itemNow = this.items.get(id)!;
        const offset = (n - 1) * itemNow.partSize;
        const length = Math.min(itemNow.partSize, itemNow.size - offset);
        const partFile = file.slice(offset, offset + length);

        let hash = itemNow.partHashes[n];
        if (!hash) {
          hash = await sha256B64(await partFile.arrayBuffer());
          const hashes = { ...this.items.get(id)!.partHashes, [n]: hash };
          this.update(id, { partHashes: hashes });
        }

        // Presign lazily per batch of parts; re-presigned after failures.
        setPart(n, 'uploading');

        let etag: string | null = null;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < MAX_PART_RETRIES; attempt++) {
          if (this.aborts.get(id)?.signal.aborted) return;
          partLoaded.set(n, 0);
          try {
            const signUrl = await this.presignOne(id, n, hash);
            etag = await xhrPut(
              signUrl,
              partFile,
              // Must stay byte-identical to what the server signed into the URL.
              { 'x-amz-checksum-sha256': hash, 'content-type': itemNow.contentType },
              this.aborts.get(id)?.signal,
              `Part ${n} PUT`,
              (loaded) => reportProgress(n, loaded),
            );
            break;
          } catch (err) {
            // A CORS block or network failure rejects with TypeError and the
            // body is unreadable — the cached URL may be the problem, so the
            // next attempt re-presigns fresh. AbortError from pause() falls
            // into the same path and is caught by the aborted check above.
            this.presignCache.get(itemNow.serverId!)?.delete(n);
            lastError =
              err instanceof TypeError
                ? new Error(
                    `Part ${n} was blocked by the browser (CORS or network). ` +
                      'The R2 bucket CORS policy must allow this origin for PUT requests.',
                  )
                : err;
            await new Promise((r) => setTimeout(r, 700 * 2 ** attempt));
          }
        }
        if (etag === null) {
          setPart(n, 'failed');
          throw lastError instanceof Error ? lastError : new Error(`Part ${n} failed after retries`);
        }

        partLoaded.set(n, length);
        const etags = { ...this.items.get(id)!.etags, [n]: etag };
        const prev = this.items.get(id)!;
        const elapsed = (performance.now() - started) / 1000;
        const uploaded = baseBytes + [...partLoaded.values()].reduce((s, v) => s + v, 0);
        this.update(id, {
          partStates: prev.partStates.map((s, i) => (i === n - 1 ? 'done' : s)),
          etags,
          uploadedBytes: uploaded,
          bps: elapsed > 0 ? uploaded / elapsed : 0,
        });
      }
    });

    await Promise.all(workers);
    if (this.aborts.get(id)?.signal.aborted) return;

    this.update(id, { status: 'completing', bps: 0 });
    const finalItem = this.items.get(id)!;
    const parts = [];
    for (let n = 1; n <= finalItem.totalParts; n++) {
      parts.push({ n, etag: finalItem.etags[n] ?? '', sha256: finalItem.partHashes[n] ?? '' });
    }
    const res = await api<{ digest: string; extraction?: { id: string } | null }>(`/api/uploads/${finalItem.serverId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
    });
    if (res.extraction) {
      this.update(id, {
        status: 'unpacking',
        extractionId: res.extraction.id,
        digest: res.digest,
        uploadedBytes: finalItem.size,
      });
      this.wakeExtractionPoller();
    } else {
      this.update(id, { status: 'done', digest: res.digest, uploadedBytes: finalItem.size });
      void idbDelete(id);
    }
  }

  /** Poll the release detail until every active extraction settles. */
  private wakeExtractionPoller(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollExtractions(), 2500);
  }

  private async pollExtractions(): Promise<void> {
    const unpacking = [...this.items.values()].filter((i) => i.status === 'unpacking');
    if (unpacking.length === 0 || !this.pollTarget) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      return;
    }
    let jobs: ExtractionJob[];
    try {
      const res = await api<{ extractions: ExtractionJob[] }>(
        `/api/projects/${this.pollTarget.slug}/releases/${this.pollTarget.version}`,
      );
      jobs = res.extractions ?? [];
    } catch {
      return; // transient; retry on the next tick
    }
    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const item of unpacking) {
      const job = item.extractionId ? byId.get(item.extractionId) : undefined;
      if (!job || (job.status !== 'done' && job.status !== 'failed')) continue;
      if (job.status === 'done') {
        this.update(item.id, { status: 'done' });
        void idbDelete(item.id);
        this.pollTarget.notify?.('ok', `Unpacked ${item.path} — ${job.filesAdded} file${job.filesAdded === 1 ? '' : 's'} added`);
      } else {
        this.update(item.id, { status: 'error', error: job.error ?? 'Unpack failed', bps: 0 });
        void idbDelete(item.id);
        this.pollTarget.notify?.('err', `Unpacking ${item.path} failed: ${job.error ?? 'unknown error'}`);
      }
    }
  }

  private presignCache = new Map<string, Map<number, string>>();

  private async presignOne(id: string, n: number, hash: string): Promise<string> {
    const item = this.items.get(id)!;
    const serverId = item.serverId!;
    let cache = this.presignCache.get(serverId);
    if (!cache) {
      cache = new Map();
      this.presignCache.set(serverId, cache);
    }
    const hit = cache.get(n);
    if (hit) return hit;

    // Sign this part together with a look-ahead batch to save round trips.
    const itemNow = this.items.get(id)!;
    const upcoming: number[] = [];
    for (let m = n; m <= itemNow.totalParts && upcoming.length < PRESIGN_BATCH; m++) {
      if (cache.has(m) || !itemNow.partHashes[m]) continue;
      if (m === n || itemNow.partStates[m - 1] === 'pending') upcoming.push(m);
    }
    const toSign = upcoming.includes(n) ? upcoming : [n];
    const payload = toSign.map((m) => ({
      n: m,
      sha256: m === n ? hash : itemNow.partHashes[m] ?? hash,
    }));
    const res = await api<{ urls: Array<{ n: number; url: string }> }>(
      `/api/uploads/${serverId}/parts`,
      { method: 'POST', body: JSON.stringify({ parts: payload, contentType: item.contentType }) },
    );
    for (const u of res.urls) cache.set(u.n, u.url);
    const url = cache.get(n);
    if (!url) throw new Error(`Server did not presign part ${n}`);
    return url;
  }
}
