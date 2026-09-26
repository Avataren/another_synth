// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ahxInstrumentProblem, parseAhx, serializeAhxInstrument } from '@another-synth/tracker-playback';
import {
  NEW_AHX_SONG_NAME,
  NEW_AHX_SPEED_MULTIPLIERS,
  NEW_AHX_TRACK_LENGTHS,
  ahxSizeBudget,
  buildAhxFile,
  createNewAhxDoc,
  docFromBytes,
  docFromSong,
  isBlankTrack,
  projectAhxPatterns,
  setStep,
  type AhxDoc,
} from 'src/audio/tracker/ahx-doc';
import { DEFAULT_AHX_INSTRUMENT_NAME, defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';
import { plainDoc } from './helpers/ahx-doc-fixtures';
import { RENDER_SAMPLE_RATE, firstDifference, peak, pitchHz, renderAhx } from './helpers/ahx-render';

const slots = () => [{ ahxData: defaultAhxInstrument() }];
const build = (doc: AhxDoc, title = doc.songName) => buildAhxFile({ doc, slots: slots(), title }).bytes;
const step = (note: number, instrument = 1) => ({ note, instrument, fx: 0, fxParam: 0, fxb: 0, fxbParam: 0 });
const ok = (r: ReturnType<typeof setStep>): AhxDoc => {
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};

/** The floor an audible note has to clear: the peak of a sawtooth at this instrument's volume is far above it, silence is exactly 0. */
const AUDIBLE = 0.05;

describe('createNewAhxDoc', () => {
  const doc = createNewAhxDoc();

  it('is the smallest valid song: one position on a blank track, track 0 blank, version 1', () => {
    expect(doc.format).toBe('ahx');
    expect(doc.version).toBe(1);
    expect(doc.songName).toBe(NEW_AHX_SONG_NAME);
    expect(doc.speedMultiplier).toBe(1);
    expect(doc.trackLength).toBe(64);
    expect(doc.restart).toBe(0);
    expect(doc.subsongs).toEqual([]);
    expect(doc.positions).toEqual([{ track: [1, 0, 0, 0], transpose: [0, 0, 0, 0] }]);
    expect(doc.tracks.length).toBe(2);
    expect(doc.tracks.every((t) => t.length === 64 && isBlankTrack(t))).toBe(true);
    expect(doc.base).toBeUndefined();
    expect(Object.isFrozen(doc)).toBe(true);
  });

  it('rejects an option the format has no room for', () => {
    expect(() => createNewAhxDoc({ trackLength: 7 as never })).toThrow(/rows per track/);
    expect(() => createNewAhxDoc({ speedMultiplier: 5 as never })).toThrow(/speed multiplier/);
  });

  it('stores the name as the file can hold it', () => {
    expect(createNewAhxDoc({ name: 'Café ☃' }).songName).toBe('Café ?');
  });
});

describe('a new song as a file (no base: the writer-only path)', () => {
  it('is 273 bytes for the defaults, and parses back to the doc and its instrument', () => {
    const doc = createNewAhxDoc();
    const bytes = build(doc);
    expect(bytes.length).toBe(273);
    expect(NEW_AHX_SONG_NAME.length + 1).toBe(18);
    expect(DEFAULT_AHX_INSTRUMENT_NAME.length + 1).toBe(15);
    const parsed = parseAhx(bytes);
    expect(parsed.version).toBe(1);
    expect(parsed.instrumentNr).toBe(1);
    expect(parsed.instruments[1]).toEqual(defaultAhxInstrument());
    expect(parsed.name).toBe(NEW_AHX_SONG_NAME);
    expect(plainDoc(docFromSong(parsed))).toEqual(plainDoc(doc));
    // "track 0 blank" is written as the omitted-track flag.
    expect(bytes[6]! & 0x80).toBe(0x80);
  });

  it('is exactly 14 + 8 + 3*trackLength + 26 + the two names, for every option and name', () => {
    let combinations = 0;
    for (const trackLength of NEW_AHX_TRACK_LENGTHS) {
      for (const speedMultiplier of NEW_AHX_SPEED_MULTIPLIERS) {
        for (const name of ['', 'a', NEW_AHX_SONG_NAME, 'x'.repeat(100)]) {
          const doc = createNewAhxDoc({ trackLength, speedMultiplier, name });
          const instrument = { ...defaultAhxInstrument(), name: 'twelve chars' };
          const built = buildAhxFile({ doc, slots: [{ ahxData: instrument }], title: name || 'Imported AHX' });
          const expected = 14 + 8 + 3 * trackLength + 26 + (doc.songName.length + 1) + (instrument.name.length + 1);
          expect(built.bytes.length, `${trackLength} rows x${speedMultiplier} "${name}"`).toBe(expected);
          const parsed = parseAhx(built.bytes);
          expect(parsed.trackLength).toBe(trackLength);
          expect(parsed.speedMultiplier).toBe(speedMultiplier);
          expect(plainDoc(docFromSong(parsed))).toEqual(plainDoc(doc));
          // The size budget is the file up to its string table.
          expect(ahxSizeBudget(doc, [instrument]).used).toBe((built.bytes[4]! << 8) | built.bytes[5]!);
          combinations++;
        }
      }
    }
    expect(combinations).toBe(6 * 4 * 4);
  });

  it('a title other than the doc name is the name written, as latin-1 (and the alteration is reported)', () => {
    const doc = createNewAhxDoc();
    const built = buildAhxFile({ doc, slots: slots(), title: 'Snow☃man' });
    expect(parseAhx(built.bytes).name).toBe('Snow?man');
    expect(built.titleAltered).toBe(true);
    expect(buildAhxFile({ doc, slots: slots(), title: doc.songName }).titleAltered).toBe(false);
  });

  it('what a file built from it holds is the doc: reloading the bytes gives an equal doc and the same bytes', () => {
    const doc = ok(setStep(createNewAhxDoc({ trackLength: 16, speedMultiplier: 2 }), 1, 3, step(30)));
    const bytes = build(doc);
    const again = docFromBytes(bytes);
    expect(plainDoc(again)).toEqual(plainDoc(doc));
    expect(Array.from(build(again))).toEqual(Array.from(bytes));
    expect(projectAhxPatterns(again)).toEqual(projectAhxPatterns(doc));
  });
});

describe('a new song in the real engine', () => {
  it('loads for every track length and speed multiplier, and a blank song is silent', () => {
    for (const trackLength of NEW_AHX_TRACK_LENGTHS) {
      for (const speedMultiplier of NEW_AHX_SPEED_MULTIPLIERS) {
        const render = renderAhx(build(createNewAhxDoc({ trackLength, speedMultiplier })), 0.5);
        expect(render.events.find((e) => e.type === 'error'), `${trackLength} x${speedMultiplier}`).toBeUndefined();
        expect(render.events.find((e) => e.type === 'song-loaded')).toBeDefined();
        expect(peak(render)).toBe(0);
      }
    }
  });

  it('a step plays audibly, at two pitches that differ, and at every speed multiplier', () => {
    const low = ok(setStep(createNewAhxDoc({ trackLength: 8 }), 1, 0, step(13)));
    const high = ok(setStep(createNewAhxDoc({ trackLength: 8 }), 1, 0, step(49)));
    const lowRender = renderAhx(build(low), 1);
    const highRender = renderAhx(build(high), 1);
    expect(peak(lowRender)).toBeGreaterThan(AUDIBLE);
    expect(peak(highRender)).toBeGreaterThan(AUDIBLE);
    expect(firstDifference(lowRender, highRender)).toBeGreaterThanOrEqual(0);
    for (const speedMultiplier of NEW_AHX_SPEED_MULTIPLIERS) {
      const doc = ok(setStep(createNewAhxDoc({ trackLength: 8, speedMultiplier }), 1, 0, step(25)));
      expect(peak(renderAhx(build(doc), 1)), `x${speedMultiplier}`).toBeGreaterThan(AUDIBLE);
    }
  });

  it('a step that names no instrument the song has is silent (the engine ignores it)', () => {
    const doc = ok(setStep(createNewAhxDoc({ trackLength: 8 }), 1, 0, step(25, 2)));
    expect(peak(renderAhx(build(doc), 1))).toBe(0);
  });
});

describe('defaultAhxInstrument', () => {
  const ins = defaultAhxInstrument();

  it('is a valid instrument the writer takes, a fresh copy each time', () => {
    expect(ahxInstrumentProblem(ins, 'ahx')).toBeNull();
    expect(serializeAhxInstrument(ins).length).toBe(22 + 4 * ins.plist.entries.length);
    expect(defaultAhxInstrument()).toEqual(ins);
    expect(defaultAhxInstrument()).not.toBe(ins);
    expect(defaultAhxInstrument().plist.entries).not.toBe(ins.plist.entries);
    expect(ins.name).toBe('New instrument');
  });

  it('has an envelope that rises and falls: attack and decay are never both 0 frames', () => {
    expect(ins.envelope.aFrames + ins.envelope.dFrames).toBeGreaterThan(0);
    expect(ins.envelope.aVolume).toBeGreaterThan(0);
    expect(ins.envelope.rVolume).toBe(0);
    expect(ins.volume).toBeGreaterThan(0);
  });

  it('selects the sawtooth wave on its first PList row (waveform 2)', () => {
    expect(ins.plist.entries[0]!.waveform).toBe(2);
  });

  it('plays the key: its first row sets relative note 1, so C-4 on a fresh channel is C-4, not B-3', () => {
    // Note 0 would keep the fresh voice's pitch, 0, and play note + track - 1 (voice.rs calc_period).
    expect(ins.plist.entries[0]!.note).toBe(1);
    expect(ins.plist.entries[0]!.fixed).toBe(false);
    const doc = ok(setStep(createNewAhxDoc({ trackLength: 8 }), 1, 0, step(37)));
    const hz = pitchHz(renderAhx(build(doc), 0.4), RENDER_SAMPLE_RATE * 0.05, RENDER_SAMPLE_RATE * 0.35);
    // C-4 is 261.6 Hz, B-3 246.9: a semitone is 6 %.
    expect(Math.abs(hz / 261.63 - 1)).toBeLessThan(0.02);
  });

  it('is audible at low, middle and high pitches through the real engine', () => {
    for (const note of [1, 25, 49, 60]) {
      const doc = ok(setStep(createNewAhxDoc({ trackLength: 8 }), 1, 0, step(note)));
      expect(peak(renderAhx(build(doc), 1)), `note ${note}`).toBeGreaterThan(AUDIBLE);
    }
  });
});

describe('wave length is an octave switch (what AHX_HELP.waveLength says)', () => {
  it('plays C-4 at its written pitch at 3, and an octave up for each step down', () => {
    const doc = ok(setStep(createNewAhxDoc({ trackLength: 8 }), 1, 0, step(37)));
    const hzAt = (waveLength: number): number => {
      const bytes = buildAhxFile({ doc, slots: [{ ahxData: { ...defaultAhxInstrument(), waveLength } }], title: 'x' }).bytes;
      return pitchHz(renderAhx(bytes, 0.4), RENDER_SAMPLE_RATE * 0.05, RENDER_SAMPLE_RATE * 0.35);
    };
    const c4 = 261.63;
    for (const waveLength of [0, 1, 2, 3, 4, 5]) {
      const expected = c4 * 2 ** (3 - waveLength);
      expect(Math.abs(hzAt(waveLength) / expected - 1), `wave length ${waveLength}`).toBeLessThan(0.03);
    }
  });
});
