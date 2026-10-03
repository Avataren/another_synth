/**
 * FastTracker 2 (.xm) writer: the inverse of `parseXm`.
 *
 * Takes the parser's own model (`XmSong`) and lays it out as a version 1.04
 * file -- header, packed patterns, instruments with their sample headers,
 * delta-encoded sample data. Decisions about what an app's song becomes in
 * that model belong to the exporter; this only serialises.
 */
import type {
  XmEnvelope,
  XmInstrument,
  XmPatternCell,
  XmSample,
  XmSong,
} from './formats/xm';

const SIGNATURE = 'Extended Module: ';
const XM_VERSION = 0x0104;
/** What FT2 writes there. Players apply FT2's quirks to a file that says so. */
export const FT2_TRACKER_NAME = 'FastTracker v2.00';
const MODULE_HEADER_SIZE = 276;
const INSTRUMENT_HEADER_SIZE = 263;
const SAMPLE_HEADER_SIZE = 40;

export const XM_MAX_CHANNELS = 32;
export const XM_MAX_PATTERNS = 256;
export const XM_MAX_INSTRUMENTS = 128;
export const XM_MAX_SAMPLES_PER_INSTRUMENT = 16;
export const XM_MAX_ENVELOPE_POINTS = 12;

class ByteSink {
  private chunks: number[] = [];
  u8(v: number): void {
    this.chunks.push(v & 0xff);
  }
  u16(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v: number): void {
    this.u16(v);
    this.u16(v >>> 16);
  }
  /** Fixed-width text, padded with spaces as FastTracker 2 pads it (players key on that). */
  text(value: string, length: number, pad = 0x20): void {
    for (let i = 0; i < length; i++) {
      const code = value.charCodeAt(i);
      this.u8(i < value.length && code >= 32 && code < 256 ? code : pad);
    }
  }
  zeros(count: number): void {
    for (let i = 0; i < count; i++) this.u8(0);
  }
  bytes(data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i++) this.u8(data[i]!);
  }
  get length(): number {
    return this.chunks.length;
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/** Pack one pattern's cells the way FT2 does: a flag byte, then only what is set. */
export function packXmPattern(rows: XmPatternCell[][], numChannels: number): Uint8Array {
  const out: number[] = [];
  for (const row of rows) {
    for (let ch = 0; ch < numChannels; ch++) {
      const c = row[ch];
      const note = c?.note ?? 0;
      const instrument = c?.instrument ?? 0;
      const volume = c?.volumeColumn ?? 0;
      const type = c?.effectType ?? 0;
      const param = c?.effectParam ?? 0;
      let flags = 0x80;
      if (note) flags |= 0x01;
      if (instrument) flags |= 0x02;
      if (volume) flags |= 0x04;
      if (type) flags |= 0x08;
      if (param) flags |= 0x10;
      out.push(flags);
      if (note) out.push(note & 0xff);
      if (instrument) out.push(instrument & 0xff);
      if (volume) out.push(volume & 0xff);
      if (type) out.push(type & 0xff);
      if (param) out.push(param & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function envelopeType(env: XmEnvelope): number {
  return (env.enabled ? 1 : 0) | (env.sustainEnabled ? 2 : 0) | (env.loopEnabled ? 4 : 0);
}

function writeEnvelopePoints(sink: ByteSink, env: XmEnvelope): void {
  for (let i = 0; i < XM_MAX_ENVELOPE_POINTS; i++) {
    const p = env.points[i];
    sink.u16(p?.frame ?? 0);
    sink.u16(p?.value ?? 0);
  }
}

function sampleTypeBits(sample: XmSample): number {
  const loop = sample.loopType === 'forward' ? 1 : sample.loopType === 'pingpong' ? 2 : 0;
  return loop | (sample.bits === 16 ? 0x10 : 0);
}

/** Delta-encode a sample's PCM at its own word size. */
export function encodeXmSampleData(sample: XmSample): Uint8Array {
  const frames = sample.data.length;
  if (sample.bits === 16) {
    const out = new Uint8Array(frames * 2);
    let previous = 0;
    for (let i = 0; i < frames; i++) {
      const value = Math.max(-32768, Math.min(32767, Math.round(sample.data[i]! * 32768)));
      const delta = (value - previous) & 0xffff;
      out[i * 2] = delta & 0xff;
      out[i * 2 + 1] = delta >> 8;
      previous = value;
    }
    return out;
  }
  const out = new Uint8Array(frames);
  let previous = 0;
  for (let i = 0; i < frames; i++) {
    const value = Math.max(-128, Math.min(127, Math.round(sample.data[i]! * 128)));
    out[i] = (value - previous) & 0xff;
    previous = value;
  }
  return out;
}

function writeInstrument(sink: ByteSink, instrument: XmInstrument): void {
  const samples = instrument.samples.slice(0, XM_MAX_SAMPLES_PER_INSTRUMENT);
  const count = samples.length;
  // An empty instrument's header still ends with the sample header size
  // field (33 bytes): FT2 writes it, and OpenMPT reads one without as damaged.
  const emptySize = instrument.emptyHeaderSize === 29 ? 29 : 33;
  sink.u32(count > 0 ? INSTRUMENT_HEADER_SIZE : emptySize);
  sink.text(instrument.name, 22);
  sink.u8(0);
  sink.u16(count);
  if (count === 0) {
    if (emptySize === 33) sink.u32(SAMPLE_HEADER_SIZE);
    return;
  }

  sink.u32(SAMPLE_HEADER_SIZE);
  for (let n = 0; n < 96; n++) {
    sink.u8(Math.min(count - 1, instrument.keymap[n] ?? 0));
  }
  const vol = instrument.volumeEnvelope;
  const pan = instrument.panningEnvelope;
  writeEnvelopePoints(sink, vol);
  writeEnvelopePoints(sink, pan);
  sink.u8(Math.min(XM_MAX_ENVELOPE_POINTS, vol.points.length));
  sink.u8(Math.min(XM_MAX_ENVELOPE_POINTS, pan.points.length));
  sink.u8(vol.sustainPoint);
  sink.u8(vol.loopStart);
  sink.u8(vol.loopEnd);
  sink.u8(pan.sustainPoint);
  sink.u8(pan.loopStart);
  sink.u8(pan.loopEnd);
  sink.u8(envelopeType(vol));
  sink.u8(envelopeType(pan));
  sink.u8(instrument.vibratoType);
  sink.u8(instrument.vibratoSweep);
  sink.u8(instrument.vibratoDepth);
  sink.u8(instrument.vibratoRate);
  sink.u16(instrument.volumeFadeout);
  sink.zeros(INSTRUMENT_HEADER_SIZE - 241);

  const encoded = samples.map(encodeXmSampleData);
  samples.forEach((sample, i) => {
    const bytesPerFrame = sample.bits === 16 ? 2 : 1;
    sink.u32(encoded[i]!.length);
    sink.u32(sample.loopStart * bytesPerFrame);
    sink.u32(sample.loopLength * bytesPerFrame);
    sink.u8(sample.volume);
    sink.u8(sample.finetune);
    sink.u8(sampleTypeBits(sample));
    sink.u8(sample.panning);
    sink.u8(sample.relativeNote);
    sink.u8(sample.reserved ?? 0);
    sink.text(sample.name, 22);
  });
  for (const data of encoded) sink.bytes(data);
}

export function writeXm(song: XmSong): Uint8Array {
  const sink = new ByteSink();
  const numChannels = Math.max(1, Math.min(XM_MAX_CHANNELS, song.numChannels));
  const patterns = song.patterns.slice(0, XM_MAX_PATTERNS);
  const instruments = song.instruments.slice(0, XM_MAX_INSTRUMENTS);

  sink.text(SIGNATURE, 17);
  sink.text(song.title, 20);
  sink.u8(0x1a);
  sink.text(song.trackerName || FT2_TRACKER_NAME, 20);
  sink.u16(XM_VERSION);
  sink.u32(MODULE_HEADER_SIZE);
  sink.u16(song.songLength);
  sink.u16(song.restartPosition);
  sink.u16(numChannels);
  sink.u16(patterns.length);
  sink.u16(instruments.length);
  sink.u16(song.linearFrequency ? 1 : 0);
  sink.u16(song.defaultSpeed);
  sink.u16(song.defaultBpm);
  for (let i = 0; i < 256; i++) sink.u8(song.orders[i] ?? 0);

  for (const pattern of patterns) {
    const packed = packXmPattern(pattern.rows, numChannels);
    sink.u32(9);
    sink.u8(0);
    sink.u16(pattern.numRows);
    sink.u16(packed.length);
    sink.bytes(packed);
  }
  for (const instrument of instruments) writeInstrument(sink, instrument);
  return sink.toBytes();
}
