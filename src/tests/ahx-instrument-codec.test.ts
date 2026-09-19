// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AHX_MAX_PLIST_ENTRIES,
  AhxInstrumentEncodeError,
  ahxInstrumentProblem,
  normalizeAhxInstrumentForVersion,
  parseAhx,
  sanitizeAhxInstrument,
  serializeAhxInstrument,
  type AhxInstrument,
} from '@another-synth/tracker-playback';

const DEMOS = resolve(__dirname, '../../public/demos/ahx');
const demos = readdirSync(DEMOS)
  .filter((name) => /\.(ahx|hvl)$/.test(name))
  .sort()
  .map((name) => ({ name, bytes: new Uint8Array(readFileSync(resolve(DEMOS, name))) }));

/**
 * Where `wire` occurs in `file`, ignoring what the loader does not read: core
 * bytes 9..=11, and the top two bits of byte 19 (the filter upper limit is 6
 * bits).
 */
function findInstrument(file: Uint8Array, wire: Uint8Array): number {
  outer: for (let at = 0; at + wire.length <= file.length; at++) {
    for (let i = 0; i < wire.length; i++) {
      if (i >= 9 && i <= 11) continue;
      const mask = i === 19 ? 0x3f : 0xff;
      if ((file[at + i]! & mask) !== (wire[i]! & mask)) continue outer;
    }
    return at;
  }
  return -1;
}

const clone = (ins: AhxInstrument): AhxInstrument => JSON.parse(JSON.stringify(ins));

