import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ahxInstrumentProblem,
  parseAhx,
  serializeAhxInstrument,
  type AhxInstrument,
} from '@another-synth/tracker-playback';
import {
  AHX_MAX_WAVE_LENGTH,
  addAhxPListEntry,
  ahxEnvelopeNeverRises,
  ahxStartFilterPosition,
  ahxStartWaveform,
  canSetAhxStartFilterPosition,
  editAhxPListEntry,
  removeAhxPListEntry,
  setAhxEnvelope,
  setAhxHardCutRelease,
  setAhxNumber,
  setAhxPListSpeed,
  setAhxStartFilterPosition,
  setAhxStartWaveform,
} from 'src/audio/tracker/ahx-instrument-edit';

const karma = parseAhx(
  new Uint8Array(readFileSync(resolve(__dirname, '../../public/demos/ahx/karma.ahx'))),
);
const base = (): AhxInstrument => JSON.parse(JSON.stringify(karma.instruments[1]));
const bare = (): AhxInstrument => ({ ...base(), plist: { speed: 3, entries: [] } });

describe('AHX instrument edits', () => {
  it('never change the instrument they are given', () => {
    const ins = base();
    const before = JSON.stringify(ins);
    setAhxNumber(ins, 'volume', 3);
    setAhxEnvelope(ins, 'aFrames', 3);
    setAhxHardCutRelease(ins, true);
    setAhxPListSpeed(ins, 9);
    editAhxPListEntry(ins, 0, { field: 'note', value: 5 });
    addAhxPListEntry(ins);
    removeAhxPListEntry(ins, 0);
    setAhxStartWaveform(ins, 3);
    setAhxStartFilterPosition(ins, 9);
    expect(JSON.stringify(ins)).toBe(before);
  });

  it('clamp every number into what the format holds, so the result always serializes', () => {
    let ins = base();
    ins = setAhxNumber(ins, 'volume', 999);
    expect(ins.volume).toBe(64);
    ins = setAhxNumber(ins, 'waveLength', 7);
    expect(ins.waveLength).toBe(AHX_MAX_WAVE_LENGTH);
    ins = setAhxNumber(ins, 'filterSpeed', 100);
    expect(ins.filterSpeed).toBe(63);
    ins = setAhxNumber(ins, 'vibratoDepth', 40);
    expect(ins.vibratoDepth).toBe(15);
    ins = setAhxNumber(ins, 'squareSpeed', -5);
    expect(ins.squareSpeed).toBe(0);
    ins = setAhxNumber(ins, 'vibratoDelay', Number.NaN);
    expect(ins.vibratoDelay).toBe(0);
    ins = setAhxEnvelope(ins, 'aVolume', 200);
    expect(ins.envelope.aVolume).toBe(64);
    ins = setAhxEnvelope(ins, 'aFrames', 200);
    expect(ins.envelope.aFrames).toBe(200);
    ins = setAhxEnvelope(ins, 'rFrames', 999);
    expect(ins.envelope.rFrames).toBe(255);
    ins = setAhxNumber(ins, 'hardCutReleaseFrames', 12);
    expect(ins.hardCutReleaseFrames).toBe(7);
    expect(ahxInstrumentProblem(ins)).toBeNull();
    expect(() => serializeAhxInstrument(ins)).not.toThrow();
  });

  it('a hard cut with no frames starts at a short one; turning it off keeps the frames', () => {
    let ins = { ...base(), hardCutRelease: false, hardCutReleaseFrames: 0 };
    ins = setAhxHardCutRelease(ins, true);
    expect(ins).toMatchObject({ hardCutRelease: true, hardCutReleaseFrames: 3 });
    ins = setAhxHardCutRelease(ins, false);
    expect(ins).toMatchObject({ hardCutRelease: false, hardCutReleaseFrames: 3 });
  });

  it('spots an envelope that never rises (attack and decay both 0 frames)', () => {
    const ins = base();
    expect(ahxEnvelopeNeverRises(ins)).toBe(false);
    expect(ahxEnvelopeNeverRises(setAhxEnvelope(setAhxEnvelope(ins, 'aFrames', 0), 'dFrames', 0))).toBe(true);
  });

  describe('PList', () => {
    it('edits one field of one row', () => {
      let ins = addAhxPListEntry(bare());
      ins = editAhxPListEntry(ins, 0, { field: 'note', value: 30 });
      ins = editAhxPListEntry(ins, 0, { field: 'waveform', value: 3 });
      ins = editAhxPListEntry(ins, 0, { field: 'fixed', value: true });
      ins = editAhxPListEntry(ins, 0, { field: 'fx', slot: 1, value: 15 });
      ins = editAhxPListEntry(ins, 0, { field: 'fxParam', slot: 1, value: 0x81 });
      expect(ins.plist.entries[0]).toEqual({ note: 30, waveform: 3, fixed: true, fx: [0, 15], fxParam: [0, 0x81] });
      expect(() => serializeAhxInstrument(ins)).not.toThrow();
    });

    it('refuses a command the AHX PList has no code for, and an unknown row', () => {
      let ins = addAhxPListEntry(bare());
      const before = JSON.stringify(ins);
      ins = editAhxPListEntry(ins, 0, { field: 'fx', slot: 0, value: 7 });
      ins = editAhxPListEntry(ins, 5, { field: 'note', value: 9 });
      expect(JSON.stringify(ins)).toBe(before);
    });

    it('adds after a row or at the end, removes a row, and stops at 255 rows', () => {
      let ins = bare();
      ins = addAhxPListEntry(ins);
      ins = addAhxPListEntry(ins);
      ins = editAhxPListEntry(ins, 1, { field: 'note', value: 7 });
      ins = addAhxPListEntry(ins, 0);
      expect(ins.plist.entries.map((e) => e.note)).toEqual([0, 0, 7]);
      ins = removeAhxPListEntry(ins, 0);
      expect(ins.plist.entries.map((e) => e.note)).toEqual([0, 7]);
      ins = removeAhxPListEntry(ins, 9);
      expect(ins.plist.entries).toHaveLength(2);
      for (let i = 0; i < 300; i++) ins = addAhxPListEntry(ins);
      expect(ins.plist.entries).toHaveLength(255);
      expect(() => serializeAhxInstrument(ins)).not.toThrow();
    });

    it('sets the speed as a byte', () => {
      expect(setAhxPListSpeed(bare(), 300).plist.speed).toBe(255);
      expect(setAhxPListSpeed(bare(), 4).plist.speed).toBe(4);
    });
  });

  describe('"the waveform" is row 00’s', () => {
    it('reads and sets the first row’s waveform, adding row 00 to an empty PList', () => {
      let ins = bare();
      expect(ahxStartWaveform(ins)).toBe(0);
      ins = setAhxStartWaveform(ins, 3);
      expect(ins.plist.entries).toHaveLength(1);
      expect(ahxStartWaveform(ins)).toBe(3);
      ins = setAhxStartWaveform(ins, 2);
      expect(ins.plist.entries).toHaveLength(1);
      expect(ahxStartWaveform(ins)).toBe(2);
    });

    it('sets the filter position on a free command slot of row 00, or clears it', () => {
      let ins = bare();
      expect(canSetAhxStartFilterPosition(ins)).toBe(true);
      ins = setAhxStartFilterPosition(ins, 20);
      expect(ahxStartFilterPosition(ins)).toBe(20);
      expect(ins.plist.entries[0]).toMatchObject({ fx: [0, 0], fxParam: [20, 0] });
      ins = setAhxStartFilterPosition(ins, 33);
      expect(ins.plist.entries[0]!.fxParam).toEqual([33, 0]);
      ins = setAhxStartFilterPosition(ins, 0);
      expect(ahxStartFilterPosition(ins)).toBe(0);
      expect(setAhxStartFilterPosition(ins, 500).plist.entries[0]!.fxParam[0]).toBe(63);
    });

    it('does not overwrite another command, and says row 00 is full', () => {
      let ins = addAhxPListEntry(bare());
      ins = editAhxPListEntry(ins, 0, { field: 'fx', slot: 0, value: 1 });
      ins = editAhxPListEntry(ins, 0, { field: 'fx', slot: 1, value: 2 });
      expect(canSetAhxStartFilterPosition(ins)).toBe(false);
      expect(setAhxStartFilterPosition(ins, 9)).toEqual(ins);
    });

    it('writes a position into the slot that already holds one', () => {
      let ins = addAhxPListEntry(bare());
      ins = editAhxPListEntry(ins, 0, { field: 'fxParam', slot: 1, value: 30 });
      expect(ahxStartFilterPosition(ins)).toBe(30);
      ins = setAhxStartFilterPosition(ins, 12);
      expect(ins.plist.entries[0]!.fxParam).toEqual([0, 12]);
    });
  });
});
