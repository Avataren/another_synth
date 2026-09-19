// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAhx, type AhxInstrument } from '@another-synth/tracker-playback';
import {
  AHX_VIB_TAB,
  ahxFilterBounds,
  ahxShapePath,
  ahxSquareBounds,
  ahxSquareDuty,
  ahxSquareDutyRange,
  ahxSquareRow,
  ahxSweepRate,
  ahxSweepSetup,
  ahxSweepState,
  ahxSweepWindow,
  ahxUsesFilter,
  ahxVibratoAmplitude,
  ahxVibratoStep,
  ahxVibratoTrough,
  ahxVibratoWindow,
  ahxWaveShape,
  canEnableAhxSweep,
  simulateAhxVibrato,
  simulateFilterSweep,
  simulateSquareSweep,
} from 'src/audio/tracker/ahx-instrument-visuals';
import { enableAhxSweep, emptyPListEntry } from 'src/audio/tracker/ahx-instrument-edit';
import parity from './fixtures/ahx-visuals-parity.json';

const karma = parseAhx(
  new Uint8Array(readFileSync(resolve(__dirname, '../../public/demos/ahx/karma.ahx'))),
);
const base = (): AhxInstrument => JSON.parse(JSON.stringify(karma.instruments[1]));
const withPList = (entries: AhxInstrument['plist']['entries'], patch: Partial<AhxInstrument> = {}): AhxInstrument => ({
  ...base(),
  ...patch,
  plist: { speed: 1, entries },
});
const row = (over: Partial<ReturnType<typeof emptyPListEntry>>) => ({ ...emptyPListEntry(), ...over });

describe('waveform shapes (E5): parity with the real gen_* functions', () => {
  const wlOf = (len: number): number => Math.log2(len / 4);

  it('triangle is byte-identical to gen_triangle at every length', () => {
    for (const [len, expected] of Object.entries(parity.triangle)) {
      expect(ahxWaveShape('triangle', wlOf(Number(len)))).toEqual(expected);
    }
  });

  it('sawtooth is byte-identical to gen_sawtooth at every length', () => {
    for (const [len, expected] of Object.entries(parity.sawtooth)) {
      expect(ahxWaveShape('sawtooth', wlOf(Number(len)))).toEqual(expected);
    }
  });

  it('a shape has 4 << waveLength samples, and the wave length is clamped to the engine 0..5', () => {
    for (let wl = 0; wl <= 5; wl++) {
      for (const kind of ['triangle', 'sawtooth', 'square'] as const) {
        expect(ahxWaveShape(kind, wl, 8)!.length).toBe(4 << wl);
      }
    }
    expect(ahxWaveShape('triangle', 9)!.length).toBe(128);
    expect(ahxWaveShape('triangle', -3)!.length).toBe(4);
  });

  it('noise has no shape', () => {
    expect(ahxWaveShape('noise', 3)).toBeNull();
  });

  it('a square reads the real gen_square table the way calc_square does (row + stride)', () => {
    const table = parity.squareTable;
    for (let wl = 0; wl <= 5; wl++) {
      for (const pos of [0, 1, 2, 7, 8, 16, 31, 32, 33, 40, 63, 64]) {
        const rowIndex = ahxSquareRow(pos, wl);
        const delta = 32 >> wl;
        const expected = Array.from({ length: 4 << wl }, (_, i) => table[rowIndex * 128 + i * delta]);
        expect(ahxWaveShape('square', wl, pos), `wl ${wl} pos ${pos}`).toEqual(expected);
      }
    }
  });

  it('square row pick: scaled by the wave length, mirrored above 0x20, position 0 reads row 0', () => {
    expect(ahxSquareRow(8, 3)).toBe(31); // 8 << 2 = 0x20: the 50% row
    expect(ahxSquareRow(0, 5)).toBe(0);
    expect(ahxSquareRow(1, 5)).toBe(0);
    expect(ahxSquareRow(40, 5)).toBe(23); // 40 > 0x20 -> 0x40 - 40 = 24 -> row 23
    expect(ahxSquareRow(64, 5)).toBe(0); // 0x40 - 0x40 = 0
    expect(ahxSquareDuty(8, 3)).toBe(0.5);
    expect(ahxSquareDuty(0, 5)).toBe(1 / 64);
    for (let pos = 0; pos < 64; pos++) expect(ahxSquareDuty(pos, 5)).toBeLessThanOrEqual(0.5);
  });

  it('a square has the duty its row promises (row r has r + 1 of 64 high)', () => {
    const shape = ahxWaveShape('square', 5, 16)!;
    expect(shape.filter((v) => v === 127).length).toBe(32);
    const thin = ahxWaveShape('square', 5, 2)!;
    expect(thin.filter((v) => v === 127).length).toBe(4); // row 1 -> 2/64 of 128 samples
  });

  it('ahxShapePath draws one flat step per sample', () => {
    const path = ahxShapePath([0, 127, 0, -128], 100, 50);
    expect(path.startsWith('M0.0 ')).toBe(true);
    expect(path.split(' L').length - 1).toBe(7); // 4 samples: 1 M + 7 L
    expect(ahxShapePath([], 10, 10)).toBe('');
  });
});