describe('AHX instrument wire form', () => {
  it('is the file’s own byte layout for every instrument of every demo', () => {
    let checked = 0;
    for (const { name, bytes } of demos) {
      const song = parseAhx(bytes);
      // A version-0 AHX file's loader strips filter parameters the file stores
      // wider, so its instruments are not byte-for-byte what the file holds.
      if (song.format === 'ahx' && song.version === 0) continue;
      for (let n = 1; n <= song.instrumentNr; n++) {
        const wire = serializeAhxInstrument(song.instruments[n]!, song.format);
        expect(findInstrument(bytes, wire), `${name} instrument ${n}`).toBeGreaterThan(-1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('accepts every parsed instrument as valid', () => {
    for (const { name, bytes } of demos) {
      const song = parseAhx(bytes);
      for (let n = 1; n <= song.instrumentNr; n++) {
        expect(ahxInstrumentProblem(song.instruments[n], song.format), `${name} #${n}`).toBeNull();
      }
    }
  });

  it('has the sizes the layout says', () => {
    const song = parseAhx(demos.find((d) => d.name === 'karma.ahx')!.bytes);
    const ins = song.instruments[1]!;
    expect(serializeAhxInstrument(ins).length).toBe(22 + 4 * ins.plist.entries.length);
    expect(serializeAhxInstrument(ins, 'hvl').length).toBe(22 + 5 * ins.plist.entries.length);
  });

  it('refuses a value that does not fit instead of truncating it', () => {
    const song = parseAhx(demos.find((d) => d.name === 'karma.ahx')!.bytes);
    const base = song.instruments[1]!;
    const bad = (edit: (ins: AhxInstrument) => void): void => {
      const ins = clone(base);
      edit(ins);
      expect(() => serializeAhxInstrument(ins)).toThrow(AhxInstrumentEncodeError);
    };
    bad((i) => (i.waveLength = 8));
    bad((i) => (i.filterSpeed = 64));
    bad((i) => (i.filterUpperLimit = 64));
    bad((i) => (i.vibratoDepth = 16));
    bad((i) => (i.hardCutReleaseFrames = 8));
    bad((i) => (i.volume = 256));
    bad((i) => (i.volume = 1.5));
    bad((i) => (i.envelope.aFrames = -1));
    bad((i) => (i.plist.entries = Array.from({ length: AHX_MAX_PLIST_ENTRIES + 1 }, () => clone(base).plist.entries[0]!)));
    // AHX's 3-bit command has no code for 7; the row says which one.
    bad((i) => i.plist.entries.push({ note: 0, waveform: 0, fixed: false, fx: [7, 0], fxParam: [0, 0] }));
    bad((i) => i.plist.entries.push({ note: 64, waveform: 0, fixed: false, fx: [0, 0], fxParam: [0, 0] }));
    // ...which an HVL PList can hold.
    const hvl = clone(base);
    hvl.plist.entries.push({ note: 3, waveform: 2, fixed: true, fx: [7, 9], fxParam: [1, 2] });
    expect(() => serializeAhxInstrument(hvl, 'hvl')).not.toThrow();
  });

  it('turns crafted garbage into a reason, never an exception', () => {
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      'x',
      [],
      {},
      { name: 'x' },
      { ...clone(parseAhx(demos[0]!.bytes).instruments[1]!), plist: null },
      { ...clone(parseAhx(demos[0]!.bytes).instruments[1]!), envelope: 'loud' },
      { ...clone(parseAhx(demos[0]!.bytes).instruments[1]!), plist: { speed: 1, entries: [null] } },
      { ...clone(parseAhx(demos[0]!.bytes).instruments[1]!), plist: { speed: 1, entries: [{ note: 1 }] } },
      { ...clone(parseAhx(demos[0]!.bytes).instruments[1]!), volume: NaN },
      { ...clone(parseAhx(demos[0]!.bytes).instruments[1]!), volume: Infinity },
    ];
    for (const value of garbage) {
      expect(() => ahxInstrumentProblem(value)).not.toThrow();
      expect(ahxInstrumentProblem(value)).toEqual(expect.any(String));
      expect(sanitizeAhxInstrument(value)).toBeUndefined();
    }
  });

  it('hands back a copy of a valid instrument', () => {
    const ins = parseAhx(demos[0]!.bytes).instruments[1]!;
    const copy = sanitizeAhxInstrument(ins);
    expect(copy).toEqual(ins);
    expect(copy).not.toBe(ins);
    expect(copy!.plist).not.toBe(ins.plist);
  });
});

describe('normalizeAhxInstrumentForVersion', () => {
  const withRow = (fx: [number, number], fxParam: [number, number]): AhxInstrument => {
    const base = structuredClone(parseAhx(demos[0]!.bytes).instruments[1]!);
    base.plist.entries = [{ note: 5, waveform: 2, fixed: false, fx, fxParam }];
    return base;
  };

  it('a version-0 AHX file loses the high nibble of a filter-toggle parameter, on either command', () => {
    const out = normalizeAhxInstrumentForVersion(withRow([4, 4], [0xa7, 0xb3]), 'ahx', 0);
    expect(out.plist.entries[0]!.fxParam).toEqual([0x07, 0x03]);
  });

  it('touches no other command, no other version and no other format', () => {
    const ins = withRow([5, 4], [0xa7, 0xb3]);
    expect(normalizeAhxInstrumentForVersion(ins, 'ahx', 0).plist.entries[0]!.fxParam).toEqual([0xa7, 0x03]);
    for (const [format, version] of [['ahx', 1], ['ahx', 2], ['hvl', 0], ['hvl', 1]] as const) {
      expect(normalizeAhxInstrumentForVersion(ins, format, version)).toBe(ins);
    }
  });

  it('is what gets written: the wire form carries the stripped parameter', () => {
    const ins = withRow([4, 0], [0xa7, 0]);
    const wire = serializeAhxInstrument(ins, 'ahx');
    const stripped = normalizeAhxInstrumentForVersion(ins, 'ahx', 0);
    expect(serializeAhxInstrument(stripped, 'ahx')[22 + 2]).toBe(0x07);
    expect(wire[22 + 2]).toBe(0xa7);
  });

  it('returns the very instrument when nothing needs stripping', () => {
    const ins = withRow([4, 0], [0x07, 0]);
    expect(normalizeAhxInstrumentForVersion(ins, 'ahx', 0)).toBe(ins);
  });
});
