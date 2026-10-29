import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha1 } from '../src/git/sha1';
import { concatBytes, parsePkts, pkt, sideband } from '../src/git/pkt';
import { hashPassword, verifyPassword } from '../src/lib/auth';
import { randomToken, sanitizeFilePath, sha256Hex, slugify } from '../src/lib/ids';
import { diffText } from '../src/lib/linediff';
import { contentTypeForPath, isTextPath } from '../src/lib/mime';
import { partSizeFor, DEFAULT_PART_SIZE, MAX_PARTS } from '../src/lib/s3';

describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const stored = await hashPassword('correct-horse-battery');
    expect(stored).toMatch(/^pbkdf2\$\d+\$/);
    expect(await verifyPassword('correct-horse-battery', stored)).toBe(true);
    expect(await verifyPassword('wrong-horse-battery', stored)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects malformed or hostile stored values', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$999999999$AAAA$AAAA')).toBe(false);
  });
});

describe('ids and paths', () => {
  it('slugifies names', () => {
    expect(slugify('My Cool MLO!')).toBe('my-cool-mlo');
    expect(slugify('  --Café--  ')).toBe('cafe');
    expect(slugify('!!!')).toMatch(/^p-/);
  });

  it('normalizes upload paths and refuses traversal', () => {
    expect(sanitizeFilePath('\\stream\\a.ytd')).toBe('stream/a.ytd');
    expect(sanitizeFilePath('//a//b')).toBe('a/b');
    expect(sanitizeFilePath('../etc/passwd')).toBeNull();
    expect(sanitizeFilePath('a/./b')).toBeNull();
    expect(sanitizeFilePath('')).toBeNull();
  });

  it('generates unique url-safe tokens', () => {
    const a = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(randomToken(32));
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('mime', () => {
  it('maps GTA asset extensions and falls back to octet-stream', () => {
    expect(contentTypeForPath('stream/car.YFT')).toBe('application/x-gtav-yft');
    expect(contentTypeForPath('x.unknownext')).toBe('application/octet-stream');
  });

  it('detects text files', () => {
    expect(isTextPath('fxmanifest.lua')).toBe(true);
    expect(isTextPath('LICENSE')).toBe(true);
    expect(isTextPath('stream/car.yft')).toBe(false);
  });
});

describe('line diff', () => {
  it('reports additions and deletions with context', () => {
    const d = diffText('a\nb\nc\n', 'a\nB\nc\nd\n');
    if ('tooLarge' in d) throw new Error('unexpected');
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
    expect(d.hunks.length).toBe(1);
  });

  it('is empty for identical text', () => {
    const d = diffText('same\n', 'same\n');
    if ('tooLarge' in d) throw new Error('unexpected');
    expect(d.hunks).toEqual([]);
  });
});

describe('pkt-lines', () => {
  it('round-trips data and flush packets', () => {
    const buf = concatBytes([pkt('hello\n'), pkt('world'), new TextEncoder().encode('0000')]);
    const { pkts, rest } = parsePkts(buf);
    expect(pkts.map((p) => (p.kind === 'data' ? p.text : p.kind))).toEqual(['hello', 'world', 'flush']);
    expect(rest.length).toBe(0);
  });

  it('keeps a trailing partial packet in rest', () => {
    const { pkts, rest } = parsePkts(concatBytes([pkt('ok'), pkt('partial').subarray(0, 5)]));
    expect(pkts.length).toBe(1);
    expect(rest.length).toBe(5);
  });

  it('splits large sideband payloads', () => {
    expect(sideband(1, new Uint8Array(70000)).length).toBe(2);
    expect(() => pkt(new Uint8Array(70000))).toThrow();
  });
});

describe('resumable SHA-1', () => {
  it('matches node:crypto, including across a saved state', () => {
    const data = new Uint8Array(1000).map((_, i) => i % 251);
    const whole = new Sha1();
    whole.update(data);
    const split = new Sha1();
    split.update(data.subarray(0, 333));
    const resumed = new Sha1(split.save());
    resumed.update(data.subarray(333));
    const expected = createHash('sha1').update(data).digest('hex');
    expect(Buffer.from(whole.digest()).toString('hex')).toBe(expected);
    expect(Buffer.from(resumed.digest()).toString('hex')).toBe(expected);
  });
});

describe('multipart sizing', () => {
  it('uses the default part size until it would exceed the part limit', () => {
    expect(partSizeFor(1024)).toBe(DEFAULT_PART_SIZE);
    const huge = DEFAULT_PART_SIZE * MAX_PARTS * 2;
    expect(partSizeFor(huge) * MAX_PARTS).toBeGreaterThanOrEqual(huge);
  });
});