describe('vibrato (E9)', () => {
  it('VIB_TAB is the real table, and is trunc(255 sin(2 pi i / 64)) for all 64 entries', () => {
    expect([...AHX_VIB_TAB]).toEqual(parity.vibTab);
    AHX_VIB_TAB.forEach((value, i) => {
      expect(value, `entry ${i}`).toBe(Math.trunc(255 * Math.sin((2 * Math.PI * i) / 64)));
    });
  });

  it('depth 0 is off: a flat line of zeros', () => {
    expect(simulateAhxVibrato(5, 8, 0, 30).every((v) => v === 0)).toBe(true);
  });

  it('is flat for the delay, then follows VIB_TAB[cur] * depth >> 7, cur stepping by speed', () => {
    const out = simulateAhxVibrato(3, 4, 15, 12);
    expect(out.slice(0, 3)).toEqual([0, 0, 0]);
    expect(out[3]).toBe(0); // VIB_TAB[0]
    expect(out[4]).toBe((97 * 15) >> 7); // VIB_TAB[4]
    expect(out[5]).toBe((180 * 15) >> 7); // VIB_TAB[8]
  });

  it('floors negative products (arithmetic shift), as the engine does', () => {
    const out = simulateAhxVibrato(0, 33, 15, 2); // cur 0 then 33: VIB_TAB[33] = -24
    expect(out[1]).toBe((-24 * 15) >> 7);
    expect(out[1]).toBe(-3);
  });

  it('speed 0 holds one point, and the amplitude is 255 * depth >> 7', () => {
    expect(new Set(simulateAhxVibrato(0, 0, 9, 40)).size).toBe(1);
    expect(ahxVibratoAmplitude(15)).toBe(29);
    expect(ahxVibratoAmplitude(1)).toBe(1);
  });

  it('the downward swing is what the floored table really reaches, one more than the upward one at depth 1', () => {
    expect(ahxVibratoTrough(1)).toBe(2);
    for (let depth = 1; depth <= 15; depth++) {
      const out = simulateAhxVibrato(0, 1, depth, 64);
      expect(Math.max(...out), `depth ${depth}`).toBe(ahxVibratoAmplitude(depth));
      expect(-Math.min(...out), `depth ${depth}`).toBe(ahxVibratoTrough(depth));
    }
  });

  it('only speed & 63 counts: 0, 32, 64, 128 and 192 never wobble, 33-63 walk backwards', () => {
    for (const speed of [0, 32, 64, 128, 192]) {
      expect(new Set(simulateAhxVibrato(0, speed, 15, 80)).size, `speed ${speed}`).toBe(1);
      expect(ahxVibratoStep(speed).still, `speed ${speed}`).toBe(true);
    }
    expect(ahxVibratoStep(63)).toMatchObject({ step: 63, forward: 1, backwards: true, still: false });
    expect(ahxVibratoStep(65)).toMatchObject({ step: 1, forward: 1, backwards: false });
    expect(new Set(simulateAhxVibrato(0, 8, 15, 80)).size).toBeGreaterThan(1);
  });

  it('the window covers the delay plus two wobbles', () => {
    expect(ahxVibratoWindow(0, 8)).toBe(48);
    expect(ahxVibratoWindow(255, 1)).toBe(255 + 128 + 8);
    expect(ahxVibratoWindow(255, 1)).toBeLessThanOrEqual(400);
    expect(ahxVibratoWindow(20, 4)).toBe(60);
  });
});

