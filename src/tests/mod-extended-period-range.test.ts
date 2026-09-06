import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createAmigaPitchModel,
  parseMod,
  profileForFormat,
  PROTRACKER_PROFILE,
  PROTRACKER_EXTENDED_PROFILE,
} from '@another-synth/tracker-playback';
import {
  AMIGA_CLOCK,
  PAULA_TO_SYNTH_SCALE,
} from '@another-synth/tracker-playback';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';

/**
 * ProTracker can only play the 36 periods 856..113 of its own table. Every
 * other tracker that writes the MOD format uses the seven-octave extension
 * of that table (3424..28), and OpenMPT loads *all* MODs with
 * `m_nMinPeriod = 14 * 4; m_nMaxPeriod = 3424 * 4;`, narrowing to ProTracker's
 * range only for files that pass the shape test `modUsesAmigaLimits`
 * reproduces (Load_mod.cpp).
 *
 * DOPE.MOD is the module that exposed it: a 28-channel `28CH` file in which
 * 3137 of 6589 notes sit above B-3 and 29 below C-1. Read with ProTracker's
 * clamp, 48% of the song was pinned to one of two pitches.
 */

const DEMOS = path.resolve(__dirname, '../../public/demos');

const frequencyForPeriod = (period: number) =>
  AMIGA_CLOCK / (2 * period * PAULA_TO_SYNTH_SCALE);

function readModule(relPath: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(DEMOS, relPath)));
}

