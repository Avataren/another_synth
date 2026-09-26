/**
 * A `.sid` file for tests (plan-psid-import.md): the PSID/RSID header HVSC's
 * `SID_file_format.txt` describes, filled from `h` (a v2 PSID, PAL, 6581,
 * loading at $1000, by default), then `data`, the C64 bytes.
 */

export interface PsidHeaderFields {
  magic?: 'PSID' | 'RSID' | string;
  version?: number;
  dataOffset?: number;
  load?: number;
  init?: number;
  play?: number;
  songs?: number;
  start?: number;
  speed?: number;
  flags?: number;
  second?: number;
  third?: number;
  name?: string;
  author?: string;
}

export function buildPsid(h: PsidHeaderFields, data: readonly number[]): Uint8Array {
  const version = h.version ?? 2;
  const dataOffset = h.dataOffset ?? (version === 1 ? 0x76 : 0x7c);
  const start = Math.max(dataOffset, 0x76);
  const out = new Uint8Array(start + data.length);
  const word = (at: number, v: number): void => {
    out[at] = (v >> 8) & 0xff;
    out[at + 1] = v & 0xff;
  };
  const ascii = (at: number, s: string): void => out.set([...s].slice(0, 32).map((c) => c.charCodeAt(0) & 0xff), at);
  ascii(0, h.magic ?? 'PSID');
  word(4, version);
  word(6, dataOffset);
  word(8, h.load ?? 0x1000);
  word(10, h.init ?? 0x1000);
  word(12, h.play ?? 0x1003);
  word(14, h.songs ?? 1);
  word(16, h.start ?? 1);
  word(18, (h.speed ?? 0) >>> 16);
  word(20, (h.speed ?? 0) & 0xffff);
  ascii(0x16, h.name ?? 'Test');
  ascii(0x36, h.author ?? 'Tests');
  if (version >= 2 && dataOffset >= 0x7c) {
    word(0x76, h.flags ?? 0x14);
    out[0x7a] = h.second ?? 0;
    out[0x7b] = h.third ?? 0;
  }
  out.set(data, start);
  return out;
}

/** `code` placed at `origin + offset` for each `[offset, code]`, as one run of bytes from `origin` (gaps are 0). */
export function placeCode(parts: readonly (readonly [number, readonly number[]])[]): number[] {
  const end = Math.max(...parts.map(([at, code]) => at + code.length));
  const out = new Array<number>(end).fill(0);
  for (const [at, code] of parts) code.forEach((b, i) => (out[at + i] = b));
  return out;
}
