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
