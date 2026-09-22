// @vitest-environment node
//
// A truncated WAV (arch review 2026-09-22 N5, plan `.ai/plan-arch-fix2.md`
// D1/D5) fails its import with an ordinary error and leaves the shared worklet
// usable. Before the fix every decode site did `.map(|s| s.unwrap())`; hound
// yields `Err` on a short `data` chunk, and with `panic = "abort"` that was a
// wasm `unreachable` trap inside a `&mut self` call, after which the engine
// was dead (wasm-bindgen's borrow flag is never released).
//
// Production path, end to end (same harness as
// `synth-worklet-pooled-scoping.test.ts`): the real `WorkletPool` and
// `PooledInstrument` post the messages, the *built*
// `public/worklets/synth-worklet.js` handles them, and the committed
// `public/wasm/audio_processor_bg.wasm` decodes the bytes:
// - `PooledInstrument.importSampleData` -> `importSample` message
//   (synth-worklet.ts:373) -> `handleImportSample` -> `engine.import_sample`
//   (synth-worklet.ts:733) -> wasm.rs `import_sample` -> `read_wav_samples_f32`.
// - `PooledInstrument.importImpulseWaveformData` -> `importImpulseWaveform`
//   (synth-worklet.ts:329) -> `handleImportImpulseWaveformData` ->
//   `engine.import_wave_impulse` (synth-worklet.ts:699) -> wasm.rs
//   `import_wave_impulse` -> `read_wav_samples_f32`.
// Both handlers catch and `console.error` what the engine throws, so the
// error is observed there.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Patch } from '../audio/types/preset-types';
import { VoiceNodeType } from '../audio/types/synth-layout';
import {
  createFakeAudioContext,
  createSynthWorkletNode,
  floatWav,
  rms,
  type SynthWorkletHarness,
} from './helpers/synth-worklet-harness';

const harnesses: SynthWorkletHarness[] = [];
vi.mock('../audio/audio-processor-loader', () => ({
  createStandardAudioWorklet: vi.fn(async () => {
    const harness = createSynthWorkletNode();
    harnesses.push(harness);
    return harness.node;
  }),
}));

const { WorkletPool } = await import('../audio/worklet-pool');
const { PooledInstrument } = await import('../audio/pooled-instrument-factory');

const ROOT = resolve(__dirname, '../..');
const bank = JSON.parse(
  readFileSync(resolve(ROOT, 'public/default-patch.json'), 'utf8'),
) as { patches: Patch[] };

/** The default patch's convolver effect id (inactive). */
const CONVOLVER_ID = '10003';

function eightVoicePatch(): Patch {
  const patch = structuredClone(bank.patches[0]) as Patch;
  const layout = patch.synthState.layout as { voiceCount?: number };
  layout.voiceCount = 8;
  return patch;
}

/** Two song instruments sharing one worklet: A on engine slice 0, B on 1. */
async function twoSongInstruments() {
  const context = createFakeAudioContext();
  const destination = context.createGain();
  const pool = new WorkletPool(context, destination);
  const allocA = await pool.allocateVoices('song-A', 8);
  const allocB = await pool.allocateVoices('song-B', 8);
  const a = new PooledInstrument(destination, context, 'song-A', allocA);
  const b = new PooledInstrument(destination, context, 'song-B', allocB);
  await a.loadPatch(eightVoicePatch());
  await b.loadPatch(eightVoicePatch());
  const harness = harnesses[harnesses.length - 1]!;
  await harness.settle();
  expect(allocA.workletNode).toBe(allocB.workletNode);
  return { a, b, harness };
}

function ramp(length: number, start: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = start * (1 - i / length);
  return out;
}

/**
 * A float WAV whose header declares `declared` samples but whose `data` chunk
 * stops 2.5 samples in -- hound's sample iterator errors on the short read.
 */
function truncatedWav(declared: number): Uint8Array {
  const full = floatWav(ramp(declared, 0.5));
  return full.slice(0, 44 + 10);
}

function loudness(harness: SynthWorkletHarness, quanta = 8): number {
  let total = 0;
  for (let i = 0; i < quanta; i++) total += rms(harness.render());
  return total / quanta;
}

/** The value a worklet handler caught and logged under `prefix`. */
function caughtError(spy: MockInstance, prefix: string): unknown {
  const call = spy.mock.calls.find(
    (args) => typeof args[0] === 'string' && args[0].startsWith(prefix),
  );
  expect(call, `worklet logged "${prefix}…"`).toBeDefined();
  return call![call!.length - 1];
}

/** A hound decode error thrown as a JsValue string, not a wasm trap. */
function expectDecodeError(error: unknown) {
  // wasm.rs maps the helper's `String` through `JsValue::from_str`; a trap
  // would be a WebAssembly.RuntimeError ("unreachable").
  expect(typeof error).toBe('string');
  expect(String(error)).not.toMatch(/unreachable|RuntimeError/);
  // hound's short-read message, from the sample iterator (the header parses).
  expect(String(error)).toMatch(/Failed to read enough bytes/);
}

let consoleError: MockInstance;
beforeEach(() => {
  harnesses.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Installed before the harness copies `console` into the worklet's scope.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('truncated WAV import (built synth worklet + real wasm)', () => {
  it('a truncated sample fails with a decode error and the sampler still imports afterwards', async () => {
    const { a, b, harness } = await twoSongInstruments();
    const samplerA = await a.createNode(VoiceNodeType.Sampler);

    a.importSampleData(samplerA, truncatedWav(400));
    await harness.settle();
    expectDecodeError(caughtError(consoleError, 'Error importing sample:'));

    // The same engine accepts the next, valid import and hands it back.
    const sample = ramp(400, 0.75);
    a.importSampleData(samplerA, floatWav(sample));
    const exported = await a.exportSamplerData(samplerA);
    expect(Array.from(exported.samples)).toEqual(
      Array.from(sample, (v) => Math.fround(v)),
    );

    // And the shared worklet still renders, for this slot and its neighbour.
    b.noteOnAtTime(60, 127, 0);
    expect(loudness(harness)).toBeGreaterThan(1e-3);
    b.allNotesOff();
    b.cancelAndSilenceVoice(0);
    a.noteOnAtTime(60, 127, 0);
    expect(loudness(harness)).toBeGreaterThan(1e-3);
  });

  it('a truncated impulse response fails with a decode error and the convolver still imports afterwards', async () => {
    const { a, b, harness } = await twoSongInstruments();

    a.importImpulseWaveformData(CONVOLVER_ID, truncatedWav(300));
    await harness.settle();
    expectDecodeError(
      caughtError(consoleError, `importImpulseWaveform ${CONVOLVER_ID} failed`),
    );

    const ir = ramp(300, 0.5);
    a.importImpulseWaveformData(CONVOLVER_ID, floatWav(ir));
    await harness.settle();
    const fromA = await a.exportConvolverData(CONVOLVER_ID);
    expect(fromA.samples.length).toBeGreaterThanOrEqual(ir.length);
    expect(fromA.samples[0]).toBeCloseTo(ir[0]!, 3);

    b.noteOnAtTime(60, 127, 0);
    expect(loudness(harness)).toBeGreaterThan(1e-3);
    b.allNotesOff();
    b.cancelAndSilenceVoice(0);
    a.noteOnAtTime(60, 127, 0);
    expect(loudness(harness)).toBeGreaterThan(1e-3);
  });
});
