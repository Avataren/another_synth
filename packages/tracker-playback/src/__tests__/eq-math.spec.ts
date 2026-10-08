import { describe, expect, it } from 'vitest';
import {
  EQ_BAND_COUNT,
  EQ_BAND_FREQUENCIES,
  EQ_PRESETS,
  matchEqPreset,
  eqEffectiveGains,
  eqIsFlat,
  eqResponseDb,
  sanitizeEqParams,
} from '../postfx/eq-math';

describe('eq-math', () => {
  it('sanitises: clamps, fills missing bands and rejects junk', () => {
    const p = sanitizeEqParams({ gainsDb: [99, -99, Number.NaN] });
    expect(p.gainsDb).toHaveLength(EQ_BAND_COUNT);
    expect(p.gainsDb.slice(0, 3)).toEqual([12, -12, 0]);
    expect(eqIsFlat(sanitizeEqParams({}))).toBe(true);
  });

  it('a flat EQ has a 0 dB response', () => {
    const r = eqResponseDb(sanitizeEqParams({}), [100, 1000, 10000]);
    expect([...r]).toEqual([0, 0, 0]);
  });

  it('a peaking band hits its gain at its centre frequency', () => {
    const gains = new Array<number>(EQ_BAND_COUNT).fill(0);
    gains[5] = 6;
    const r = eqResponseDb({ gainsDb: gains }, [EQ_BAND_FREQUENCIES[5]!, 20]);
    expect(r[0]).toBeCloseTo(6, 1);
    expect(Math.abs(r[1]!)).toBeLessThan(0.3);
  });

  it('shelves reach their gain well past the corner', () => {
    const gains = new Array<number>(EQ_BAND_COUNT).fill(0);
    gains[0] = 9;
    const r = eqResponseDb({ gainsDb: gains }, [10, 10000]);
    expect(r[0]).toBeGreaterThan(8);
    expect(Math.abs(r[1]!)).toBeLessThan(0.3);
  });

  it('compensated gains hit the targets at the band centres', () => {
    const targets = [0, 0, 0, 0, 0, 9, 0, 0, 0, 0];
    const r = eqResponseDb(eqEffectiveGains({ gainsDb: targets }), EQ_BAND_FREQUENCIES);
    expect(Math.abs(r[5]! - 9)).toBeLessThan(0.15);
    expect(Math.abs(r[2]!)).toBeLessThan(0.1);
  });

  it('a flat boost stays flat between bands (no scalloping)', () => {
    const eff = eqEffectiveGains({ gainsDb: new Array<number>(EQ_BAND_COUNT).fill(6) });
    const mid = [88, 177, 354, 707, 1414, 2828, 5657];
    for (const v of eqResponseDb(eff, mid)) expect(Math.abs(v - 6)).toBeLessThan(0.8);
  });

  it('presets are well-formed and recognised by matchEqPreset', () => {
    for (const p of EQ_PRESETS) {
      expect(p.gainsDb).toHaveLength(EQ_BAND_COUNT);
      expect(matchEqPreset({ gainsDb: [...p.gainsDb] })?.id).toBe(p.id);
    }
    expect(matchEqPreset({ gainsDb: [1, 0, 0, 0, 0, 0, 0, 0, 0, 7] })).toBeNull();
  });

  it('presets have no dip between adjacent equal nodes (bass boost)', () => {
    const preset = EQ_PRESETS.find((p) => p.id === 'bass-boost')!;
    const eff = eqEffectiveGains({ gainsDb: [...preset.gainsDb] });
    // 31 and 62 Hz are both +6: nothing between them may sag below ~+5.6.
    const between = [35, 40, 45, 50, 55].map((f) => f);
    for (const v of eqResponseDb(eff, between)) expect(v).toBeGreaterThan(5.6);
  });
});
