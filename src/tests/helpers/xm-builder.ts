/**
 * Builds synthetic XM files to the 1.04 spec's offsets, so the parser and the
 * importer can both be tested without checking a real (copyrighted) module
 * into the repo. Shared by xm-parser.test.ts and xm-import.test.ts.
 *
 * Header sizes are measured from the buffer rather than hand-counted -- an
 * earlier version computed the instrument header as 241 bytes when it is 243,
 * which silently pushed every sample header two bytes late.
 */
import type { XmPatternCell } from '../../../packages/tracker-playback/src/formats/xm';

const XM_SIGNATURE = 'Extended Module: ';

export interface SampleSpec {
  /** Absolute PCM frames; the builder delta-encodes them. */
  frames: number[];
  bits?: 8 | 16;
  volume?: number;
  finetune?: number;
  relativeNote?: number;
  panning?: number;
  /** 0 none, 1 forward, 2 pingpong */
  loopType?: number;
  loopStartFrames?: number;
  loopLengthFrames?: number;
  name?: string;
}

export interface InstrumentSpec {
  name?: string;
  samples?: SampleSpec[];
  keymap?: number[];
  volumeFadeout?: number;
  volumeEnvelope?: { points: Array<[number, number]>; type?: number; sustain?: number };
  /** Instrument-level vibrato (XM autovibrato). */
  autoVibrato?: { type?: number; sweep?: number; depth?: number; rate?: number };
}

export interface XmSpec {
  title?: string;
  numChannels?: number;
  linearFrequency?: boolean;
  speed?: number;
  bpm?: number;
  orders?: number[];
  songLength?: number;
  /** patterns[p][row][channel] */
  patterns?: Array<{ numRows: number; cells: XmPatternCell[][]; packed?: boolean }>;
  instruments?: InstrumentSpec[];
}

class ByteWriter {
  private bytes: number[] = [];

  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    return this;
  }
  ascii(text: string, length: number) {
    for (let i = 0; i < length; i++) {
      this.bytes.push(i < text.length ? text.charCodeAt(i) : 0);
    }
    return this;
  }
  raw(values: number[]) {
    for (const v of values) this.bytes.push(v & 0xff);
    return this;
  }
  get length() {
    return this.bytes.length;
  }
  toUint8Array() {
    return new Uint8Array(this.bytes);
  }
}

/** Delta-encode absolute frames the way XM stores them. */
function deltaEncode(frames: number[], bits: 8 | 16): number[] {
  const out: number[] = [];
  let previous = 0;
  for (const frame of frames) {
    const delta = frame - previous;
    previous = frame;
    if (bits === 16) {
      out.push(delta & 0xff, (delta >> 8) & 0xff);
    } else {
      out.push(delta & 0xff);
    }
  }
  return out;
}

export function emptyCell(): XmPatternCell {
  return { note: 0, instrument: 0, volumeColumn: 0, effectType: 0, effectParam: 0 };
}

