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

export type ModSampleFormatId = 'wav' | '8svx' | 'aiff' | 'raw';

export interface ModSampleFormat {
  id: ModSampleFormatId;
  label: string;
  extension: string;
}

export const MOD_SAMPLE_FORMATS: readonly ModSampleFormat[] = [
  { id: '8svx', label: 'IFF 8SVX', extension: '.iff' },
  { id: 'aiff', label: 'AIFF', extension: '.aiff' },
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
export function amigaFormatOf(bytes: Uint8Array, fileName: string): '8svx' | 'aiff' | 'raw' | null {
  if (looksLike8svx(bytes)) return '8svx';
  if (looksLikeAiff(bytes)) return 'aiff';
  const lower = fileName.toLowerCase();
  if (RAW_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'raw';
  return null;
}

// ---- AIFF -----------------------------------------------------------------

export function looksLikeAiff(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && tag(bytes, 0) === 'FORM' && (tag(bytes, 8) === 'AIFF' || tag(bytes, 8) === 'AIFC');
}

/** An IEEE 754 80-bit extended float, big-endian: how AIFF stores its sample rate. */
function readExtended(view: DataView, at: number): number {
  const exponent = view.getUint16(at, false);
  const sign = exponent & 0x8000 ? -1 : 1;
  const mantissa = view.getBigUint64(at + 2, false);
  if ((exponent & 0x7fff) === 0 && mantissa === 0n) return 0;
  return sign * Number(mantissa) * 2 ** ((exponent & 0x7fff) - 16383 - 63);
}

function writeExtended(view: DataView, at: number, value: number): void {
  if (value <= 0) {
    for (let i = 0; i < 10; i++) view.setUint8(at + i, 0);
    return;
  }
  const exponent = Math.floor(Math.log2(value));
  view.setUint16(at, 16383 + exponent, false);
  view.setBigUint64(at + 2, BigInt(Math.round(value * 2 ** (63 - exponent))), false);
}

export interface ParsedAiff {
  /** Mono, -1..1 (channels mixed down). */
  pcm: Float32Array;
  rate: number;
  bits: number;
  channels: number;
  /** The sample as raw signed bytes, when the file is already 8-bit mono. */
  data8?: Int8Array;
  name?: string;
  loopStart?: number;
  loopLength?: number;
}

/** An AIFF file's audio and sustain loop; throws a message for the user when it can't be read. */
export function parseAiff(bytes: Uint8Array): ParsedAiff {
  if (!looksLikeAiff(bytes)) throw new Error('not an AIFF file');
  if (tag(bytes, 8) === 'AIFC') throw new Error('compressed AIFF (AIFC) is not supported');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let channels = 0;
  let frames = 0;
  let bits = 0;
  let rate = 0;
  let sound: Uint8Array | null = null;
  let name: string | undefined;
  const markers = new Map<number, number>();
  let loop: [number, number] | null = null;

  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(bytes, at);
    const size = view.getUint32(at + 4, false);
    const start = at + 8;
    const end = Math.min(bytes.length, start + size);
    if (id === 'COMM' && size >= 18) {
      channels = view.getUint16(start, false);
      frames = view.getUint32(start + 2, false);
      bits = view.getUint16(start + 6, false);
      rate = readExtended(view, start + 8);
    } else if (id === 'SSND') {
      const offset = view.getUint32(start, false);
      sound = bytes.subarray(start + 8 + offset, end);
    } else if (id === 'NAME') {
      name = clampModName(String.fromCharCode(...bytes.subarray(start, end)).replace(/\0.*$/, '').trim());
    } else if (id === 'MARK') {
      let p = start + 2;
      const count = view.getUint16(start, false);
      for (let i = 0; i < count && p + 7 <= end; i++) {
        markers.set(view.getUint16(p, false), view.getUint32(p + 2, false));
        const nameLength = bytes[p + 6] ?? 0;
        p += 7 + nameLength + ((nameLength + 1) & 1); // pstring, padded to even
      }
    } else if (id === 'INST' && size >= 20) {
      // sustain loop: playMode(2) beginMarker(2) endMarker(2) at offset 8
      if (view.getUint16(start + 8, false) !== 0) loop = [view.getUint16(start + 10, false), view.getUint16(start + 12, false)];
    }
    at = start + size + (size & 1);
  }
  if (!channels || !bits || !sound) throw new Error('the file has no readable sound data');
  if (bits !== 8 && bits !== 16 && bits !== 24) throw new Error(`${bits}-bit AIFF is not supported`);

  const bytesPer = bits / 8;
  const count = Math.min(frames, Math.floor(sound.length / (bytesPer * channels)));
  const pcm = new Float32Array(count);
  const data8 = bits === 8 && channels === 1 ? new Int8Array(count) : undefined;
  const sv = new DataView(sound.buffer, sound.byteOffset, sound.byteLength);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytesPer;
      sum += bits === 8 ? sv.getInt8(p) / 128 : bits === 16 ? sv.getInt16(p, false) / 32768 : ((sv.getInt8(p) << 16) | (sv.getUint8(p + 1) << 8) | sv.getUint8(p + 2)) / 8388608;
    }
    pcm[i] = sum / channels;
    if (data8) data8[i] = sv.getInt8(i);
  }
  const result: ParsedAiff = { pcm, rate, bits, channels, ...(data8 ? { data8 } : {}), ...(name ? { name } : {}) };
  const begin = loop ? markers.get(loop[0]) : undefined;
  const finish = loop ? markers.get(loop[1]) : undefined;
  if (begin !== undefined && finish !== undefined && finish - begin > 2) {
    result.loopStart = begin;
    result.loopLength = finish - begin;
  }
  return result;
}

