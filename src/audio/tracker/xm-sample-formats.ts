/**
 * Sample files an XM instrument can be loaded from and saved to: WAV (and
 * anything the browser decodes), IFF 8SVX, AIFF and raw signed PCM. The Amiga
 * formats are shared with the ProTracker editor (`mod-sample-formats`); what
 * differs here is the 16-bit range, the rate (an XM sample's rate is its
 * relative note and finetune) and the larger size limit.
 */
import type { ModSample, XmSample } from '@another-synth/tracker-playback';
import {
  amigaFormatOf,
  parse8svx,
  parseAiff,
  write8svx,
} from 'src/audio/tracker/mod-sample-formats';
import { clampXmName, toWav, xmSampleRate } from 'src/audio/tracker/xm-sample-ops';

export type XmSampleFormatId = 'wav' | 'aiff' | '8svx' | 'raw';

export interface XmSampleFormat {
  id: XmSampleFormatId;
  label: string;
  extension: string;
}

export const XM_SAMPLE_FORMATS: readonly XmSampleFormat[] = [
  { id: 'wav', label: 'WAV', extension: '.wav' },
  { id: 'aiff', label: 'AIFF', extension: '.aiff' },
  { id: '8svx', label: 'IFF 8SVX', extension: '.iff' },
  { id: 'raw', label: 'Raw signed PCM', extension: '.raw' },
];

/** A decoded file. `rate` is absent for formats that carry none (they play natively at C-4). */
export interface LoadedXmSample {
  pcm: Float32Array;
  rate?: number;
  bits: 8 | 16;
  name?: string;
  loopStart?: number;
  loopLength?: number;
  /** 0-64. */
  volume?: number;
}

/**
 * Decode `bytes` when it is one of the formats read here; `null` means "give it
 * to the browser's audio decoder" (WAV, MP3, OGG ...). `rawBits` says how to
 * read a raw file.
 */
export function readXmSampleFile(bytes: Uint8Array, fileName: string, rawBits: 8 | 16): LoadedXmSample | null {
  const kind = amigaFormatOf(bytes, fileName);
  if (kind === 'aiff') {
    const aiff = parseAiff(bytes);
    return {
      pcm: aiff.pcm,
      rate: aiff.rate,
      bits: aiff.bits === 8 ? 8 : 16,
      ...(aiff.name ? { name: aiff.name } : {}),
      ...(aiff.loopLength ? { loopStart: aiff.loopStart ?? 0, loopLength: aiff.loopLength } : {}),
    };
  }
  if (kind === '8svx') {
    const loaded = parse8svx(bytes);
    return {
      pcm: Float32Array.from(loaded.data, (v) => v / 128),
      bits: 8,
      ...(loaded.name ? { name: loaded.name } : {}),
      ...(loaded.loopLength ? { loopStart: loaded.loopStart ?? 0, loopLength: loaded.loopLength } : {}),
      ...(loaded.volume !== undefined ? { volume: loaded.volume } : {}),
    };
  }
  if (kind === 'raw') {
    if (rawBits === 16) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const pcm = new Float32Array(Math.floor(bytes.length / 2));
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true) / 32768;
      return { pcm, bits: 16 };
    }
    return { pcm: Float32Array.from(bytes, (v) => (v >= 128 ? v - 256 : v) / 128), bits: 8 };
  }
  return null;
}

/** The sample's file name stem, as a legal instrument name. */
export function sampleNameFromFile(fileName: string): string {
  return clampXmName(fileName.replace(/\.[^.]+$/, ''));
}

const putText = (out: Uint8Array, at: number, text: string): void => {
  for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
};

/** 80-bit extended float, as an AIFF header holds the rate. */
function writeExtended(view: DataView, at: number, value: number): void {
  const exponent = Math.floor(Math.log2(value));
  view.setUint16(at, 16383 + exponent, false);
  view.setBigUint64(at + 2, BigInt(Math.round(value * 2 ** (63 - exponent))), false);
}

