// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ahxNoteFromTrackerText,
  ahxPositionPatternId,
  buildAhxTrackerPatterns,
  parseAhx,
  type AhxSong,
  type TrackerEntryData,
} from '@another-synth/tracker-playback';
import { BLANK_STEP, docFromBytes, docToSong, entriesToTrack, projectAhxPatterns, tracksEqual, type AhxDocTrack } from 'src/audio/tracker/ahx-doc';
import { ahxCorpus } from './helpers/ahx-doc-fixtures';

const karma = ahxCorpus().find((f) => f.name === 'karma.ahx')!;
const step = (note: number, instrument = 0, fx = 0, fxParam = 0) => ({ note, instrument, fx, fxParam, fxb: 0, fxbParam: 0 });

/** A song whose only track holds notes at the edges of what a step can carry: 1, 60, 61, 62, 63. */
function edgeSong(): AhxSong {
  const base = parseAhx(karma.bytes);
  const notes = [1, 60, 61, 62, 63];
  return {
    ...base,
    trackLength: 8,
    positionNr: 1,
    positions: [{ track: [1, 0, 0, 0], transpose: [0, 0, 0, 0] }],
    tracks: [
      Array.from({ length: 8 }, () => ({ ...BLANK_STEP })),
      Array.from({ length: 8 }, (_, row) => (row < notes.length ? step(notes[row]!, 1 + (row % 2), 0xc, 0x10 + row) : { ...BLANK_STEP })),
    ],
    trackNr: 1,
  };
}

describe('buildAhxTrackerPatterns options (the library)', () => {
  const song = parseAhx(karma.bytes);

  it('with no options, is what it always was: latched instruments, clamped notes, random ids', () => {
    const plain = buildAhxTrackerPatterns(song);
    const explicit = buildAhxTrackerPatterns(song, { latchInstruments: true, stableIds: false, clampNotes: true });
    expect(plain.map((p) => p.tracks)).toEqual(explicit.map((p) => p.tracks));
    for (const pattern of plain) expect(pattern.id).toMatch(/^[0-9a-f-]{36}$/);
    // The latch: some row shows an instrument its step does not have.
    const latched = plain.some((pattern, p) =>
      pattern.tracks.some((track, ch) =>
        track.entries.some((entry) => entry.instrument !== undefined && song.tracks[song.positions[p]!.track[ch]!]![entry.row]!.instrument === 0),
      ),
    );
    expect(latched).toBe(true);
  });

  it('stableIds: the id of a position is ahx-pos-<n>, the same on every call', () => {
    const a = buildAhxTrackerPatterns(song, { stableIds: true });
    const b = buildAhxTrackerPatterns(song, { stableIds: true });
    expect(a.map((p) => p.id)).toEqual(song.positions.map((_, i) => `ahx-pos-${i}`));
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
    expect(ahxPositionPatternId(7)).toBe('ahx-pos-7');
  });

  it('latchInstruments: false shows an instrument only where the step has one', () => {
    const raw = buildAhxTrackerPatterns(song, { latchInstruments: false });
    raw.forEach((pattern, p) =>
      pattern.tracks.forEach((track, ch) => {
        for (const entry of track.entries) {
          const s = song.tracks[song.positions[p]!.track[ch]!]![entry.row]!;
          expect(entry.instrument !== undefined, `${p}.${ch}.${entry.row}`).toBe(s.instrument > 0);
        }
      }),
    );
  });

  it('clampNotes: notes 61..63 keep their own names (C-6, C#6, D-6); by default they read as 60', () => {
    const song61 = edgeSong();
    const clamped = buildAhxTrackerPatterns(song61)[0]!.tracks[0]!.entries.map((e) => e.note);
    expect(clamped).toEqual(['C-1', 'B-5', 'B-5', 'B-5', 'B-5']);
    const raw = buildAhxTrackerPatterns(song61, { clampNotes: false })[0]!.tracks[0]!.entries.map((e) => e.note);
    expect(raw).toEqual(['C-1', 'B-5', 'C-6', 'C#6', 'D-6']);
  });
});

describe('ahxNoteFromTrackerText', () => {
  it('is the inverse of the note text, for every note the format holds (1..63)', () => {
    for (let note = 1; note <= 63; note++) {
      const song = edgeSong();
      song.tracks[1] = Array.from({ length: 8 }, () => step(note));
      const text = buildAhxTrackerPatterns(song, { clampNotes: false })[0]!.tracks[0]!.entries[0]!.note;
      expect(ahxNoteFromTrackerText(text), `note ${note} as "${text}"`).toBe(note);
    }
  });

  it('is undefined for what is not a step note', () => {
    for (const text of [undefined, '', '###', '---', 'B-0', 'D#6', 'C-7', 'X-3', '12']) {
      expect(ahxNoteFromTrackerText(text), String(text)).toBeUndefined();
    }
    expect(ahxNoteFromTrackerText('C-1')).toBe(1);
    expect(ahxNoteFromTrackerText('D-6')).toBe(63);
  });
});