export function buildXm(spec: XmSpec): Uint8Array {
  const numChannels = spec.numChannels ?? 4;
  const patterns = spec.patterns ?? [];
  const instruments = spec.instruments ?? [];
  const orders = spec.orders ?? [0];

  const w = new ByteWriter();
  w.ascii(XM_SIGNATURE, 17);
  w.ascii(spec.title ?? 'TEST XM', 20);
  w.u8(0x1a);
  w.ascii('FastTracker v2.00', 20);
  w.u16(0x0104);
  // Header size is measured from offset 60 and covers through the order table.
  w.u32(20 + 256);
  w.u16(spec.songLength ?? orders.length);
  w.u16(0); // restart position
  w.u16(numChannels);
  w.u16(patterns.length);
  w.u16(instruments.length);
  w.u16(spec.linearFrequency === false ? 0 : 1);
  w.u16(spec.speed ?? 6);
  w.u16(spec.bpm ?? 125);
  for (let i = 0; i < 256; i++) w.u8(orders[i] ?? 0);

  for (const pattern of patterns) {
    const data: number[] = [];
    for (let row = 0; row < pattern.numRows; row++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const cell = pattern.cells[row]?.[ch] ?? emptyCell();
        if (pattern.packed === false) {
          // Unpacked: note byte with the high bit clear, then four more.
          data.push(
            cell.note & 0x7f,
            cell.instrument,
            cell.volumeColumn,
            cell.effectType,
            cell.effectParam,
          );
        } else {
          let flags = 0x80;
          const payload: number[] = [];
          if (cell.note) {
            flags |= 0x01;
            payload.push(cell.note);
          }
          if (cell.instrument) {
            flags |= 0x02;
            payload.push(cell.instrument);
          }
          if (cell.volumeColumn) {
            flags |= 0x04;
            payload.push(cell.volumeColumn);
          }
          if (cell.effectType) {
            flags |= 0x08;
            payload.push(cell.effectType);
          }
          if (cell.effectParam) {
            flags |= 0x10;
            payload.push(cell.effectParam);
          }
          data.push(flags, ...payload);
        }
      }
    }

    w.u32(9); // pattern header length
    w.u8(0); // packing type
    w.u16(pattern.numRows);
    w.u16(data.length);
    w.raw(data);
  }

  for (const instrument of instruments) {
    const samples = instrument.samples ?? [];
    const instrumentHeaderSize = 263;
    const instrumentStart = w.length;

    w.u32(instrumentHeaderSize);
    w.ascii(instrument.name ?? '', 22);
    w.u8(0); // type
    w.u16(samples.length);

    // 29..: only present when the instrument has samples, but the builder
    // always writes the full header so sizes stay predictable.
    w.u32(40); // sample header size
    const keymap = instrument.keymap ?? new Array(96).fill(0);
    for (let n = 0; n < 96; n++) w.u8(keymap[n] ?? 0);

    const volPoints = instrument.volumeEnvelope?.points ?? [];
    for (let i = 0; i < 12; i++) {
      w.u16(volPoints[i]?.[0] ?? 0);
      w.u16(volPoints[i]?.[1] ?? 0);
    }
    for (let i = 0; i < 12; i++) {
      w.u16(0);
      w.u16(0);
    }
    w.u8(volPoints.length); // number of volume points
    w.u8(0); // number of panning points
    w.u8(instrument.volumeEnvelope?.sustain ?? 0);
    w.u8(0); // volume loop start
    w.u8(0); // volume loop end
    w.u8(0); // panning sustain
    w.u8(0); // panning loop start
    w.u8(0); // panning loop end
    w.u8(instrument.volumeEnvelope?.type ?? 0);
    w.u8(0); // panning type
    w.u8(instrument.autoVibrato?.type ?? 0); // vibrato type
    w.u8(instrument.autoVibrato?.sweep ?? 0); // vibrato sweep
    w.u8(instrument.autoVibrato?.depth ?? 0); // vibrato depth
    w.u8(instrument.autoVibrato?.rate ?? 0); // vibrato rate
    w.u16(instrument.volumeFadeout ?? 0);
    w.u16(0); // reserved
    // Pad to the declared instrument header size, measured from where this
    // instrument began rather than from a hand-counted field total.
    while (w.length - instrumentStart < instrumentHeaderSize) w.u8(0);

    const encoded: number[][] = [];
    for (const sample of samples) {
      const bits = sample.bits ?? 8;
      const bytesPerFrame = bits === 16 ? 2 : 1;
      const body = deltaEncode(sample.frames, bits);
      encoded.push(body);

      w.u32(sample.frames.length * bytesPerFrame); // length in bytes
      w.u32((sample.loopStartFrames ?? 0) * bytesPerFrame);
      w.u32((sample.loopLengthFrames ?? 0) * bytesPerFrame);
      w.u8(sample.volume ?? 64);
      w.u8(sample.finetune ?? 0);
      w.u8((sample.loopType ?? 0) | (bits === 16 ? 0x10 : 0));
      w.u8(sample.panning ?? 128);
      w.u8(sample.relativeNote ?? 0);
      w.u8(0); // reserved
      w.ascii(sample.name ?? '', 22);
    }

    for (const body of encoded) w.raw(body);
  }

  return w.toUint8Array();
}


/** Convenience for building a single cell. */
export function cell(
  note: number,
  extra: Partial<XmPatternCell> = {},
): XmPatternCell {
  return { ...emptyCell(), note, ...extra };
}
