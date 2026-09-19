import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ahxInstrumentProblem, parseAhx, type AhxInstrument } from '@another-synth/tracker-playback';
import {
  AHX_NUMBER_FIELDS,
  ahxEnvelopeWarnings,
  ahxFxParamMax,
  setAhxEnvelopeFields,
  setAhxNumber,
} from 'src/audio/tracker/ahx-instrument-edit';

const karma = parseAhx(
  new Uint8Array(readFileSync(resolve(__dirname, '../../public/demos/ahx/karma.ahx'))),
);
const base = (): AhxInstrument => JSON.parse(JSON.stringify(karma.instruments[1]));
const withEnv = (envelope: Partial<AhxInstrument['envelope']>): AhxInstrument => {
  const ins = base();
  ins.envelope = { ...ins.envelope, ...envelope };
  return ins;
};
const ids = (ins: AhxInstrument) => ahxEnvelopeWarnings(ins).map((w) => w.id);

describe('EDITOR-UX B1 edit helpers', () => {
  it('setAhxEnvelopeFields sets several fields in one copy, each clamped, leaving the input alone', () => {
    const ins = base();
    const before = JSON.stringify(ins);
    const out = setAhxEnvelopeFields(ins, { dFrames: 300, dVolume: 99, rFrames: 7 });
    expect(out.envelope).toMatchObject({ dFrames: 255, dVolume: 64, rFrames: 7 });
    expect(out.envelope.aFrames).toBe(ins.envelope.aFrames);
    expect(JSON.stringify(ins)).toBe(before);
    expect(ahxInstrumentProblem(out)).toBeNull();
  });

  it('the filter lower limit takes 0..0x7f, the width the codec holds (E14)', () => {
    expect(AHX_NUMBER_FIELDS.filterLowerLimit).toBe(0x7f);
    expect(setAhxNumber(base(), 'filterLowerLimit', 100).filterLowerLimit).toBe(100);
    expect(setAhxNumber(base(), 'filterLowerLimit', 500).filterLowerLimit).toBe(0x7f);
    expect(ahxInstrumentProblem(setAhxNumber(base(), 'filterLowerLimit', 0x7f))).toBeNull();
    // The upper limit and speed keep their 6 bits.
    expect(AHX_NUMBER_FIELDS.filterUpperLimit).toBe(0x3f);
  });

  describe('ahxEnvelopeWarnings (E1)', () => {
    it('a plain envelope has none', () => {
      expect(ids(withEnv({ aFrames: 2, aVolume: 64, dFrames: 4, dVolume: 40, sFrames: 5, rFrames: 6, rVolume: 0 }))).toEqual([]);
    });
    it('attack and decay both 0: never rises (and only that, not the milder attack warning)', () => {
      expect(ids(withEnv({ aFrames: 0, dFrames: 0, rFrames: 3 }))).toEqual(['never-rises']);
    });
    it('attack 0 alone: the decay ramps from silence', () => {
      expect(ids(withEnv({ aFrames: 0, dFrames: 4, rFrames: 3 }))).toEqual(['no-attack']);
    });
    it('decay 0 with a different decay level: sustain holds the attack level; the same level is no surprise', () => {
      expect(ids(withEnv({ aFrames: 3, aVolume: 60, dFrames: 0, dVolume: 20, rFrames: 3 }))).toEqual(['no-decay']);
      expect(ids(withEnv({ aFrames: 3, aVolume: 60, dFrames: 0, dVolume: 60, rFrames: 3 }))).toEqual([]);
    });
    it('release 0: the note never releases', () => {
      expect(ids(withEnv({ aFrames: 3, dFrames: 2, rFrames: 0 }))).toEqual(['no-release']);
    });
  });

  it('a version-0 AHX file only plays the low nibble of a filter toggle (E14)', () => {
    expect(ahxFxParamMax(4, 'ahx', 0)).toBe(0x0f);
    expect(ahxFxParamMax(4, 'ahx', 1)).toBe(255);
    expect(ahxFxParamMax(4, 'hvl', 0)).toBe(255);
    expect(ahxFxParamMax(15, 'ahx', 0)).toBe(255);
  });
});