describe('sweeps (E8): parity with the real FilterSweep / SquareSweep', () => {
  const filterIns = (speed: number, lower: number, upper: number): AhxInstrument => ({
    ...base(),
    filterSpeed: speed,
    filterLowerLimit: lower,
    filterUpperLimit: upper,
  });

  it('every filter sweep trace matches the Rust position for position', () => {
    for (const c of parity.filter) {
      const trace = simulateFilterSweep(filterIns(c.speed, c.lower, c.upper), 160, c.sign as 1 | -1);
      expect(trace, JSON.stringify([c.speed, c.lower, c.upper, c.sign])).toEqual(c.trace);
    }
  });

  it('every square sweep trace matches the Rust position for position', () => {
    for (const c of parity.square) {
      const ins: AhxInstrument = {
        ...base(),
        squareSpeed: c.speed,
        squareLowerLimit: c.lower,
        squareUpperLimit: c.upper,
        waveLength: c.waveLength,
      };
      const trace = simulateSquareSweep(ins, 160, c.start, c.sign as 1 | -1);
      expect(trace, JSON.stringify([c.speed, c.lower, c.upper, c.waveLength, c.start, c.sign])).toEqual(c.trace);
    }
  });

  it('bounds are swapped when lower > upper, and the square limits shift with the wave length', () => {
    expect(ahxFilterBounds(filterIns(4, 40, 10))).toEqual({ lower: 10, upper: 40 });
    expect(ahxSquareBounds({ ...base(), squareLowerLimit: 200, squareUpperLimit: 40, waveLength: 4 })).toEqual({
      lower: 20,
      upper: 100,
    });
  });

  it('the square duty range covers every position between the bounds, including the peak the mirror makes', () => {
    // karma #2: limits 8..63 at wave length 3 -> positions 2..15, x = pos << 2 = 8..60: rises to 50% at x = 32, falls to 6%
    const ins = { ...base(), squareLowerLimit: 8, squareUpperLimit: 63, waveLength: 3 };
    const range = ahxSquareDutyRange(ins);
    expect(range.max).toBe(0.5);
    expect(range.min).toBe(ahxSquareDuty(15, 3)); // the far end, 4/64
    expect(range.min).toBeLessThan(ahxSquareDuty(2, 3)); // thinner than the near end (8/64)
    // a range that never reaches the mirror stays between its two ends
    const low = { ...base(), squareLowerLimit: 4, squareUpperLimit: 20, waveLength: 5 };
    expect(ahxSquareDutyRange(low)).toEqual({ min: 4 / 64, max: 20 / 64 });
  });

  it('equal limits are NOT "no sweep": there is nothing to bounce between, so the engine runs straight past them', () => {
    // Real Rust traces (fixture): the filter climbs 32, 34, 36 ... and the square keeps walking up from 60.
    const filter = parity.filter.find((c) => c.lower === c.upper)!;
    expect(filter.trace.slice(0, 4)).toEqual([32, 34, 36, 38]);
    const square = parity.square.find((c) => c.lower === c.upper)!;
    expect(square.trace[square.trace.length - 1]).toBeGreaterThan(square.start);
    expect(simulateFilterSweep(filterIns(3, 32, 32), 4)).toEqual([32, 34, 36, 38, 40]);
  });

  it('a sweep window is between 60 and 300 frames and longer for a slow sweep', () => {
    const fast = ahxSweepWindow('filter', { lower: 10, upper: 40 }, 4);
    const slow = ahxSweepWindow('filter', { lower: 10, upper: 40 }, 30);
    expect(fast).toBeGreaterThanOrEqual(60);
    expect(slow).toBe(300);
    expect(ahxSweepWindow('square', { lower: 3, upper: 3 }, 0)).toBe(60);
  });

  it('speed is a delay: a bigger number is slower, for both sweeps', () => {
    expect(ahxSweepRate('square', 0)).toEqual({ every: 1, steps: 1 });
    expect(ahxSweepRate('square', 6)).toEqual({ every: 6, steps: 1 });
    expect(ahxSweepRate('filter', 0)).toEqual({ every: 1, steps: 5 });
    expect(ahxSweepRate('filter', 3)).toEqual({ every: 1, steps: 2 });
    expect(ahxSweepRate('filter', 10)).toEqual({ every: 7, steps: 1 });
  });
});

