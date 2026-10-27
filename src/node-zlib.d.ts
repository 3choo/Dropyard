declare module 'node:zlib' {
  export function crc32(data: Uint8Array | string, value?: number): number;
}
