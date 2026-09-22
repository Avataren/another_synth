// @vitest-environment node
//
// Pool-scoped graph and asset messages reach the owning slot's engine, and no
// other (arch review 2026-09-22 N1, plan `.ai/plan-arch-fix1.md`).
//
// End to end through production code on both sides: the real `WorkletPool`
// allocates, the real `PooledInstrument` posts, and the *built*
// `public/worklets/synth-worklet.js` runs the real wasm engine (see
// `helpers/synth-worklet-harness.ts`). Only `createStandardAudioWorklet` is
// swapped, for a node wrapping that bundle.
//
// Two song instruments share one worklet. Each loads an 8-voice patch, so the
// pool puts A on voices 0-7 (engine slice 0) and B on 8-15 (engine slice 1) --
// the "slot not on engine 0" case the review describes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const { extractAllAudioAssets } = await import(
  '../audio/serialization/audio-asset-extractor'
);

const ROOT = resolve(__dirname, '../..');
const bank = JSON.parse(
  readFileSync(resolve(ROOT, 'public/default-patch.json'), 'utf8'),
) as { patches: Patch[] };

/** Oscillator -> mixer, convolver effect at 10003 (inactive). */
const OSCILLATOR_ID = '26520f70-11b2-208c-2a4d-0903ab200303';
const CONVOLVER_ID = '10003';

function eightVoicePatch(): Patch {
  const patch = structuredClone(bank.patches[0]) as Patch;
  const layout = patch.synthState.layout as { voiceCount?: number };
  layout.voiceCount = 8;
  return patch;
}

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
  return { pool, allocA, allocB, a, b, harness };
}

/** RMS over a few quanta of whatever is gated on. */
function loudness(harness: SynthWorkletHarness, quanta = 8): number {
  let total = 0;
  for (let i = 0; i < quanta; i++) total += rms(harness.render());
  return total / quanta;
}

function ramp(length: number, start: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = start * (1 - i / length);
  return out;
}

beforeEach(() => {
  harnesses.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('pooled slot scoping (built synth worklet + real wasm)', () => {
  it('the pool puts two 8-voice song instruments on different engine slices of one worklet', async () => {
    const { allocA, allocB, b, harness } = await twoSongInstruments();
    expect(allocA.workletNode).toBe(allocB.workletNode);
    expect(allocA.startVoice).toBe(0);
    expect(allocB.startVoice).toBe(8);
    expect(harnesses).toHaveLength(1);

    // B's slot plays through engine slice 1's AudioParams (the control for the
    // silence asserted after a delete below).
    b.noteOnAtTime(60, 127, 0);
    expect(loudness(harness)).toBeGreaterThan(1e-3);
  });

  it('deleteNode removes the node from the owning slot only (no phantom node)', async () => {
    const { a, b, harness } = await twoSongInstruments();

    const before = harness.ofType('stateUpdated').length;
    b.deleteNode(OSCILLATOR_ID);
    await harness.settle();

    // The worklet answers with B's refreshed layout, and the oscillator is gone.
    const updates = harness.ofType('stateUpdated').slice(before);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.instrumentId).toBe('song-B');
    expect(JSON.stringify(updates[0]!.state)).not.toContain(OSCILLATOR_ID);

    // B, with its only oscillator deleted, is silent. (Output is the mix of
    // both slots, so B is measured first, before A leaves any tail.)
    b.noteOnAtTime(60, 127, 0);
    expect(loudness(harness)).toBeLessThan(1e-6);
    b.allNotesOff();
    b.cancelAndSilenceVoice(0);

    // A, the same patch, still has its oscillator and still sounds.
    a.noteOnAtTime(60, 127, 0);
    expect(loudness(harness)).toBeGreaterThan(1e-3);
  });

  it('an impulse response import lands on the owning slot, not engine 0', async () => {
    const { a, b, harness } = await twoSongInstruments();
    const irA = ramp(300, 0.5);
    const irB = ramp(700, -0.25);

    a.importImpulseWaveformData(CONVOLVER_ID, floatWav(irA));
    b.importImpulseWaveformData(CONVOLVER_ID, floatWav(irB));
    await harness.settle();

    const fromA = await a.exportConvolverData(CONVOLVER_ID);
    const fromB = await b.exportConvolverData(CONVOLVER_ID);

    expect(fromA.samples.length).toBeGreaterThanOrEqual(irA.length);
    expect(fromB.samples.length).toBeGreaterThanOrEqual(irB.length);
    expect(fromA.samples[0]).toBeCloseTo(irA[0]!, 3);
    expect(fromB.samples[0]).toBeCloseTo(irB[0]!, 3);
  });

  it('sample export reads the owning slot, so a live-edit save captures its asset', async () => {
    const { a, b } = await twoSongInstruments();
    const samplerA = await a.createNode(VoiceNodeType.Sampler);
    const samplerB = await b.createNode(VoiceNodeType.Sampler);
    const sampleA = ramp(400, 0.75);
    const sampleB = ramp(900, -0.5);
    a.importSampleData(samplerA, floatWav(sampleA));
    b.importSampleData(samplerB, floatWav(sampleB));

    // The same call patch-store's save path makes on `currentInstrument`.
    const assetsB = await extractAllAudioAssets(b, [samplerB], [], new Map());
    const assetsA = await extractAllAudioAssets(a, [samplerA], [], new Map());
    expect([...assetsB.keys()]).toEqual([`sample_${samplerB}`]);
    expect([...assetsA.keys()]).toEqual([`sample_${samplerA}`]);

    const exportedB = await b.exportSamplerData(samplerB);
    const exportedA = await a.exportSamplerData(samplerA);
    expect(Array.from(exportedB.samples)).toEqual(
      Array.from(sampleB, (v) => Math.fround(v)),
    );
    expect(Array.from(exportedA.samples)).toEqual(
      Array.from(sampleA, (v) => Math.fround(v)),
    );
  });

  it('concurrent exports of the same node id on two slots do not cross-resolve', async () => {
    const { a, b, harness } = await twoSongInstruments();
    // Every slot's convolver effect is 10003, and both instruments listen on
    // the one shared port, so only the correlation id tells the replies apart.
    a.importImpulseWaveformData(CONVOLVER_ID, floatWav(ramp(300, 0.5)));
    b.importImpulseWaveformData(CONVOLVER_ID, floatWav(ramp(300, -0.25)));
    await harness.settle();

    const [fromA, fromB] = await Promise.all([
      a.exportConvolverData(CONVOLVER_ID),
      b.exportConvolverData(CONVOLVER_ID),
    ]);
    expect(fromA.samples[0]).toBeCloseTo(0.5, 3);
    expect(fromB.samples[0]).toBeCloseTo(-0.25, 3);
  });
});
