/**
 * FastTracker 2 (.xm) parser.
 *
 * Scope: the structure needed to play a module -- header, packed pattern
 * data, instruments with their sample keymaps and envelopes, and delta-decoded
 * 8/16-bit sample data. It deliberately stays close to the file layout and
 * makes no interpretation decisions; mapping to the tracker's own song model
 * happens later in the import layer.
 *
 * Layout reference: the XM 1.04 spec (ftp.modland.com / "The Unofficial XM
 * File Format Specification"). Offsets below are quoted from it directly so
 * they can be checked without the document to hand.
 */

const XM_SIGNATURE = 'Extended Module: ';
const XM_HEADER_OFFSET = 60; // header size field is measured from here
const XM_MIN_SIZE = 336; // signature + header + a 256-entry order table

/** Notes are 1..96 (C-0..B-7); 97 is key-off. */
export const XM_KEY_OFF = 97;
export const XM_MAX_NOTE = 96;

export interface XmEnvelopePoint {
  /** Frame position of this point. */
  frame: number;
  /** Value at this point: 0..64 for volume, 0..64 for panning (32 = centre). */
  value: number;
}

export interface XmEnvelope {
  points: XmEnvelopePoint[];
  sustainPoint: number;
  loopStart: number;
  loopEnd: number;
  enabled: boolean;
  sustainEnabled: boolean;
  loopEnabled: boolean;
}

export type XmLoopType = 'none' | 'forward' | 'pingpong';

export interface XmSample {
  name: string;
  /** Length in frames (not bytes). */
  length: number;
  /** Loop start in frames. */
  loopStart: number;
  /** Loop length in frames. */
  loopLength: number;
  loopType: XmLoopType;
  /** 0..64 */
  volume: number;
  /** -128..127, in 1/128ths of a semitone. */
  finetune: number;
  /** 0..255, 128 = centre. */
  panning: number;
  /** Semitone offset applied to played notes. */
  relativeNote: number;
  bits: 8 | 16;
  /** Decoded PCM, normalised to -1..1. */
  data: Float32Array;
}

export interface XmInstrument {
  name: string;
  /** Maps note 0..95 to an index into `samples`. */
  keymap: number[];
  samples: XmSample[];
  volumeEnvelope: XmEnvelope;
  panningEnvelope: XmEnvelope;
  volumeFadeout: number;
  vibratoType: number;
  vibratoSweep: number;
  vibratoDepth: number;
  vibratoRate: number;
}

export interface XmPatternCell {
  /** 0 = empty, 1..96 = note, 97 = key off. */
  note: number;
  /** 0 = none, else 1-based instrument number. */
  instrument: number;
  /** 0 = none; otherwise an FT2 volume-column command byte. */
  volumeColumn: number;
  effectType: number;
  effectParam: number;
}

export interface XmPattern {
  rows: XmPatternCell[][];
  numRows: number;
}

export interface XmSong {
  title: string;
  trackerName: string;
  version: number;
  numChannels: number;
  songLength: number;
  restartPosition: number;
  orders: number[];
  patterns: XmPattern[];
  instruments: XmInstrument[];
  /** false = Amiga period table, true = linear frequency table. */
  linearFrequency: boolean;
  /** Ticks per row. */
  defaultSpeed: number;
  defaultBpm: number;
}

