// workerd ships node:zlib under nodejs_compat; only crc32 is used (zip streaming).
declare module 'node:zlib' {
  export function crc32(data: Uint8Array | string, value?: number): number;
}
