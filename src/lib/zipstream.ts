import { crc32 } from 'node:zlib';

export type ZipSource = {
  name: string;
  size: number;
  open: () => Promise<ReadableStream<Uint8Array>>;
};

type PlannedEntry = ZipSource & { nameBytes: Uint8Array; offset: number; zip64: boolean };

const U32 = 0xffffffff;
const U16 = 0xffff;
const FLAGS = 0x0808;

const encoder = new TextEncoder();

export type ZipPlan = { entries: PlannedEntry[]; cdOffset: number; cdSize: number; size: number; zip64Eocd: boolean };

export function planZip(sources: ZipSource[]): ZipPlan {
  let offset = 0;
  const entries: PlannedEntry[] = [];
  for (const s of sources) {
    const nameBytes = encoder.encode(s.name);
    const zip64 = s.size >= U32 || offset >= U32;
    entries.push({ ...s, nameBytes, offset, zip64 });
    offset += localHeaderLen(nameBytes.length, zip64) + s.size + descriptorLen(zip64);
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const e of entries) cdSize += centralHeaderLen(e.nameBytes.length, e.zip64);
  const zip64Eocd = entries.length >= U16 || cdOffset >= U32 || cdSize >= U32;
  const size = cdOffset + cdSize + (zip64Eocd ? 56 + 20 : 0) + 22;
  return { entries, cdOffset, cdSize, size, zip64Eocd };
}

const MB = 1024 * 1024;
const SMALL_ENTRY = 2 * MB;
const AHEAD_ENTRIES = 32;
const AHEAD_BYTES = 24 * MB;

type Fetched = Uint8Array | ReadableStream<Uint8Array>;

export function zipStream(plan: ZipPlan, modified: Date): ReadableStream<Uint8Array> {
  const { time, date } = dosDateTime(modified);
  const crcs: number[] = [];
  let i = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let crc = 0;
  let done = false;

  const ahead = new Map<number, Promise<Fetched>>();
  let next = 0;
  let aheadBytes = 0;
  let largeAhead = -1;

  const fill = () => {
    while (next < plan.entries.length && next - i < AHEAD_ENTRIES && largeAhead <= i) {
      const entry = plan.entries[next]!;
      let fetched: Promise<Fetched>;
      if (entry.size <= SMALL_ENTRY) {
        if (next > i && aheadBytes + entry.size > AHEAD_BYTES) break;
        aheadBytes += entry.size;
        fetched = entry.open().then(async (s) => new Uint8Array(await new Response(s).arrayBuffer()));
      } else {
        fetched = entry.open();
        largeAhead = next;
      }
      fetched.catch(() => {});
      ahead.set(next, fetched);
      next++;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      if (reader) {
        const { value, done: entryDone } = await reader.read();
        if (!entryDone) {
          crc = crc32(value, crc);
          controller.enqueue(value);
          return;
        }
        reader = null;
        const entry = plan.entries[i]!;
        crcs.push(crc >>> 0);
        controller.enqueue(dataDescriptor(crc >>> 0, entry.size, entry.zip64));
        i++;
        return;
      }
      if (i < plan.entries.length) {
        const entry = plan.entries[i]!;
        controller.enqueue(localHeader(entry, time, date));
        fill();
        const fetched = await ahead.get(i)!;
        ahead.delete(i);
        if (fetched instanceof Uint8Array) {
          aheadBytes -= entry.size;
          if (fetched.length > 0) controller.enqueue(fetched);
          const sum = crc32(fetched) >>> 0;
          crcs.push(sum);
          controller.enqueue(dataDescriptor(sum, entry.size, entry.zip64));
          i++;
          fill();
          return;
        }
        reader = fetched.getReader();
        crc = 0;
        return;
      }
      for (let n = 0; n < plan.entries.length; n++) {
        controller.enqueue(centralHeader(plan.entries[n]!, crcs[n]!, time, date));
      }
      controller.enqueue(endRecords(plan));
      done = true;
      controller.close();
    },
    async cancel(reason) {
      await reader?.cancel(reason);
      for (const fetched of ahead.values()) {
        fetched.then((f) => (f instanceof ReadableStream ? f.cancel(reason) : undefined)).catch(() => {});
      }
      ahead.clear();
    },
  });
}

function localHeaderLen(nameLen: number, zip64: boolean): number {
  return 30 + nameLen + (zip64 ? 20 : 0);
}