function readAscii(buffer: Uint8Array, offset: number, length: number): string {
  let result = '';
  const end = Math.min(offset + length, buffer.length);
  for (let i = offset; i < end; i++) {
    const code = buffer[i] ?? 0;
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result.trimEnd();
}

/** Heuristic check for an XM file. */
export function looksLikeXm(buffer: Uint8Array): boolean {
  if (buffer.byteLength < XM_MIN_SIZE) return false;
  if (readAscii(buffer, 0, XM_SIGNATURE.length) !== XM_SIGNATURE.trimEnd()) {
    // The signature is padded with a space, so compare it verbatim too.
    for (let i = 0; i < XM_SIGNATURE.length; i++) {
      if (buffer[i] !== XM_SIGNATURE.charCodeAt(i)) return false;
    }
  }
  // Byte 37 is a literal 0x1A ("end of file" marker) in every valid XM.
  return buffer[37] === 0x1a;
}

/**
 * Decode delta-encoded PCM into normalised floats.
 *
 * XM stores samples as running deltas rather than absolute values, so each
 * frame is the accumulated sum. Accumulation wraps within the sample's word
 * size -- relying on JavaScript's wider integers instead would let the value
 * drift out of range and clip audibly on long samples.
 */
function decodeDeltaSample(
  buffer: Uint8Array,
  offset: number,
  lengthBytes: number,
  bits: 8 | 16,
): Float32Array {
  if (bits === 16) {
    const frames = Math.floor(lengthBytes / 2);
    const out = new Float32Array(frames);
    let running = 0;
    for (let i = 0; i < frames; i++) {
      const lo = buffer[offset + i * 2] ?? 0;
      const hi = buffer[offset + i * 2 + 1] ?? 0;
      const delta = (hi << 8) | lo;
      running = (running + delta) & 0xffff;
      // Interpret the accumulated 16-bit value as signed.
      const signed = running >= 0x8000 ? running - 0x10000 : running;
      out[i] = signed / 32768;
    }
    return out;
  }

  const out = new Float32Array(lengthBytes);
  let running = 0;
  for (let i = 0; i < lengthBytes; i++) {
    running = (running + (buffer[offset + i] ?? 0)) & 0xff;
    const signed = running >= 0x80 ? running - 0x100 : running;
    out[i] = signed / 128;
  }
  return out;
}

function readEnvelope(
  buffer: Uint8Array,
  view: DataView,
  pointsOffset: number,
  numPoints: number,
  sustainPoint: number,
  loopStart: number,
  loopEnd: number,
  typeFlags: number,
): XmEnvelope {
  const points: XmEnvelopePoint[] = [];
  const clampedCount = Math.max(0, Math.min(12, numPoints));
  for (let i = 0; i < clampedCount; i++) {
    const at = pointsOffset + i * 4;
    if (at + 4 > buffer.byteLength) break;
    points.push({
      frame: view.getUint16(at, true),
      value: view.getUint16(at + 2, true),
    });
  }
  return {
    points,
    sustainPoint,
    loopStart,
    loopEnd,
    // Bit 0 = envelope on, bit 1 = sustain, bit 2 = loop.
    enabled: (typeFlags & 0x01) !== 0,
    sustainEnabled: (typeFlags & 0x02) !== 0,
    loopEnabled: (typeFlags & 0x04) !== 0,
  };
}

function emptyEnvelope(): XmEnvelope {
  return {
    points: [],
    sustainPoint: 0,
    loopStart: 0,
    loopEnd: 0,
    enabled: false,
    sustainEnabled: false,
    loopEnabled: false,
  };
}

function decodePattern(
  buffer: Uint8Array,
  dataOffset: number,
  packedSize: number,
  numRows: number,
  numChannels: number,
): XmPatternCell[][] {
  const rows: XmPatternCell[][] = [];
  let at = dataOffset;
  const end = dataOffset + packedSize;

  for (let row = 0; row < numRows; row++) {
    const cells: XmPatternCell[] = [];
    for (let ch = 0; ch < numChannels; ch++) {
      const cell: XmPatternCell = {
        note: 0,
        instrument: 0,
        volumeColumn: 0,
        effectType: 0,
        effectParam: 0,
      };

      // A packed pattern of size 0 means "all cells empty"; so does running
      // off the end of a truncated one.
      if (packedSize > 0 && at < end) {
        const flags = buffer[at++] ?? 0;
        if (flags & 0x80) {
          // Packed: the low bits say which fields are present.
          if (flags & 0x01) cell.note = buffer[at++] ?? 0;
          if (flags & 0x02) cell.instrument = buffer[at++] ?? 0;
          if (flags & 0x04) cell.volumeColumn = buffer[at++] ?? 0;
          if (flags & 0x08) cell.effectType = buffer[at++] ?? 0;
          if (flags & 0x10) cell.effectParam = buffer[at++] ?? 0;
        } else {
          // Unpacked: the byte just read is the note, then four more follow.
          cell.note = flags;
          cell.instrument = buffer[at++] ?? 0;
          cell.volumeColumn = buffer[at++] ?? 0;
          cell.effectType = buffer[at++] ?? 0;
          cell.effectParam = buffer[at++] ?? 0;
        }
      }

      cells.push(cell);
    }
    rows.push(cells);
  }

  return rows;
}

export function parseXm(buffer: Uint8Array): XmSong {
  if (!looksLikeXm(buffer)) {
    throw new Error('Unsupported or invalid XM file');
  }

  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  const title = readAscii(buffer, 17, 20);
  const trackerName = readAscii(buffer, 38, 20);
  const version = view.getUint16(58, true);

  const headerSize = view.getUint32(XM_HEADER_OFFSET, true);
  const songLength = view.getUint16(64, true);
  const restartPosition = view.getUint16(66, true);
  const numChannels = view.getUint16(68, true);
  const numPatterns = view.getUint16(70, true);
  const numInstruments = view.getUint16(72, true);
  const flags = view.getUint16(74, true);
  const defaultSpeed = view.getUint16(76, true);
  const defaultBpm = view.getUint16(78, true);

  if (numChannels < 1 || numChannels > 32) {
    throw new Error(`Unsupported XM channel count ${numChannels}`);
  }

  const orders: number[] = [];
  for (let i = 0; i < 256; i++) {
    orders.push(buffer[80 + i] ?? 0);
  }

  // Pattern data begins after the (variable-length) header.
  let at = XM_HEADER_OFFSET + headerSize;

  const patterns: XmPattern[] = [];
  for (let p = 0; p < numPatterns; p++) {
    if (at + 9 > buffer.byteLength) break;
    const patternHeaderSize = view.getUint32(at, true);
    const numRows = view.getUint16(at + 5, true);
    const packedSize = view.getUint16(at + 7, true);
    const dataOffset = at + patternHeaderSize;

    patterns.push({
      numRows,
      rows: decodePattern(
        buffer,
        dataOffset,
        packedSize,
        numRows,
        numChannels,
      ),
    });

    at = dataOffset + packedSize;
  }

  const instruments: XmInstrument[] = [];
  for (let i = 0; i < numInstruments; i++) {
    if (at + 29 > buffer.byteLength) break;
    const instrumentHeaderSize = view.getUint32(at, true);
    const name = readAscii(buffer, at + 4, 22);
    const numSamples = view.getUint16(at + 27, true);

    let keymap: number[] = new Array(96).fill(0);
    let volumeEnvelope = emptyEnvelope();
    let panningEnvelope = emptyEnvelope();
    let volumeFadeout = 0;
    let vibratoType = 0;
    let vibratoSweep = 0;
    let vibratoDepth = 0;
    let vibratoRate = 0;
    let sampleHeaderSize = 40;

    if (numSamples > 0 && at + 243 <= buffer.byteLength) {
      sampleHeaderSize = view.getUint32(at + 29, true) || 40;
      keymap = Array.from({ length: 96 }, (_, n) => buffer[at + 33 + n] ?? 0);

      volumeEnvelope = readEnvelope(
        buffer,
        view,
        at + 129,
        buffer[at + 225] ?? 0,
        buffer[at + 227] ?? 0,
        buffer[at + 228] ?? 0,
        buffer[at + 229] ?? 0,
        buffer[at + 233] ?? 0,
      );
      panningEnvelope = readEnvelope(
        buffer,
        view,
        at + 177,
        buffer[at + 226] ?? 0,
        buffer[at + 230] ?? 0,
        buffer[at + 231] ?? 0,
        buffer[at + 232] ?? 0,
        buffer[at + 234] ?? 0,
      );

      vibratoType = buffer[at + 235] ?? 0;
      vibratoSweep = buffer[at + 236] ?? 0;
      vibratoDepth = buffer[at + 237] ?? 0;
      vibratoRate = buffer[at + 238] ?? 0;
      volumeFadeout = view.getUint16(at + 239, true);
    }

    // Sample headers follow the instrument header, then all of that
    // instrument's sample data in the same order.
    let sampleHeaderAt = at + instrumentHeaderSize;
    const headers: Array<Omit<XmSample, 'data'> & { lengthBytes: number }> = [];

    for (let sIdx = 0; sIdx < numSamples; sIdx++) {
      if (sampleHeaderAt + 18 > buffer.byteLength) break;
      const lengthBytes = view.getUint32(sampleHeaderAt, true);
      const loopStartBytes = view.getUint32(sampleHeaderAt + 4, true);
      const loopLengthBytes = view.getUint32(sampleHeaderAt + 8, true);
      const volume = buffer[sampleHeaderAt + 12] ?? 0;
      const finetuneRaw = buffer[sampleHeaderAt + 13] ?? 0;
      const type = buffer[sampleHeaderAt + 14] ?? 0;
      const panning = buffer[sampleHeaderAt + 15] ?? 128;
      const relativeRaw = buffer[sampleHeaderAt + 16] ?? 0;
      const sampleName = readAscii(buffer, sampleHeaderAt + 18, 22);

      const bits: 8 | 16 = (type & 0x10) !== 0 ? 16 : 8;
      const bytesPerFrame = bits === 16 ? 2 : 1;
      const loopBits = type & 0x03;
      const loopType: XmLoopType =
        loopBits === 1 ? 'forward' : loopBits === 2 ? 'pingpong' : 'none';

      headers.push({
        name: sampleName,
        lengthBytes,
        length: Math.floor(lengthBytes / bytesPerFrame),
        loopStart: Math.floor(loopStartBytes / bytesPerFrame),
        loopLength: Math.floor(loopLengthBytes / bytesPerFrame),
        loopType,
        volume,
        finetune: finetuneRaw >= 0x80 ? finetuneRaw - 0x100 : finetuneRaw,
        panning,
        relativeNote: relativeRaw >= 0x80 ? relativeRaw - 0x100 : relativeRaw,
        bits,
      });

      sampleHeaderAt += sampleHeaderSize;
    }

    let sampleDataAt = sampleHeaderAt;
    const samples: XmSample[] = headers.map((header) => {
      const { lengthBytes, ...rest } = header;
      const data =
        lengthBytes > 0 && sampleDataAt + lengthBytes <= buffer.byteLength
          ? decodeDeltaSample(buffer, sampleDataAt, lengthBytes, header.bits)
          : new Float32Array(0);
      sampleDataAt += lengthBytes;
      return { ...rest, data };
    });

    instruments.push({
      name,
      keymap,
      samples,
      volumeEnvelope,
      panningEnvelope,
      volumeFadeout,
      vibratoType,
      vibratoSweep,
      vibratoDepth,
      vibratoRate,
    });

    at = sampleDataAt;
  }

  return {
    title,
    trackerName,
    version,
    numChannels,
    songLength,
    restartPosition,
    orders,
    patterns,
    instruments,
    // Bit 0 of the flags word selects the frequency table.
    linearFrequency: (flags & 0x01) !== 0,
    defaultSpeed,
    defaultBpm,
  };
}