/** A mono AIFF at the sample's bit depth and C-4 rate, with a forward loop as the sustain loop. */
export function writeXmAiff(sample: XmSample): Uint8Array {
  const rate = Math.round(xmSampleRate(sample));
  const bytesPer = sample.bits / 8;
  const name = new TextEncoder().encode(sample.name);
  const looping = sample.loopType !== 'none' && sample.loopLength >= 2;
  const n = sample.data.length;
  const pad = (len: number) => len + (len & 1);
  const markLength = 2 + 2 * (2 + 4 + 2);
  const dataBytes = n * bytesPer;
  const total =
    4 +
    (8 + 18) +
    (name.length ? 8 + pad(name.length) : 0) +
    (looping ? 8 + markLength + 8 + 20 : 0) +
    8 + 8 + pad(dataBytes);
  const out = new Uint8Array(8 + total);
  const view = new DataView(out.buffer);
  putText(out, 0, 'FORM');
  view.setUint32(4, total, false);
  putText(out, 8, 'AIFF');
  let p = 12;
  putText(out, p, 'COMM');
  view.setUint32(p + 4, 18, false);
  view.setUint16(p + 8, 1, false);
  view.setUint32(p + 10, n, false);
  view.setUint16(p + 14, sample.bits, false);
  writeExtended(view, p + 16, rate);
  p += 26;
  if (name.length) {
    putText(out, p, 'NAME');
    view.setUint32(p + 4, name.length, false);
    out.set(name, p + 8);
    p += 8 + pad(name.length);
  }
  if (looping) {
    putText(out, p, 'MARK');
    view.setUint32(p + 4, markLength, false);
    view.setUint16(p + 8, 2, false);
    view.setUint16(p + 10, 1, false);
    view.setUint32(p + 12, sample.loopStart, false);
    view.setUint16(p + 18, 2, false);
    view.setUint32(p + 20, sample.loopStart + sample.loopLength, false);
    p += 8 + markLength;
    putText(out, p, 'INST');
    view.setUint32(p + 4, 20, false);
    out[p + 8 + 2] = 127;
    view.setUint16(p + 8 + 8, 1, false);
    view.setUint16(p + 8 + 10, 1, false);
    view.setUint16(p + 8 + 12, 2, false);
    p += 28;
  }
  putText(out, p, 'SSND');
  view.setUint32(p + 4, 8 + dataBytes, false);
  for (let i = 0; i < n; i++) {
    if (sample.bits === 16) view.setInt16(p + 16 + i * 2, Math.max(-32768, Math.min(32767, Math.round(sample.data[i]! * 32768))), false);
    else view.setInt8(p + 16 + i, Math.max(-128, Math.min(127, Math.round(sample.data[i]! * 128))));
  }
  return out;
}

function toInt8(sample: XmSample): Int8Array {
  return Int8Array.from(sample.data, (v) => Math.max(-128, Math.min(127, Math.round(v * 128))));
}

/** The file's bytes for `sample` in the chosen format. */
export function writeXmSampleFile(id: XmSampleFormatId, sample: XmSample): Uint8Array {
  switch (id) {
    case 'wav':
      return toWav(sample);
    case 'aiff':
      return writeXmAiff(sample);
    case '8svx': {
      const looping = sample.loopType !== 'none' && sample.loopLength >= 2;
      const mod: ModSample = {
        name: sample.name,
        length: sample.data.length,
        finetune: 0,
        volume: sample.volume,
        loopStart: looping ? sample.loopStart : 0,
        loopLength: looping ? sample.loopLength : 0,
        data: toInt8(sample),
      };
      const bytes = write8svx(mod);
      // The writer assumes a module's C-2 rate; an XM sample's own rate goes in the VHDR.
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(32, Math.min(65535, Math.round(xmSampleRate(sample))), false);
      return bytes;
    }
    case 'raw': {
      if (sample.bits === 8) return Uint8Array.from(toInt8(sample), (v) => v & 0xff);
      const out = new Uint8Array(sample.data.length * 2);
      const view = new DataView(out.buffer);
      sample.data.forEach((v, i) => view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), true));
      return out;
    }
  }
}
