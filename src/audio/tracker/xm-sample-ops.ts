/**
 * Edits to an XM instrument and its samples. Pure: each takes a value and
 * returns a new one, with loop points kept inside the data and PCM held on the
 * sample's own bit-depth grid (what is heard is what a .xm stores).
 */
import {
  XM_MAX_ENVELOPE_POINTS,
  XM_MAX_SAMPLES_PER_INSTRUMENT,
  emptyXmEnvelope,
  type XmEnvelope,
  type XmInstrument,
  type XmSample,
} from '@another-synth/tracker-playback';

export const XM_NAME_LENGTH = 22;
/** The rate a sample at relative note 0 plays at when C-4 is struck. */
export const XM_BASE_RATE = 8363;
/** FT2 will not load more than this, and it keeps a patch a sane size. */
export const XM_MAX_SAMPLE_FRAMES = 4_000_000;
/** Envelope frames run 0..324 in FT2's editor. */
export const XM_ENVELOPE_MAX_FRAME = 324;
export const XM_ENVELOPE_MAX_VALUE = 64;

export function clampXmName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[^\x20-\x7e]/g, '').slice(0, XM_NAME_LENGTH);
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Hold `data` on the 8- or 16-bit grid and inside -1..1. */
export function quantize(data: Float32Array, bits: 8 | 16): Float32Array {
  const scale = bits === 16 ? 32768 : 128;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = clamp(Math.round(data[i]! * scale), -scale, scale - 1) / scale;
  }
  return out;
}

export function emptyXmSample(name = '', bits: 8 | 16 = 8): XmSample {
  return {
    name,
    length: 0,
    loopStart: 0,
    loopLength: 0,
    loopType: 'none',
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
    bits,
    data: new Float32Array(0),
  };
}

export function emptyXmInstrument(name = ''): XmInstrument {
  return {
    name,
    keymap: new Array(96).fill(0),
    samples: [],
    volumeEnvelope: emptyXmEnvelope(),
    panningEnvelope: emptyXmEnvelope(),
    volumeFadeout: 0,
    vibratoType: 0,
    vibratoSweep: 0,
    vibratoDepth: 0,
    vibratoRate: 0,
  };
}

/** The instrument the "+" button makes: one looped square-wave sample. */
export function newXmInstrument(): XmInstrument {
  return { ...emptyXmInstrument(), samples: [generateWave(emptyXmSample(), 'square', 64)] };
}

// -- one sample -------------------------------------------------------------

/** Keep the loop inside the data; a loop of one frame or less is no loop. */
export function withLoop(sample: XmSample, start: number, length: number, type?: XmSample['loopType']): XmSample {
  const n = sample.data.length;
  const kind = type ?? (sample.loopType === 'none' ? 'forward' : sample.loopType);
  const loopStart = clamp(Math.round(start), 0, Math.max(0, n - 1));
  const loopLength = clamp(Math.round(length), 0, n - loopStart);
  if (n < 2 || loopLength < 2) return { ...sample, loopStart: 0, loopLength: 0, loopType: 'none' };
  return { ...sample, loopStart, loopLength, loopType: kind };
}

export function withoutLoop(sample: XmSample): XmSample {
  return { ...sample, loopStart: 0, loopLength: 0, loopType: 'none' };
}

/** The data replaced by `data` (on the sample's grid), loop re-fitted. */
export function withData(sample: XmSample, data: Float32Array): XmSample {
  const trimmed = data.length > XM_MAX_SAMPLE_FRAMES ? data.subarray(0, XM_MAX_SAMPLE_FRAMES) : data;
  const next = { ...sample, data: quantize(trimmed, sample.bits), length: trimmed.length };
  return sample.loopType !== 'none' && sample.loopLength >= 2
    ? withLoop(next, sample.loopStart, sample.loopLength, sample.loopType)
    : withoutLoop(next);
}

export function setBits(sample: XmSample, bits: 8 | 16): XmSample {
  return { ...sample, bits, data: quantize(sample.data, bits) };
}

export function normalize(sample: XmSample): XmSample {
  let peak = 0;
  for (const v of sample.data) peak = Math.max(peak, Math.abs(v));
  if (peak === 0 || peak >= 0.99) return sample;
  const gain = 0.99 / peak;
  return { ...sample, data: quantize(sample.data.map((v) => v * gain), sample.bits) };
}