/** An 8-bit mono AIFF for `sample`, at the rate C-2 plays it at, with its loop as the sustain loop. */
export function writeAiff(sample: ModSample): Uint8Array {
  const rate = Math.round(3546895 / 428);
  const name = new TextEncoder().encode(sample.name);
  const looping = sample.loopLength > 2;
  const n = sample.data.length;
  const pad = (len: number) => len + (len & 1);
  const markLength = 2 + 2 * (2 + 4 + 2); // count + two markers with empty pstring names
  const total =
    4 +
    (8 + 18) +
    (name.length ? 8 + pad(name.length) : 0) +
    (looping ? 8 + 20 + 8 + markLength : 0) +
    8 + 8 + pad(n);
  const out = new Uint8Array(8 + total);
  const view = new DataView(out.buffer);
  const put = (p: number, text: string) => [...text].forEach((c, i) => (out[p + i] = c.charCodeAt(0)));
  put(0, 'FORM');
  view.setUint32(4, total, false);
  put(8, 'AIFF');
  let p = 12;
  put(p, 'COMM');
  view.setUint32(p + 4, 18, false);
  view.setUint16(p + 8, 1, false);
  view.setUint32(p + 10, n, false);
  view.setUint16(p + 14, 8, false);
  writeExtended(view, p + 16, rate);
  p += 26;
  if (name.length) {
    put(p, 'NAME');
    view.setUint32(p + 4, name.length, false);
    out.set(name, p + 8);
    p += 8 + pad(name.length);
  }
  if (looping) {
    put(p, 'MARK');
    view.setUint32(p + 4, markLength, false);
    view.setUint16(p + 8, 2, false);
    view.setUint16(p + 10, 1, false);
    view.setUint32(p + 12, sample.loopStart, false);
    out[p + 16] = 0; // empty name, padded to even
    view.setUint16(p + 18, 2, false);
    view.setUint32(p + 20, sample.loopStart + sample.loopLength, false);
    p += 8 + markLength;
    put(p, 'INST');
    view.setUint32(p + 4, 20, false);
    out[p + 8 + 2] = 127; // high note
    view.setUint16(p + 8 + 8, 1, false); // sustain loop: forward
    view.setUint16(p + 8 + 10, 1, false);
    view.setUint16(p + 8 + 12, 2, false);
    p += 28;
  }
  put(p, 'SSND');
  view.setUint32(p + 4, 8 + n, false);
  sample.data.forEach((v, i) => (out[p + 16 + i] = v & 0xff));
  return out;
}
