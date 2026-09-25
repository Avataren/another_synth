import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSidFile, type SidChipModel } from 'src/audio/tracker/sid-doc';
import {
  SID_CYCLES_PER_FRAME,
  sidCutoffHz,
  sidEnvelopeLevels,
  sidFilterResponseDb,
  sidFrameCycles,
  sidFramesMs,
  sidResonanceQ,
  sidStepPath,
  sidWaveCycle,
  sidWaveformOutput,
  simulateSidInstrument,
} from 'src/audio/tracker/sid-instrument-visuals';

/**
 * plan-sid-tracking.md S4: the SID instrument page's drawings are ports of
 * the Rust, held to numbers dumped from the real Rust
 * (`rust-wasm/tests/sid_visuals_parity.rs` -> `fixtures/sid-visuals-parity.json`,
 * which that test also fails on when the Rust drifts). As
 * `ahx-instrument-visuals.test.ts` does for AHX: a port that disagrees with a
 * fixture number is wrong, never the fixture.
 */

interface Fixture {
  cyclesPerFrame: number;
  envelopes: { ad: number; sr: number; gateFrames: number; frames: number; levels: number[] }[];
  cutoff: Record<SidChipModel, [number, number][]>;
  q: Record<SidChipModel, [number, number][]>;
  waves: { model: SidChipModel; control: number; pulseWidth: number; values: number[] }[];
  instruments: { instrument: number; note: number; rows: number[][] }[];
}

const ROOT = resolve(__dirname, '../..');
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/sid-visuals-parity.json'), 'utf8')) as Fixture;
const chain = () => parseSidFile(new Uint8Array(readFileSync(resolve(ROOT, 'rust-wasm/tests/fixtures/sid/s3-chain.asid'))));

describe('SID visuals parity with the Rust', () => {
  it('a frame is the PAL vertical blank, and GT\'s CIA period at multispeed (player::frame_cycles)', () => {
    // GT-parity 0925b: 312 x 63 cycles, 50.1245 Hz (was 50 Hz's 19 705).
    expect(SID_CYCLES_PER_FRAME).toBe(19_656);
    expect(sidFrameCycles(1)).toBe(19_656);
    for (const m of [2, 3, 4, 6, 8]) expect(sidFrameCycles(m)).toBe(19_656 / m);
    expect(sidFrameCycles(5)).toBe(3_932);
    expect(sidFrameCycles(16)).toBe(1_229);
    expect(1000 / sidFramesMs(1)).toBeCloseTo(50.1245, 4);
    expect(Math.round(sidFramesMs(6))).toBe(120);
  });

  it('the envelope port reproduces Envelope::clock frame by frame', () => {
    expect(SID_CYCLES_PER_FRAME).toBe(fixture.cyclesPerFrame);
    expect(fixture.envelopes.length).toBeGreaterThanOrEqual(6);
    for (const e of fixture.envelopes) {
      expect(sidEnvelopeLevels(e.ad, e.sr, e.gateFrames, e.frames), `AD ${e.ad} SR ${e.sr}`).toEqual(e.levels);
    }
  });

  it('the cutoff and resonance maps are the chip\'s, per model', () => {
    for (const model of ['8580', '6581'] as const) {
      for (const [reg, hz] of fixture.cutoff[model]) expect(sidCutoffHz(model, reg)).toBeCloseTo(hz, 9);
      for (const [res, q] of fixture.q[model]) expect(sidResonanceQ(model, res)).toBeCloseTo(q, 12);
    }
  });

  it('waveform cycles are waveform_output (6581 combined waveforms included)', () => {
    for (const w of fixture.waves) {
      expect(sidWaveCycle(w.model, w.control, w.pulseWidth, 64), `${w.model} ${w.control.toString(16)}`).toEqual(w.values);
    }
  });

  it('an instrument\'s frames are what the player\'s preview voice writes to the chip', () => {
    const doc = chain();
    expect(fixture.instruments).toHaveLength(doc.instruments.length);
    for (const ins of fixture.instruments) {
      const got = simulateSidInstrument(doc, ins.instrument, ins.note, ins.rows.length).map((r) => [...r]);
      expect(got, `instrument ${ins.instrument}`).toEqual(ins.rows);
    }
  });
});

describe('SID visuals: display helpers', () => {
  it('noise and no waveform have no cycle; the test bit holds pulse high', () => {
    expect(sidWaveCycle('8580', 0x80, 0)).toBeNull();
    expect(sidWaveCycle('8580', 0x00, 0)).toBeNull();
    expect(sidWaveformOutput('8580', 0x48, 0, 0x800)).toBe(0xfff);
  });

  it('the filter curve: LP flat below cutoff, BP peaks at Q, HP flat above', () => {
    const fc = sidCutoffHz('8580', 1024);
    expect(sidFilterResponseDb('8580', 1024, 0, 1, fc / 100)).toBeCloseTo(0, 2);
    expect(sidFilterResponseDb('8580', 1024, 8, 2, fc)).toBeCloseTo(20 * Math.log10(sidResonanceQ('8580', 8)), 6);
    expect(sidFilterResponseDb('8580', 1024, 0, 4, fc * 100)).toBeCloseTo(0, 2);
    expect(sidFilterResponseDb('8580', 1024, 0, 0, fc)).toBe(-120);
  });

  it('a step path spans the box', () => {
    expect(sidStepPath([0, 0xfff], 10, 4)).toBe('M0,4.00 L0.00,4.00 L5.00,4.00 L5.00,0.00 L10.00,0.00');
    expect(sidStepPath([], 10, 4)).toBe('');
    expect(simulateSidInstrument(chain(), 99, 57, 4)).toEqual([]);
  });
});