export function reverse(sample: XmSample): XmSample {
  const data = Float32Array.from(sample.data).reverse();
  const looped = sample.loopType !== 'none' && sample.loopLength >= 2;
  const next = { ...sample, data };
  return looped
    ? withLoop(next, data.length - (sample.loopStart + sample.loopLength), sample.loopLength, sample.loopType)
    : next;
}

/** Every other frame: half the length, an octave up at the same note. */
export function halve(sample: XmSample): XmSample {
  const data = new Float32Array(sample.data.length >> 1);
  for (let i = 0; i < data.length; i++) data[i] = sample.data[i * 2]!;
  const looped = sample.loopType !== 'none' && sample.loopLength >= 2;
  const next = withData({ ...sample, loopType: 'none', loopStart: 0, loopLength: 0 }, data);
  return looped ? withLoop(next, sample.loopStart >> 1, sample.loopLength >> 1, sample.loopType) : next;
}

/** The rate (Hz) the sample sounds at when C-4 is struck. */
export function xmSampleRate(sample: Pick<XmSample, 'relativeNote' | 'finetune'>): number {
  return XM_BASE_RATE * Math.pow(2, (sample.relativeNote + sample.finetune / 128) / 12);
}

/**
 * Float PCM recorded at `rate` Hz as a sample that sounds at its own pitch
 * when C-4 is struck. Nothing is resampled: the relative note and finetune
 * carry the difference between `rate` and the 8363 Hz C-4 plays at.
 */
export function fromPcm(sample: XmSample, pcm: Float32Array, rate: number, bits: 8 | 16 = 16): XmSample {
  const semitones = 12 * Math.log2(Math.max(1, rate) / XM_BASE_RATE);
  const relativeNote = clamp(Math.round(semitones), -96, 95);
  const finetune = clamp(Math.round((semitones - relativeNote) * 128), -128, 127);
  return withData({ ...sample, bits, relativeNote, finetune, loopType: 'none', loopStart: 0, loopLength: 0 }, pcm);
}

/** The sample's audio as a 16-bit mono WAV at the rate C-4 plays it at. */
export function toWav(sample: XmSample): Uint8Array {
  const rate = Math.round(xmSampleRate(sample));
  const bytes = sample.data.length * 2;
  const out = new Uint8Array(44 + bytes);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, bytes, true);
  sample.data.forEach((v, i) => view.setInt16(44 + i * 2, clamp(Math.round(v * 32768), -32768, 32767), true));
  return out;
}

export const XM_WAVE_KINDS = ['sine', 'triangle', 'saw', 'square', 'pulse', 'noise'] as const;
export type XmWaveKind = (typeof XM_WAVE_KINDS)[number];
export const XM_WAVE_LENGTHS = [32, 64, 128, 256, 512, 1024, 2048, 4096] as const;

/** A new looped single-cycle waveform. Keeps the sample's name, volume, panning and bit depth. */
export function generateWave(sample: XmSample, kind: XmWaveKind, length: number, random: () => number = Math.random): XmSample {
  const n = clamp(Math.round(length), 4, XM_MAX_SAMPLE_FRAMES);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let v: number;
    switch (kind) {
      case 'sine':
        v = Math.sin(t * 2 * Math.PI);
        break;
      case 'triangle':
        v = t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
        break;
      case 'saw':
        v = 2 * t - 1;
        break;
      case 'square':
        v = t < 0.5 ? 1 : -1;
        break;
      case 'pulse':
        v = t < 0.25 ? 1 : -1;
        break;
      case 'noise':
        v = random() * 2 - 1;
        break;
    }
    data[i] = v * 0.99;
  }
  const base = { ...sample, name: sample.name || kind, relativeNote: 0, finetune: 0 };
  return withLoop(withData({ ...base, loopType: 'none', loopStart: 0, loopLength: 0 }, data), 0, n, 'forward');
}

export interface XmPulseParams {
  /** Frames in one cycle. */
  cycleLength: number;
  /** How many cycles the sample holds: the sweep is spread over them. */
  cycles: number;
  /** Duty cycle at the start and at the far end of the sweep, 1-99 %. */
  dutyStart: number;
  dutyEnd: number;
  /** `pingpong` returns to the start duty by the end, so the loop is seamless. */
  sweep: 'up' | 'pingpong';
}