describe('extended MOD period range', () => {
  describe('the pitch model', () => {
    const protracker = createAmigaPitchModel({ arpeggioWrapsToDC: true });
    const extended = createAmigaPitchModel({
      arpeggioWrapsToDC: false,
      amigaLimits: false,
    });

    it('keeps ProTracker limits when the option is absent', () => {
      // The option postdates the model; every caller that omits it wants the
      // behaviour it had.
      expect(protracker.clampPeriod(3424)).toBe(856);
      expect(protracker.clampPeriod(28)).toBe(113);
    });

    it('spans OpenMPT\'s 14..3424 when Amiga limits are off', () => {
      expect(extended.clampPeriod(3424)).toBe(3424);
      expect(extended.clampPeriod(28)).toBe(28);
      // The clamp still exists -- it is wider, not absent. 14 is one octave
      // past the top of the table, which slides may reach.
      expect(extended.clampPeriod(4000)).toBe(3424);
      expect(extended.clampPeriod(7)).toBe(14);
    });

    it('snaps glissando to the seven-octave table, not the three-octave one', () => {
      // 1712 is C-0 and 56 is B-4 in OpenMPT's ProTrackerPeriodTable; both
      // are exact entries, so snapping must return them unchanged. Under
      // ProTracker's table they collapse to the 856/113 edges.
      expect(extended.snapPeriod(1712)).toBe(1712);
      expect(extended.snapPeriod(56)).toBe(56);
      expect(protracker.snapPeriod(1712)).toBe(856);
      expect(protracker.snapPeriod(56)).toBe(113);
      // A period between two entries still snaps to the nearer one.
      expect(extended.snapPeriod(1710)).toBe(1712);
    });

    it('arpeggiates across an octave boundary the narrow table cannot reach', () => {
      // C-0 (1712) + 12 semitones is C-1 (856); the three-octave table has no
      // index for 1712 at all, so it starts from its own edge instead.
      expect(extended.arpeggioPeriod(1712, 12)).toBe(856);
      expect(extended.arpeggioPeriod(107, 3)).toBe(90); // C-4 + 3 = D#-4
    });
  });

  describe('profile selection', () => {
    it('only an explicit false widens the MOD range', () => {
      expect(profileForFormat('protracker')).toBe(PROTRACKER_PROFILE);
      expect(profileForFormat('protracker', { amigaLimits: true })).toBe(
        PROTRACKER_PROFILE,
      );
      expect(profileForFormat('protracker', { amigaLimits: false })).toBe(
        PROTRACKER_EXTENDED_PROFILE,
      );
    });

    it('changes the pitch model and nothing else about how MOD plays', () => {
      const withoutPitch = (profile: typeof PROTRACKER_PROFILE) =>
        Object.fromEntries(
          Object.entries(profile).filter(([key]) => key !== 'pitch'),
        );
      expect(withoutPitch(PROTRACKER_EXTENDED_PROFILE)).toEqual(
        withoutPitch(PROTRACKER_PROFILE),
      );
      expect(PROTRACKER_EXTENDED_PROFILE.pitch).not.toBe(
        PROTRACKER_PROFILE.pitch,
      );
    });
  });

  describe('parseMod', () => {
    it('gives DOPE.MOD the wide range and reads its full note span', () => {
      const mod = parseMod(readModule('amiga/DOPE.MOD'));
      expect(mod.signature).toBe('28CH');
      expect(mod.numChannels).toBe(28);
      expect(mod.amigaLimits).toBe(false);

      const periods = new Set<number>();
      for (const pattern of mod.patterns) {
        for (const row of pattern.rows) {
          for (const cell of row) {
            if (cell.period > 0) periods.add(cell.period);
          }
        }
      }
      // The extremes are the first and last entries of OpenMPT's
      // ProTrackerPeriodTable.
      expect(Math.max(...periods)).toBe(3424);
      expect(Math.min(...periods)).toBe(28);
    });

    it('keeps ProTracker limits for a ProTracker-shaped module', () => {
      // peacedroid.mod: M.K., every note inside the Amiga range, no sample
      // with a zero loop length -- OpenMPT's three conditions.
      const mod = parseMod(readModule('amiga/peacedroid.mod'));
      expect(mod.signature).toBe('M.K.');
      expect(mod.amigaLimits).toBe(true);
    });

    it('is a note-range test, not a channel-count test', () => {
      // purple_motion_-_sundance.mod is a 4-channel M.K. module with exactly
      // one note outside ProTracker's octaves, which is enough for OpenMPT to
      // withhold the Amiga limits ("fixes mod.mothergoose").
      const mod = parseMod(readModule('amiga/purple_motion_-_sundance.mod'));
      expect(mod.signature).toBe('M.K.');
      expect(mod.numChannels).toBe(4);
      expect(mod.amigaLimits).toBe(false);

      // ...and starlitdeception is 8 channels that never leave the range, so
      // the wide range it gets is inert.
      const eightCh = parseMod(readModule('amiga/starlitdeception.mod'));
      expect(eightCh.numChannels).toBe(8);
      expect(eightCh.amigaLimits).toBe(false);
    });
  });

  describe('import', () => {
    it('carries the flag onto the song file, false included', () => {
      const dope = importModToTrackerSong(bufferFor('amiga/DOPE.MOD'));
      expect(dope.data.amigaLimits).toBe(false);

      const peacedroid = importModToTrackerSong(bufferFor('amiga/peacedroid.mod'));
      expect(peacedroid.data.amigaLimits).toBe(true);
    });

    it('writes DOPE.MOD note frequencies from the literal period', () => {
      // The importer never clamped -- the engine did -- so this is the
      // reference the played pitch has to match.
      const dope = importModToTrackerSong(bufferFor('amiga/DOPE.MOD'));
      const written = new Set<number>();
      for (const pattern of dope.data.patterns) {
        for (const track of pattern.tracks) {
          for (const entry of track.entries) {
            if (entry.frequency !== undefined) written.add(entry.frequency);
          }
        }
      }
      const lowest = Math.min(...written);
      const highest = Math.max(...written);
      expect(lowest).toBeCloseTo(frequencyForPeriod(3424), 6);
      expect(highest).toBeCloseTo(frequencyForPeriod(28), 6);
      // Both are far outside the range ProTracker's clamp allowed.
      expect(lowest).toBeLessThan(frequencyForPeriod(856));
      expect(highest).toBeGreaterThan(frequencyForPeriod(113));
    });
  });
});

function bufferFor(relPath: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(DEMOS, relPath));
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}