describe('what switches a sweep on (the "sweep is off" state)', () => {
  it('finds a square toggle (4/00) and the square wave a row selects', () => {
    const ins = withPList([row({ waveform: 3, fx: [4, 0], fxParam: [0, 0] })]);
    const setup = ahxSweepSetup(ins, 'square');
    expect(setup).toMatchObject({ toggled: true, row: 0, sign: 1, hasSquareWave: true });
    expect(ahxSweepState(setup, 'square')).toBe('on');
  });

  it('a toggle with no square-wave row is off for the square, and says why', () => {
    const ins = withPList([row({ waveform: 1, fx: [4, 0], fxParam: [0, 0] })]);
    expect(ahxSweepState(ahxSweepSetup(ins, 'square'), 'square')).toBe('no-square-row');
  });

  it('no toggle at all is off', () => {
    const ins = withPList([row({ waveform: 3 })]);
    expect(ahxSweepState(ahxSweepSetup(ins, 'square'), 'square')).toBe('no-toggle');
    expect(ahxSweepState(ahxSweepSetup(ins, 'filter'), 'filter')).toBe('no-toggle');
  });

  it('nibbles: low is the square, high the filter; 0xf heads down; 4/00 is square only', () => {
    const both = withPList([row({ fx: [4, 0x1f], fxParam: [0x1f, 0] })]);
    expect(ahxSweepSetup(both, 'square', { format: 'ahx', version: 1 })).toMatchObject({ toggled: true, sign: -1 });
    expect(ahxSweepSetup(both, 'filter', { format: 'ahx', version: 1 })).toMatchObject({ toggled: true, sign: 1 });
    const filterDown = withPList([row({ fx: [4, 0], fxParam: [0xf0, 0] })]);
    expect(ahxSweepSetup(filterDown, 'filter')).toMatchObject({ toggled: true, sign: -1 });
    expect(ahxSweepSetup(filterDown, 'square').toggled).toBe(false);
    const squareOnly = withPList([row({ fx: [4, 0], fxParam: [0, 0] })]);
    expect(ahxSweepSetup(squareOnly, 'filter').toggled).toBe(false);
  });

  it('a version-0 AHX file drops the filter nibble, so the filter sweep is unavailable there', () => {
    const ins = withPList([row({ fx: [4, 0], fxParam: [0x10, 0] })]);
    const setup = ahxSweepSetup(ins, 'filter', { format: 'ahx', version: 0 });
    expect(ahxSweepState(setup, 'filter')).toBe('unavailable');
    expect(canEnableAhxSweep(ins, 'filter', { format: 'ahx', version: 0 })).toBe(false);
    // ...but an HVL file, or version 1, keeps it
    expect(ahxSweepSetup(ins, 'filter', { format: 'hvl', version: 0 }).toggled).toBe(true);
  });

  it('command 3 gives the square sweep its start position (scaled by the wave length)', () => {
    const ins = withPList([row({ fx: [3, 4], fxParam: [0x20, 0] })], { waveLength: 3 });
    expect(ahxSweepSetup(ins, 'square').startPos).toBe(0x20 >> 2);
  });

  it('ahxUsesFilter: a set position other than 32, or a filter sweep', () => {
    expect(ahxUsesFilter(withPList([row({})]))).toBe(false);
    expect(ahxUsesFilter(withPList([row({ fx: [0, 0], fxParam: [32, 0] })]))).toBe(false);
    expect(ahxUsesFilter(withPList([row({ fx: [0, 0], fxParam: [20, 0] })]))).toBe(true);
    expect(ahxUsesFilter(withPList([row({ fx: [4, 0], fxParam: [0x10, 0] })]))).toBe(true);
  });
});

describe('enableAhxSweep ("Turn on at row 0")', () => {
  it('adds a 4/10 filter toggle in a free slot of row 0, leaving the rest alone', () => {
    const ins = withPList([row({ fx: [5, 0], fxParam: [3, 0] })]);
    const next = enableAhxSweep(ins, 'filter');
    expect(next.plist.entries[0]).toMatchObject({ fx: [5, 4], fxParam: [3, 0x10] });
    expect(ahxSweepState(ahxSweepSetup(next, 'filter'), 'filter')).toBe('on');
    expect(ins.plist.entries[0]!.fx).toEqual([5, 0]); // input untouched
  });

  it('a square sweep also switches row 0 to the square wave when no row uses it', () => {
    const ins = withPList([row({ waveform: 1 })]);
    const next = enableAhxSweep(ins, 'square');
    expect(next.plist.entries[0]).toMatchObject({ waveform: 3, fx: [4, 0], fxParam: [0, 0] });
    expect(ahxSweepState(ahxSweepSetup(next, 'square'), 'square')).toBe('on');
  });

  it('an empty PList gets a row 0', () => {
    const next = enableAhxSweep(withPList([]), 'filter');
    expect(next.plist.entries).toHaveLength(1);
    expect(ahxSweepState(ahxSweepSetup(next, 'filter'), 'filter')).toBe('on');
  });

  it('already toggled but without a square wave: only the wave is added', () => {
    const ins = withPList([row({ fx: [4, 0], fxParam: [0, 0] }), row({})]);
    const next = enableAhxSweep(ins, 'square');
    expect(next.plist.entries[0]).toMatchObject({ waveform: 3, fx: [4, 0] });
    expect(next.plist.entries).toHaveLength(2);
  });

  it('changes nothing when row 0 has no free slot, or the file cannot toggle the filter', () => {
    const full = withPList([row({ fx: [5, 1], fxParam: [1, 2] })]);
    expect(canEnableAhxSweep(full, 'square')).toBe(false);
    expect(enableAhxSweep(full, 'square')).toBe(full);
    expect(enableAhxSweep(withPList([row({})]), 'filter', { format: 'ahx', version: 0 }).plist.entries[0]!.fx).toEqual([0, 0]);
  });
});