describe('the projection, and entriesToTrack as its inverse', () => {
  it('projectAhxPatterns uses the three options', () => {
    const doc = docFromBytes(karma.bytes);
    const patterns = projectAhxPatterns(doc);
    expect(patterns.map((p) => p.id)).toEqual(doc.positions.map((_, i) => ahxPositionPatternId(i)));
    const song = docToSong(doc, []);
    expect(song.positions).toBe(doc.positions);
  });

  it('a step with note 61, 62 or 63 survives its effect being edited (the clamp is not a lossy round trip)', () => {
    const song = edgeSong();
    const patterns = buildAhxTrackerPatterns(song, { latchInstruments: false, stableIds: true, clampNotes: false });
    const entries: TrackerEntryData[] = patterns[0]!.tracks[0]!.entries.map((e) => ({ ...e }));
    for (const entry of entries) {
      // What the editor does when the user retypes the effect of a row.
      delete entry.effectCommand;
      delete entry.effectParam;
      entry.macro = 'F07';
    }
    const back = entriesToTrack(entries, 8) as AhxDocTrack;
    expect(Array.isArray(back)).toBe(true);
    expect(back.slice(0, 5).map((s) => s.note)).toEqual([1, 60, 61, 62, 63]);
    expect(back.slice(0, 5).map((s) => [s.fx, s.fxParam])).toEqual(Array.from({ length: 5 }, () => [0xf, 7]));
  });

  it('the instrument and the note are independent: an effect-only entry has no instrument, a note-only entry has no effect', () => {
    const back = entriesToTrack([{ row: 0, macro: 'C40' }, { row: 1, note: 'C-3' }], 4) as AhxDocTrack;
    expect(back[0]).toEqual(step(0, 0, 0xc, 0x40));
    expect(back[1]).toEqual(step(25));
    expect(tracksEqual(back.slice(2) as AhxDocTrack, [BLANK_STEP, BLANK_STEP])).toBe(true);
  });

  it('reads the macro the way the editor writes it: hex digits, dots are 0, case does not matter', () => {
    const back = entriesToTrack(
      [
        { row: 0, macro: 'F..' },
        { row: 1, macro: '.A.' },
        { row: 2, macro: 'f1e' },
        { row: 3, macro: '...' },
        { row: 4, effectCommand: 4, effectParam: 0x2a },
        { row: 5, macro: '5FF', effectCommand: 1, effectParam: 1 },
      ],
      6,
    ) as AhxDocTrack;
    expect(back.map((s) => [s.fx, s.fxParam])).toEqual([
      [0xf, 0],
      [0, 0xa0],
      [0xf, 0x1e],
      [0, 0],
      [4, 0x2a],
      [5, 0xff],
    ]);
  });

  it('refuses, naming the row, what a step cannot hold', () => {
    const refusal = (entry: TrackerEntryData, trackLength = 8): string => {
      const r = entriesToTrack([entry], trackLength);
      expect('error' in r).toBe(true);
      return (r as { error: string }).error;
    };
    expect(refusal({ row: 2, volume: '40' })).toMatch(/Row 2: AHX steps have no volume column/);
    expect(refusal({ row: 2, volumeCommand: '60' })).toMatch(/volume column/);
    expect(refusal({ row: 3, macro2: 'F01' })).toMatch(/Row 3: AHX steps have one effect column/);
    expect(refusal({ row: 3, frequency: 440 })).toMatch(/Row 3: .*frequency/);
    expect(refusal({ row: 1, note: '###' })).toMatch(/Row 1: "###" is not a note/);
    expect(refusal({ row: 1, note: 'D#6' })).toMatch(/not a note an AHX step can hold/);
    expect(refusal({ row: 1, note: 'B-0' })).toMatch(/not a note/);
    expect(refusal({ row: 1, instrument: '64' })).toMatch(/instruments go up to 63/);
    expect(refusal({ row: 1, instrument: 'ab' })).toMatch(/not an instrument number/);
    expect(refusal({ row: 1, macro: 'G00' })).toMatch(/not an AHX effect/);
    expect(refusal({ row: 1, macro: 'F0' })).toMatch(/not an AHX effect/);
    expect(refusal({ row: 8 })).toMatch(/Row 8 is outside this song's tracks \(8 rows\)/);
    expect(refusal({ row: -1 })).toMatch(/Row -1/);
    expect(refusal({ row: 1, effectCommand: 16, effectParam: 0 })).toMatch(/does not fit/);
    const twice = entriesToTrack([{ row: 1, note: 'C-3' }, { row: 1, note: 'C-4' }], 8);
    expect((twice as { error: string }).error).toMatch(/Row 1 appears twice/);
  });

  it('empty fields are absent fields', () => {
    const back = entriesToTrack([{ row: 0, note: '', instrument: '', macro: '', volume: '', macro2: '' }], 2) as AhxDocTrack;
    expect(back[0]).toEqual(BLANK_STEP);
  });

  it('accepts the instrument with or without its padding, 0 and 63 included', () => {
    const back = entriesToTrack(
      [{ row: 0, instrument: '07' }, { row: 1, instrument: '7' }, { row: 2, instrument: '63' }, { row: 3, instrument: '00' }],
      4,
    ) as AhxDocTrack;
    expect(back.map((s) => s.instrument)).toEqual([7, 7, 63, 0]);
  });
});
