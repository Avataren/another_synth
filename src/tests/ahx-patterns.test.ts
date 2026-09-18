/**
 * P1 -- `buildAhxTrackerPatterns` (`import/ahx-patterns.ts`), against the
 * same real karma.ahx fixture `ahx-parser.test.ts` pins the raw decode for.
 *
 * AHX has no single "pattern" object (a position addresses one track number
 * per channel independently), so these check the position-to-pattern
 * assembly and the row-model shape rather than re-deriving playback
 * semantics -- pitch/effect interpretation is explicitly out of scope for
 * this phase (see the module comment in ahx-patterns.ts).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAhx,
  buildAhxTrackerPatterns,
  formatInstrumentId,
} from '@another-synth/tracker-playback';

const CORPUS_DIR = path.resolve(__dirname, '../../public/demos/ahx');

function readFixture(name: string): Uint8Array {
  const buf = fs.readFileSync(path.join(CORPUS_DIR, name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe('buildAhxTrackerPatterns: karma.ahx', () => {
  const song = parseAhx(readFixture('karma.ahx'));
  const patterns = buildAhxTrackerPatterns(song);

  it('produces one pattern per position, with the song track length as row count', () => {
    expect(patterns).toHaveLength(song.positionNr);
    for (const pattern of patterns) {
      expect(pattern.rows).toBe(song.trackLength);
      expect(pattern.tracks).toHaveLength(song.channels);
    }
  });

  it('assembles the first position from its four per-channel tracks', () => {
    const pos0 = song.positions[0]!;
    expect(pos0.track).toEqual([12, 13, 23, 56]);

    const pattern0 = patterns[0]!;
    for (let ch = 0; ch < 4; ch++) {
      const track = pattern0.tracks[ch]!;
      const sourceTrack = song.tracks[pos0.track[ch]!]!;
      const expectedEntryRows = sourceTrack
        .map((step, row) => ({ step, row }))
        .filter(({ step }) => step.note > 0 || step.instrument > 0 || step.fx !== 0 || step.fxParam !== 0)
        .map(({ row }) => row);
      expect(track.entries.map((e) => e.row)).toEqual(expectedEntryRows);
    }
  });

  it('stamps the raw effect bytes and a presentation macro on every effect row', () => {
    const firstTrackWithEffect = song.tracks.find((t) =>
      t.some((step) => step.fx !== 0 || step.fxParam !== 0),
    )!;
    const trackIndex = song.tracks.indexOf(firstTrackWithEffect);
    const positionIndex = song.positions.findIndex((p) => p.track.includes(trackIndex));
    expect(positionIndex).toBeGreaterThanOrEqual(0);

    const channel = song.positions[positionIndex]!.track.indexOf(trackIndex);
    const entries = patterns[positionIndex]!.tracks[channel]!.entries;

    for (const step of firstTrackWithEffect) {
      if (step.fx === 0 && step.fxParam === 0) continue;
      const row = firstTrackWithEffect.indexOf(step);
      const entry = entries.find((e) => e.row === row);
      expect(entry, `row ${row}`).toBeDefined();
      expect(entry!.effectCommand).toBe(step.fx);
      expect(entry!.effectParam).toBe(step.fxParam);
      expect(entry!.macro).toBe(
        `${step.fx.toString(16).toUpperCase()}${step.fxParam.toString(16).toUpperCase().padStart(2, '0')}`,
      );
    }
  });

  it('latches the channel instrument across rows and positions, like MOD/S3M', () => {
    // Walk channel 0 across every position, tracking the instrument that
    // should be latched (last non-zero instrument byte seen), and check
    // every entry that carries an instrument agrees with the latch.
    let latched = 0;
    for (let p = 0; p < song.positionNr; p++) {
      const trackNumber = song.positions[p]!.track[0]!;
      const steps = song.tracks[trackNumber]!;
      const entries = patterns[p]!.tracks[0]!.entries;
      for (let row = 0; row < song.trackLength; row++) {
        const step = steps[row];
        if (!step) continue;
        if (step.instrument > 0) latched = step.instrument;
        const entry = entries.find((e) => e.row === row);
        if (!entry) continue;
        if (latched > 0) {
          expect(entry.instrument, `position ${p} row ${row}`).toBe(formatInstrumentId(latched));
        } else {
          expect(entry.instrument, `position ${p} row ${row}`).toBeUndefined();
        }
      }
    }
  });

  it('does not resolve a playable frequency (deferred to the engine phase)', () => {
    for (const pattern of patterns) {
      for (const track of pattern.tracks) {
        for (const entry of track.entries) {
          expect(entry.frequency).toBeUndefined();
        }
      }
    }
  });
});

describe('buildAhxTrackerPatterns: chiprolled.hvl second effect column (fxb/fxbParam)', () => {
  const song = parseAhx(readFixture('chiprolled.hvl'));
  const patterns = buildAhxTrackerPatterns(song);

  it('stamps macro2 from fxb/fxbParam alongside a first-column command', () => {
    // Track 1, row 0: note 28, instrument 1, fx=7/fxParam=0 *and*
    // fxb=15/fxbParam=7 -- both columns populated on the same row.
    const step = song.tracks[1]![0]!;
    expect(step).toEqual({
      note: 28,
      instrument: 1,
      fx: 7,
      fxParam: 0,
      fxb: 15,
      fxbParam: 7,
    });

    const position0 = patterns[0]!;
    const entry = position0.tracks[0]!.entries.find((e) => e.row === 0);
    expect(entry).toBeDefined();
    expect(entry!.effectCommand).toBe(7);
    expect(entry!.effectParam).toBe(0);
    expect(entry!.macro).toBe('700');
    expect(entry!.macro2).toBe('F07');
  });

  it('keeps a row that carries only a second-column command (previously dropped)', () => {
    // Track 75, row 2: no note, no instrument, fx/fxParam both zero, only
    // fxb=12/fxbParam=142 -- the exact "column-2-only" row the MAJOR finding
    // flagged as silently dropped.
    const step = song.tracks[75]![2]!;
    expect(step).toEqual({
      note: 0,
      instrument: 0,
      fx: 0,
      fxParam: 0,
      fxb: 12,
      fxbParam: 142,
    });

    // Position 184, channel 1 addresses track 75.
    const position = patterns[184]!;
    expect(song.positions[184]!.track[1]).toBe(75);
    const entry = position.tracks[1]!.entries.find((e) => e.row === 2);
    expect(entry).toBeDefined();
    expect(entry!.note).toBeUndefined();
    expect(entry!.effectCommand).toBeUndefined();
    expect(entry!.effectParam).toBeUndefined();
    expect(entry!.macro).toBeUndefined();
    expect(entry!.macro2).toBe('C8E');
  });

  it('never sets macro2 for karma.ahx, which has no second effect column', () => {
    const ahxSong = parseAhx(readFixture('karma.ahx'));
    const ahxPatterns = buildAhxTrackerPatterns(ahxSong);
    for (const pattern of ahxPatterns) {
      for (const track of pattern.tracks) {
        for (const entry of track.entries) {
          expect(entry.macro2).toBeUndefined();
        }
      }
    }
  });
});

describe('buildAhxTrackerPatterns: channel clamp', () => {
  it('never builds more tracks than the engine plays (16), even if the header claims more', () => {
    const hvl = parseAhx(readFixture('doobrey_gubbins.hvl'));
    expect(hvl.channels).toBeLessThanOrEqual(16);
    const malformed = { ...hvl, channels: 40 };
    for (const pattern of buildAhxTrackerPatterns(malformed)) {
      expect(pattern.tracks).toHaveLength(16);
    }
  });

  it('still builds a native HVL channel count below the clamp', () => {
    const hvl = parseAhx(readFixture('doobrey_gubbins.hvl'));
    expect(buildAhxTrackerPatterns(hvl)[0]!.tracks).toHaveLength(hvl.channels);
  });
});
