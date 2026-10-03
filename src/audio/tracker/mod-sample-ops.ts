/**
 * Edits to a ProTracker sample. Pure: each takes a `ModSample` and returns a
 * new one, with loop points kept inside the data and on word boundaries (a
 * .mod stores them in words).
 */
import type { ModSample } from '@another-synth/tracker-playback';
import { MOD_MAX_SAMPLE_BYTES, MOD_NAME_LENGTH } from 'src/audio/tracker/mod-sample-codec';

/** Paula's clock, for the rate a given period plays a sample at. */
const PAULA_CLOCK = 3546895;

/** The notes a loaded sample can be tuned to play at its own pitch on, with their periods. */
export const MOD_LOAD_NOTES = [
  { label: 'C-1', period: 856 },
  { label: 'C-2', period: 428 },
  { label: 'C-3', period: 214 },
] as const;

/** Whole words only: a .mod's lengths and loop points are in words. */
const evenDown = (n: number): number => n & ~1;

export function clampModName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[^\x20-\x7e]/g, '').slice(0, MOD_NAME_LENGTH);
}

/** Keep the loop inside the data; a loop of two bytes or less is no loop. */
export function withLoop(sample: ModSample, start: number, length: number): ModSample {
  const max = evenDown(sample.data.length);
  const loopStart = Math.max(0, Math.min(max - 2, evenDown(Math.round(start))));
  const loopLength = Math.max(0, Math.min(max - loopStart, evenDown(Math.round(length))));
  if (max < 4 || loopLength <= 2) return { ...sample, loopStart: 0, loopLength: 0 };
  return { ...sample, loopStart, loopLength };
}

/** The data replaced by `data` (padded to a whole word), loop re-fitted. */
export function withData(sample: ModSample, data: Int8Array): ModSample {
  const trimmed = data.length > MOD_MAX_SAMPLE_BYTES ? data.subarray(0, MOD_MAX_SAMPLE_BYTES) : data;
  const padded = trimmed.length % 2 ? Int8Array.from([...trimmed, 0]) : Int8Array.from(trimmed);
  const next = { ...sample, data: padded, length: padded.length };
  return sample.loopLength > 2 ? withLoop(next, sample.loopStart, sample.loopLength) : { ...next, loopStart: 0, loopLength: 0 };
}

export function normalize(sample: ModSample): ModSample {
  let peak = 0;
  for (const v of sample.data) peak = Math.max(peak, Math.abs(v));
  if (peak === 0 || peak >= 127) return sample;
  const gain = 127 / peak;
  return { ...sample, data: Int8Array.from(sample.data, (v) => Math.max(-128, Math.min(127, Math.round(v * gain)))) };
}

export function reverse(sample: ModSample): ModSample {
  const data = Int8Array.from(sample.data).reverse();
  const loop =
    sample.loopLength > 2
      ? withLoop({ ...sample, data }, data.length - (sample.loopStart + sample.loopLength), sample.loopLength)
      : sample;
  return { ...sample, data, loopStart: loop.loopStart, loopLength: loop.loopLength };
}

/** Every other frame: half the length, an octave up when played at the same period. */
export function halve(sample: ModSample): ModSample {
  const data = new Int8Array(sample.data.length >> 1);
  for (let i = 0; i < data.length; i++) data[i] = sample.data[i * 2]!;
  return withData(
    { ...sample, loopStart: sample.loopStart >> 1, loopLength: sample.loopLength >> 1 },
    data,
  );
}

/**
 * Float PCM at `rate` Hz as a sample that sounds at its own pitch when played
 * at `period`: resampled (linear) to that period's Paula rate, 8-bit.
 */
export function fromPcm(sample: ModSample, pcm: Float32Array, rate: number, period: number): ModSample {
  const target = PAULA_CLOCK / period;
  const length = Math.min(MOD_MAX_SAMPLE_BYTES, Math.max(0, Math.round((pcm.length * target) / rate)));
  const data = new Int8Array(length);
  for (let i = 0; i < length; i++) {
    const at = (i * rate) / target;
    const i0 = Math.floor(at);
    const frac = at - i0;
    const value = (pcm[i0] ?? 0) * (1 - frac) + (pcm[i0 + 1] ?? pcm[i0] ?? 0) * frac;
    data[i] = Math.max(-128, Math.min(127, Math.round(value * 127)));
  }
  return withData({ ...sample, loopStart: 0, loopLength: 0 }, data);
}

/** The sample's audio as a 16-bit mono WAV, at the rate C-2 plays it at. */
export function toWav(sample: ModSample): Uint8Array {
  const rate = Math.round(PAULA_CLOCK / 428);
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
  sample.data.forEach((v, i) => view.setInt16(44 + i * 2, v * 256, true));
  return out;
}

export const MOD_WAVE_KINDS = ['sine', 'triangle', 'saw', 'square', 'noise'] as const;
export type ModWaveKind = (typeof MOD_WAVE_KINDS)[number];
export const MOD_WAVE_LENGTHS = [32, 64, 128, 256, 512, 1024, 2048] as const;

/**
 * A new looped single-cycle waveform, the classic chip-style instrument. Keeps
 * the sample's name (or names it after the wave), volume and finetune.
 */
export function generateWave(sample: ModSample, kind: ModWaveKind, length: number, random: () => number = Math.random): ModSample {
  const n = Math.max(4, evenDown(Math.min(MOD_MAX_SAMPLE_BYTES, length)));
  const data = new Int8Array(n);
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
      case 'noise':
        v = random() * 2 - 1;
        break;
    }
    data[i] = Math.max(-128, Math.min(127, Math.round(v * 127)));
  }
  return withLoop({ ...sample, name: sample.name || kind, data, length: n, loopStart: 0, loopLength: 0 }, 0, n);
}
