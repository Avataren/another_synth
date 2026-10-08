import { describe, expect, it } from 'vitest';
import {
  EQ_BAND_COUNT,
  EQ_BAND_FREQUENCIES,
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
    const r = eqResponseDb({ gainsDb: gains }, [20, 10000]);
    expect(r[0]).toBeGreaterThan(8);
    expect(Math.abs(r[1]!)).toBeLessThan(0.3);
  });

  it('compensated gains hit the targets at the band centres', () => {
    const targets = [0, 0, 0, 0, 0, 9, 0, 0, 0, 0];
    const r = eqResponseDb(eqEffectiveGains({ gainsDb: targets }), EQ_BAND_FREQUENCIES);
    expect(r[5]).toBeCloseTo(9, 1);
    expect(Math.abs(r[2]!)).toBeLessThan(0.1);
  });

  it('a flat boost stays flat between bands (no scalloping)', () => {
    const eff = eqEffectiveGains({ gainsDb: new Array<number>(EQ_BAND_COUNT).fill(6) });
    const mid = [88, 177, 354, 707, 1414, 2828, 5657];
    for (const v of eqResponseDb(eff, mid)) expect(Math.abs(v - 6)).toBeLessThan(0.8);
  });
});