function descriptorLen(zip64: boolean): number {
  return zip64 ? 24 : 16;
}

function centralHeaderLen(nameLen: number, zip64: boolean): number {
  return 46 + nameLen + (zip64 ? 28 : 0);
}

function localHeader(e: PlannedEntry, time: number, date: number): Uint8Array {
  const out = new Uint8Array(localHeaderLen(e.nameBytes.length, e.zip64));
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, e.zip64 ? 45 : 20, true);
  v.setUint16(6, FLAGS, true);
  v.setUint16(8, 0, true);
  v.setUint16(10, time, true);
  v.setUint16(12, date, true);
  v.setUint32(14, 0, true);
  v.setUint32(18, e.zip64 ? U32 : e.size, true);
  v.setUint32(22, e.zip64 ? U32 : e.size, true);
  v.setUint16(26, e.nameBytes.length, true);
  v.setUint16(28, e.zip64 ? 20 : 0, true);
  out.set(e.nameBytes, 30);
  if (e.zip64) {
    const x = 30 + e.nameBytes.length;
    v.setUint16(x, 0x0001, true);
    v.setUint16(x + 2, 16, true);
    v.setBigUint64(x + 4, BigInt(e.size), true);
    v.setBigUint64(x + 12, BigInt(e.size), true);
  }
  return out;
}

function dataDescriptor(crc: number, size: number, zip64: boolean): Uint8Array {
  const out = new Uint8Array(descriptorLen(zip64));
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x08074b50, true);
  v.setUint32(4, crc, true);
  if (zip64) {
    v.setBigUint64(8, BigInt(size), true);
    v.setBigUint64(16, BigInt(size), true);
  } else {
    v.setUint32(8, size, true);
    v.setUint32(12, size, true);
  }
  return out;
}

function centralHeader(e: PlannedEntry, crc: number, time: number, date: number): Uint8Array {
  const out = new Uint8Array(centralHeaderLen(e.nameBytes.length, e.zip64));
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, (3 << 8) | (e.zip64 ? 45 : 20), true); // made by: Unix
  v.setUint16(6, e.zip64 ? 45 : 20, true);
  v.setUint16(8, FLAGS, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, time, true);
  v.setUint16(14, date, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, e.zip64 ? U32 : e.size, true);
  v.setUint32(24, e.zip64 ? U32 : e.size, true);
  v.setUint16(28, e.nameBytes.length, true);
  v.setUint16(30, e.zip64 ? 28 : 0, true);
  v.setUint32(38, (0o100644 << 16) >>> 0, true);
  v.setUint32(42, e.zip64 ? U32 : e.offset, true);
  out.set(e.nameBytes, 46);
  if (e.zip64) {
    const x = 46 + e.nameBytes.length;
    v.setUint16(x, 0x0001, true);
    v.setUint16(x + 2, 24, true);
    v.setBigUint64(x + 4, BigInt(e.size), true);
    v.setBigUint64(x + 12, BigInt(e.size), true);
    v.setBigUint64(x + 20, BigInt(e.offset), true);
  }
  return out;
}

function endRecords(plan: ZipPlan): Uint8Array {
  const count = plan.entries.length;
  const out = new Uint8Array((plan.zip64Eocd ? 56 + 20 : 0) + 22);
  const v = new DataView(out.buffer);
  let p = 0;
  if (plan.zip64Eocd) {
    const eocd64Offset = plan.cdOffset + plan.cdSize;
    v.setUint32(0, 0x06064b50, true);
    v.setBigUint64(4, 44n, true);
    v.setUint16(12, 45, true);
    v.setUint16(14, 45, true);
    v.setBigUint64(24, BigInt(count), true);
    v.setBigUint64(32, BigInt(count), true);
    v.setBigUint64(40, BigInt(plan.cdSize), true);
    v.setBigUint64(48, BigInt(plan.cdOffset), true);
    v.setUint32(56, 0x07064b50, true);
    v.setBigUint64(64, BigInt(eocd64Offset), true);
    v.setUint32(72, 1, true);
    p = 76;
  }
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, plan.zip64Eocd ? U16 : count, true);
  v.setUint16(p + 10, plan.zip64Eocd ? U16 : count, true);
  v.setUint32(p + 12, plan.zip64Eocd ? U32 : plan.cdSize, true);
  v.setUint32(p + 16, plan.zip64Eocd ? U32 : plan.cdOffset, true);
  return out;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}
