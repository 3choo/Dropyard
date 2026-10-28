declare module 'node:crypto' {
  interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: 'hex'): string;
    digest(): Uint8Array;
  }
  export function createHash(algorithm: 'sha1' | 'sha256'): Hash;
}