/** A pulse wave whose width moves through the sample (pulse-width modulation), looped. */
export function generatePulse(sample: XmSample, params: XmPulseParams): XmSample {
  const cycle = Math.max(4, params.cycleLength);
  const cycles = Math.max(1, Math.round(params.cycles));
  const n = Math.min(XM_MAX_SAMPLE_FRAMES, cycle * cycles);
  const data = new Float32Array(n);
  for (let c = 0; c < cycles; c++) {
    const p = cycles === 1 ? 0 : c / cycles;
    const along = params.sweep === 'pingpong' ? 1 - Math.abs(2 * p - 1) : cycles === 1 ? 0 : c / (cycles - 1);
    const duty = (params.dutyStart + (params.dutyEnd - params.dutyStart) * along) / 100;
    const high = clamp(Math.round(duty * cycle), 1, cycle - 1);
    for (let i = 0; i < cycle; i++) {
      const at = c * cycle + i;
      if (at < n) data[at] = i < high ? 0.99 : -0.99;
    }
  }
  const base = { ...sample, name: sample.name || 'pulse', relativeNote: 0, finetune: 0 };
  return withLoop(withData({ ...base, loopType: 'none', loopStart: 0, loopLength: 0 }, data), 0, n, 'forward');
}

/** Signed 8-bit drum output as a sample that sounds as designed when `relativeNote` is applied. */
export function fromInt8(sample: XmSample, data: Int8Array, relativeNote: number): XmSample {
  const f = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) f[i] = data[i]! / 128;
  return withData(
    { ...sample, bits: 8, relativeNote, finetune: 0, loopType: 'none', loopStart: 0, loopLength: 0 },
    f,
  );
}

// -- an instrument ----------------------------------------------------------

/** Replace sample `index`; the keymap is untouched. */
export function withSample(instrument: XmInstrument, index: number, sample: XmSample): XmInstrument {
  return { ...instrument, samples: instrument.samples.map((s, i) => (i === index ? sample : s)) };
}

export function addSample(instrument: XmInstrument, sample: XmSample = emptyXmSample()): XmInstrument | null {
  if (instrument.samples.length >= XM_MAX_SAMPLES_PER_INSTRUMENT) return null;
  return { ...instrument, samples: [...instrument.samples, sample] };
}

export function duplicateSample(instrument: XmInstrument, index: number): XmInstrument | null {
  const source = instrument.samples[index];
  if (!source) return null;
  return addSample(instrument, { ...source, name: clampXmName(source.name), data: Float32Array.from(source.data) });
}

/** Remove a sample; notes that played it fall back to sample 0 and later indices shift down. */
export function removeSample(instrument: XmInstrument, index: number): XmInstrument {
  const samples = instrument.samples.filter((_, i) => i !== index);
  const keymap = instrument.keymap.map((n) => (n === index ? 0 : n > index ? n - 1 : n));
  return { ...instrument, samples, keymap };
}

/** Point notes `from`..`to` (0..95, inclusive) at sample `index`. */
export function paintKeymap(instrument: XmInstrument, from: number, to: number, index: number): XmInstrument {
  const lo = clamp(Math.min(from, to), 0, 95);
  const hi = clamp(Math.max(from, to), 0, 95);
  const keymap = instrument.keymap.map((n, note) => (note >= lo && note <= hi ? index : n));
  return { ...instrument, keymap };
}

// -- envelopes --------------------------------------------------------------

export function envelopeWith(env: XmEnvelope, patch: Partial<XmEnvelope>): XmEnvelope {
  const next = { ...env, ...patch };
  const last = Math.max(0, next.points.length - 1);
  return {
    ...next,
    sustainPoint: clamp(next.sustainPoint, 0, last),
    loopStart: clamp(next.loopStart, 0, last),
    loopEnd: clamp(Math.max(next.loopStart, next.loopEnd), 0, last),
  };
}

