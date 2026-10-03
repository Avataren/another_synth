/**
 * The sample file formats of the Amiga: IFF 8SVX and raw signed 8-bit.
 *
 * Both are 8-bit mono, so a sample goes in and out without conversion: what the
 * file holds is what a .mod holds. 8SVX also carries the loop, a name and a
 * volume; raw carries only the bytes. (WAV and other PC formats go through the
 * browser's decoder and are resampled; see `fromPcm`.)
 */
import type { ModSample } from '@another-synth/tracker-playback';
import { MOD_MAX_SAMPLE_BYTES } from 'src/audio/tracker/mod-sample-codec';
import { clampModName } from 'src/audio/tracker/mod-sample-ops';

export type ModSampleFormatId = 'wav' | '8svx' | 'raw';

export interface ModSampleFormat {
  id: ModSampleFormatId;
  label: string;
  extension: string;
}

export const MOD_SAMPLE_FORMATS: readonly ModSampleFormat[] = [
  { id: '8svx', label: 'IFF 8SVX', extension: '.iff' },
  { id: 'raw', label: 'Raw 8-bit signed', extension: '.raw' },
  { id: 'wav', label: 'WAV', extension: '.wav' },
];

/** Extensions read as raw signed 8-bit (what ProTracker and OctaMED call a raw sample). */
export const RAW_EXTENSIONS = ['.raw', '.sam', '.smp', '.snd', '.sample', '.pcm'];

/** What the file said beyond the bytes; absent where the format has none. */
export interface ImportedAmigaSample {
  data: Int8Array;
  name?: string;
  loopStart?: number;
  loopLength?: number;
  /** 0-64. */
  volume?: number;
}

const tag = (b: Uint8Array, at: number): string => String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);

export function looksLike8svx(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && tag(bytes, 0) === 'FORM' && tag(bytes, 8) === '8SVX';
}

/** Fibonacci-delta, the 8SVX compression: two nibbles a byte, each an index into this table. */
const FIB_DELTA = [-34, -21, -13, -8, -5, -3, -2, -1, 0, 1, 2, 3, 5, 8, 13, 21];

function decodeFibonacci(body: Uint8Array): Int8Array {
  const out = new Int8Array(Math.max(0, (body.length - 2) * 2));
  let value = (body[1] ?? 0) << 24 >> 24;
  let at = 0;
  for (let i = 2; i < body.length; i++) {
    for (const nibble of [(body[i]! >> 4) & 0xf, body[i]! & 0xf]) {
      value = Math.max(-128, Math.min(127, value + FIB_DELTA[nibble]!));
      out[at++] = value;
    }
  }
  return out;
}

