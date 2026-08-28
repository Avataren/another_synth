import { describe, it, expect } from 'vitest';
import {
  PROTRACKER_PROFILE,
  XM_PROFILE,
  NATIVE_PROFILE,
  profileForFormat,
  type FormatProfile,
} from '../../packages/tracker-playback/src/format-profile';
import { createAmigaPitchModel } from '../../packages/tracker-playback/src/pitch-model';
import {
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
} from '../../packages/tracker-playback/src/effect-processor';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type { EffectCommand, Song } from '../../packages/tracker-playback/src/types';

/**
 * The FormatProfile is the mechanism the rest of Phase 2 hangs off: format
 * differences live as data rather than as conditionals spread through the
 * effect handlers. These tests check that the wiring genuinely reaches the
 * effect processor, so later commits can migrate behaviours one at a time and
 * trust the plumbing.
 */
function makeSong(moduleFormat: Song['moduleFormat']): Song {
  return {
    title: '',
    author: '',
    bpm: 125,
    ...(moduleFormat ? { moduleFormat } : {}),
    patterns: [{ id: 'p', length: 4, tracks: [] }],
    sequence: ['p'],
  };
}

describe('profileForFormat', () => {
  it('maps each format to its profile', () => {
    expect(profileForFormat('protracker')).toBe(PROTRACKER_PROFILE);
    expect(profileForFormat('xm')).toBe(XM_PROFILE);
    expect(profileForFormat('native')).toBe(NATIVE_PROFILE);
  });

  it('falls back to ProTracker for an unknown or missing format', () => {
    expect(profileForFormat(undefined)).toBe(PROTRACKER_PROFILE);
    expect(
      profileForFormat('nonsense' as unknown as Song['moduleFormat']),
    ).toBe(PROTRACKER_PROFILE);
  });

  it('describes ProTracker with its known quirks enabled', () => {
    expect(PROTRACKER_PROFILE.noteDelayOverflowCarries).toBe(true);
    expect(PROTRACKER_PROFILE.volumeSlideUnit).toBeCloseTo(1 / 64, 10);
    expect(PROTRACKER_PROFILE.pitch.kind).toBe('amiga');
  });
});

describe('engine resolves a profile from the song', () => {
  it('adopts the profile matching the song format', () => {
    const engine = new PlaybackEngine();
    engine.loadSong(makeSong('xm'));
    expect(engine.getFormatProfile()).toBe(XM_PROFILE);
  });

  it('falls back to the native profile for an untagged song', () => {
    const engine = new PlaybackEngine();
    engine.loadSong(makeSong(undefined));
    expect(engine.getFormatProfile()).toBe(NATIVE_PROFILE);
  });
});

describe('the effect processor reads the profile', () => {
  const volSlide: EffectCommand = { type: 'volSlide', paramX: 0, paramY: 6 };

  function slideOneRow(profile: FormatProfile) {
    const state = createTrackEffectState(profile);
    processEffectTick0(state, undefined, 60, 255);
    processEffectTick0(state, volSlide, undefined);
    for (let tick = 1; tick < 6; tick++) {
      processEffectTickN(state, volSlide, tick, 6);
    }
    return state.currentVolume;
  }

  it('uses the profile’s volume slide unit rather than a hardcoded constant', () => {
    // A profile with half-size units must halve the slide; if the constant
    // were still inlined this would be indistinguishable from the default.
    const halfUnit: FormatProfile = {
      ...PROTRACKER_PROFILE,
      volumeSlideUnit: 1 / 128,
    };

    const normal = 1 - slideOneRow(PROTRACKER_PROFILE);
    const halved = 1 - slideOneRow(halfUnit);

    expect(normal).toBeCloseTo((5 * 6) / 64, 6);
    expect(halved).toBeCloseTo(normal / 2, 6);
  });

  it('defaults to ProTracker semantics when no profile is given', () => {
    const state = createTrackEffectState();
    expect(state.profile).toBe(PROTRACKER_PROFILE);
  });

  it('honours arpeggioWrapsToDC when the arpeggio runs off the table', () => {
    // Base period 113 is the top of the table, so +12 semitones overflows.
    const arp: EffectCommand = { type: 'arpeggio', paramX: 0xc, paramY: 0 };

    // Tick 0 is what latches arpeggioX/arpeggioY from the parameter.
    const runArpeggio = (profile: FormatProfile) => {
      const state = createTrackEffectState(profile);
      processEffectTick0(state, arp, undefined);
      state.currentPeriod = 113;
      return processEffectTickN(state, arp, 1, 6);
    };

    const wrapped = runArpeggio(PROTRACKER_PROFILE);
    const clamped = runArpeggio({
      ...PROTRACKER_PROFILE,
      pitch: createAmigaPitchModel({ arpeggioWrapsToDC: false }),
    });

    const pitchOf = (batch: ReturnType<typeof processEffectTickN>) => {
      const cmd = batch.commands.find((c) => c.kind === 'pitch');
      return cmd && 'frequency' in cmd ? cmd.frequency : undefined;
    };

    // ProTracker's overflow lands on period 0, i.e. DC / zero frequency.
    expect(pitchOf(wrapped)).toBe(0);
    // Clamping keeps a real pitch instead.
    expect(pitchOf(clamped)).toBeGreaterThan(0);
  });
});