/** Move a point; frames stay strictly increasing and inside the envelope. */
export function movePoint(env: XmEnvelope, index: number, frame: number, value: number): XmEnvelope {
  const p = env.points[index];
  if (!p) return env;
  const prev = env.points[index - 1];
  const next = env.points[index + 1];
  // The first point is pinned to frame 0, as FT2 does.
  const lo = index === 0 ? 0 : (prev?.frame ?? 0) + 1;
  const hi = index === 0 ? 0 : next ? next.frame - 1 : XM_ENVELOPE_MAX_FRAME;
  const points = env.points.map((q, i) =>
    i === index
      ? { frame: clamp(Math.round(frame), lo, Math.max(lo, hi)), value: clamp(Math.round(value), 0, XM_ENVELOPE_MAX_VALUE) }
      : q,
  );
  return { ...env, points };
}

/** Insert a point at `frame`, keeping order; returns the same envelope when it is full or the frame is taken. */
export function addPoint(env: XmEnvelope, frame: number, value: number): XmEnvelope {
  if (env.points.length >= XM_MAX_ENVELOPE_POINTS) return env;
  const f = clamp(Math.round(frame), 0, XM_ENVELOPE_MAX_FRAME);
  if (env.points.some((p) => p.frame === f)) return env;
  const point = { frame: f, value: clamp(Math.round(value), 0, XM_ENVELOPE_MAX_VALUE) };
  const at = env.points.findIndex((p) => p.frame > f);
  const index = at < 0 ? env.points.length : at;
  const points = [...env.points.slice(0, index), point, ...env.points.slice(index)];
  // Markers after the new point shift with their points.
  const shift = (i: number) => (i >= index ? i + 1 : i);
  return envelopeWith(env, {
    points,
    sustainPoint: shift(env.sustainPoint),
    loopStart: shift(env.loopStart),
    loopEnd: shift(env.loopEnd),
  });
}

/** Remove a point (an enabled envelope keeps at least two). */
export function removePoint(env: XmEnvelope, index: number): XmEnvelope {
  if (env.points.length <= 2 || index < 0 || index >= env.points.length) return env;
  const unshift = (i: number) => (i > index ? i - 1 : i);
  return envelopeWith(env, {
    points: env.points.filter((_, i) => i !== index),
    sustainPoint: unshift(env.sustainPoint),
    loopStart: unshift(env.loopStart),
    loopEnd: unshift(env.loopEnd),
  });
}

export interface XmEnvelopePreset {
  id: string;
  label: string;
  points: Array<[number, number]>;
  sustain?: number;
  fadeout?: number;
}

export const XM_VOLUME_PRESETS: readonly XmEnvelopePreset[] = [
  { id: 'organ', label: 'Organ (hold, release)', points: [[0, 64], [4, 64]], sustain: 1, fadeout: 1600 },
  { id: 'pluck', label: 'Pluck', points: [[0, 64], [6, 36], [24, 10], [60, 0]], fadeout: 600 },
  { id: 'pad', label: 'Pad (slow attack)', points: [[0, 0], [40, 64], [60, 56]], sustain: 2, fadeout: 900 },
  { id: 'stab', label: 'Stab', points: [[0, 64], [12, 0]] },
];

export const XM_PANNING_PRESETS: readonly XmEnvelopePreset[] = [
  { id: 'sweep', label: 'Left to right', points: [[0, 0], [100, 64]] },
  { id: 'autopan', label: 'Auto-pan', points: [[0, 32], [24, 64], [48, 32], [72, 0], [96, 32]] },
];

export function applyEnvelopePreset(env: XmEnvelope, preset: XmEnvelopePreset): XmEnvelope {
  return envelopeWith(
    { ...env, enabled: true },
    {
      points: preset.points.map(([frame, value]) => ({ frame, value })),
      sustainEnabled: preset.sustain !== undefined,
      sustainPoint: preset.sustain ?? 0,
      loopEnabled: false,
      loopStart: 0,
      loopEnd: 0,
    },
  );
}

/** A fresh enabled envelope the editor can start dragging. */
export function defaultEnvelope(kind: 'volume' | 'panning'): XmEnvelope {
  const high = kind === 'volume' ? 64 : 32;
  return envelopeWith(
    { ...emptyXmEnvelope(), enabled: true },
    { points: [{ frame: 0, value: high }, { frame: 32, value: high }] },
  );
}