/** The sample an IFF 8SVX file holds; throws a message for the user when it can't be read. */
export function parse8svx(bytes: Uint8Array): ImportedAmigaSample {
  if (!looksLike8svx(bytes)) throw new Error('not an IFF 8SVX file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let oneShot = 0;
  let repeat = 0;
  let octaves = 1;
  let compression = 0;
  let volume: number | undefined;
  let name: string | undefined;
  let body: Uint8Array | null = null;

  const end = Math.min(bytes.length, 8 + view.getUint32(4, false));
  let at = 12;
  while (at + 8 <= end) {
    const id = tag(bytes, at);
    const size = view.getUint32(at + 4, false);
    const start = at + 8;
    const chunkEnd = Math.min(bytes.length, start + size);
    if (id === 'VHDR' && size >= 20) {
      oneShot = view.getUint32(start, false);
      repeat = view.getUint32(start + 4, false);
      octaves = Math.max(1, bytes[start + 14] ?? 1);
      compression = bytes[start + 15] ?? 0;
      volume = Math.round((Math.min(0x10000, view.getUint32(start + 16, false)) / 0x10000) * 64);
    } else if (id === 'NAME') {
      name = clampModName(String.fromCharCode(...bytes.subarray(start, chunkEnd)).replace(/\0.*$/, '').trim());
    } else if (id === 'BODY') {
      body = bytes.subarray(start, chunkEnd);
    }
    at = start + size + (size & 1);
  }
  if (!body) throw new Error('the file has no sample data (BODY chunk)');
  if (compression > 1) throw new Error('this 8SVX compression is not supported');
  if (compression === 1 && octaves > 1) throw new Error('compressed multi-octave 8SVX is not supported');

  let data = compression === 1 ? decodeFibonacci(body) : Int8Array.from(body);
  let loopStart = 0;
  let loopLength = 0;
  // A multi-octave file holds the same sound at ever longer lengths, shortest
  // first; take the longest, as it has the most detail.
  const base = oneShot + repeat;
  if (octaves > 1 && base > 0) {
    const scale = 2 ** (octaves - 1);
    const offset = base * (scale - 1);
    data = data.slice(offset, offset + base * scale);
    oneShot *= scale;
    repeat *= scale;
  } else if (base > 0 && base < data.length) {
    data = data.slice(0, base);
  }
  if (repeat > 2) {
    loopStart = oneShot;
    loopLength = repeat;
  }
  if (data.length > MOD_MAX_SAMPLE_BYTES) throw new Error(`the sample is ${data.length} bytes; a .mod holds at most ${MOD_MAX_SAMPLE_BYTES}`);
  return { data, ...(name ? { name } : {}), loopStart, loopLength, ...(volume !== undefined ? { volume } : {}) };
}

/** An uncompressed 8SVX file for `sample`, at the rate C-2 plays it at. */
export function write8svx(sample: ModSample): Uint8Array {
  const rate = Math.round(3546895 / 428);
  const name = new TextEncoder().encode(sample.name);
  const looping = sample.loopLength > 2;
  // 8SVX's body is the one-shot part plus the repeat part; bytes past a loop's
  // end are never played (in a .mod either), so they are not written.
  const bodyLength = looping ? sample.loopStart + sample.loopLength : sample.data.length;
  const pad = (n: number) => n + (n & 1);
  const total = 4 + (8 + 20) + (name.length ? 8 + pad(name.length) : 0) + 8 + pad(bodyLength);
  const out = new Uint8Array(8 + total);
  const view = new DataView(out.buffer);
  const put = (at: number, text: string) => [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  put(0, 'FORM');
  view.setUint32(4, total, false);
  put(8, '8SVX');
  let at = 12;
  put(at, 'VHDR');
  view.setUint32(at + 4, 20, false);
  view.setUint32(at + 8, looping ? sample.loopStart : bodyLength, false);
  view.setUint32(at + 12, looping ? sample.loopLength : 0, false);
  view.setUint32(at + 16, 0, false); // samples per cycle: unknown
  view.setUint16(at + 20, rate, false);
  out[at + 22] = 1; // one octave
  out[at + 23] = 0; // uncompressed
  view.setUint32(at + 24, Math.round((Math.max(0, Math.min(64, sample.volume)) / 64) * 0x10000), false);
  at += 28;
  if (name.length) {
    put(at, 'NAME');
    view.setUint32(at + 4, name.length, false);
    out.set(name, at + 8);
    at += 8 + pad(name.length);
  }
  put(at, 'BODY');
  view.setUint32(at + 4, bodyLength, false);
  for (let i = 0; i < bodyLength; i++) out[at + 8 + i] = sample.data[i]! & 0xff;
  return out;
}

/** Any bytes as raw signed 8-bit, whole words only. */
export function parseRaw(bytes: Uint8Array): ImportedAmigaSample {
  if (bytes.length > MOD_MAX_SAMPLE_BYTES) throw new Error(`the file is ${bytes.length} bytes; a .mod sample holds at most ${MOD_MAX_SAMPLE_BYTES}`);
  return { data: Int8Array.from(bytes) };
}

export function writeRaw(sample: ModSample): Uint8Array {
  return Uint8Array.from(sample.data, (v) => v & 0xff);
}

/** The format a file is, by its bytes first and its name second; `null` for anything else (the browser decodes it). */
export function amigaFormatOf(bytes: Uint8Array, fileName: string): '8svx' | 'raw' | null {
  if (looksLike8svx(bytes)) return '8svx';
  const lower = fileName.toLowerCase();
  if (RAW_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'raw';
  return null;
}
