import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and these render through the real bytes.
import { AhxPlayer, initSync } from '../../../public/wasm/audio_processor.js';
import { AhxProcessorCore, type AhxEvent, type AhxWasmPlayerCtor } from 'src/audio/worklets/ahx-core';

const ROOT = resolve(__dirname, '../../..');
export const RENDER_SAMPLE_RATE = 44100;
const QUANTUM = 128;

let ready = false;
let nextId = 0;

/** Loads the real wasm once. */
export function initAhxWasm(): void {
  if (ready) return;
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
  ready = true;
}

export interface AhxRender {
  l: Float32Array;
  r: Float32Array;
  events: AhxEvent[];
  /** The frame at which each event was posted (the start of its 128-frame quantum). */
  eventFrames: number[];
}

export interface RenderOptions {
  /** Starts playing at this place (a `seek` before `play`). */
  seek?: { position: number; row: number };
}

/**
 * Plays `bytes` through the worklet core over the real wasm (hi-fi off, the
 * golden path) and returns `seconds` of audio, or the error the engine posted.
 */
export function renderAhx(bytes: Uint8Array, seconds: number, options: RenderOptions = {}): AhxRender {
  initAhxWasm();
  const events: AhxEvent[] = [];
  const eventFrames: number[] = [];
  let now = 0;
  const core = new AhxProcessorCore(AhxPlayer as unknown as AhxWasmPlayerCtor, RENDER_SAMPLE_RATE, (e) => {
    events.push(e);
    eventFrames.push(now);
  });
  core.handle({ type: 'set-hifi', enabled: false });
  core.handle({ type: 'load-song', id: nextId++, bytes });
  if (options.seek) core.handle({ type: 'seek', position: options.seek.position, row: options.seek.row });
  core.handle({ type: 'play' });
  const frames = Math.floor(seconds * RENDER_SAMPLE_RATE);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let at = 0; at < frames; at += QUANTUM) {
    const n = Math.min(QUANTUM, frames - at);
    now = at;
    core.process(l.subarray(at, at + n), r.subarray(at, at + n));
  }
  return { l, r, events, eventFrames };
}

export const peak = (render: AhxRender): number => {
  let max = 0;
  for (let i = 0; i < render.l.length; i++) max = Math.max(max, Math.abs(render.l[i] ?? 0), Math.abs(render.r[i] ?? 0));
  return max;
};

/** The first frame at which two renders differ, or -1. */
export function firstDifference(a: AhxRender, b: AhxRender): number {
  const n = Math.min(a.l.length, b.l.length);
  for (let i = 0; i < n; i++) if (a.l[i] !== b.l[i] || a.r[i] !== b.r[i]) return i;
  return a.l.length === b.l.length ? -1 : n;
}

/** The frame at which `position`/`row` was first reported, or `undefined` when it never was within the render. */
export function rowStartFrame(render: AhxRender, position: number, row: number): number | undefined {
  const i = render.events.findIndex((e) => e.type === 'position' && e.position === position && e.row === row);
  return i < 0 ? undefined : render.eventFrames[i];
}

/**
 * The fundamental of a steady tone in frames `from`..`to` of a render (left
 * plus right, DC removed), by autocorrelation: the first lag whose correlation
 * comes within 90 % of the zero-lag one, walked up to its local peak. Whole
 * frames only, so the answer is within a few percent: good for telling
 * semitones (6 %) and octaves apart.
 */
export function pitchHz(render: AhxRender, from: number, to: number): number {
  const x: number[] = [];
  for (let i = from; i < to; i++) x.push((render.l[i] ?? 0) + (render.r[i] ?? 0));
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  for (let i = 0; i < x.length; i++) x[i]! -= mean;
  const ac = (lag: number): number => {
    let sum = 0;
    for (let i = 0; i + lag < x.length; i++) sum += x[i]! * x[i + lag]!;
    return sum;
  };
  const zero = ac(0);
  if (zero === 0) return 0;
  const maxLag = Math.floor(x.length / 2);
  let lag = 1;
  while (lag < maxLag && ac(lag) > 0) lag++;
  while (lag < maxLag && ac(lag) < 0.9 * zero) lag++;
  while (lag + 1 < maxLag && ac(lag + 1) > ac(lag)) lag++;
  return lag >= maxLag ? 0 : RENDER_SAMPLE_RATE / lag;
}
