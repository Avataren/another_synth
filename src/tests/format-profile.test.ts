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

/**
 * ProTracker has no volume-slide memory: A00 means "no volume change".
 * FastTracker 2 reuses the last non-zero parameter. Across a 20-module
 * sample, 569 of 27378 Axx commands carry a zero parameter (27% of them in
 * resii.mod), so this is a difference real songs depend on.
 */
describe('volume slide memory differs by format', () => {
  const slide = (param: number): EffectCommand => ({
    type: 'volSlide',
    paramX: (param >> 4) & 0x0f,
    paramY: param & 0x0f,
  });

  /** Runs "A06" then "A00" and returns the volume change over the A00 row. */
  function volumeChangeOverZeroParamRow(profile: FormatProfile) {
    const state = createTrackEffectState(profile);
    processEffectTick0(state, undefined, 60, 255);

    // Establish a remembered slide.
    processEffectTick0(state, slide(0x06), undefined);
    for (let tick = 1; tick < 6; tick++) {
      processEffectTickN(state, slide(0x06), tick, 6);
    }

    const before = state.currentVolume;
    processEffectTick0(state, slide(0x00), undefined);
    for (let tick = 1; tick < 6; tick++) {
      processEffectTickN(state, slide(0x00), tick, 6);
    }
    return before - state.currentVolume;
  }

  it('holds volume steady on A00 under ProTracker', () => {
    expect(volumeChangeOverZeroParamRow(PROTRACKER_PROFILE)).toBeCloseTo(0, 9);
  });

  it('continues the remembered slide on A00 under XM', () => {
    expect(volumeChangeOverZeroParamRow(XM_PROFILE)).toBeCloseTo((5 * 6) / 64, 6);
  });

  it('keeps memory for native songs so existing work is unchanged', () => {
    expect(NATIVE_PROFILE.volumeSlideHasMemory).toBe(true);
  });

  it('still slides normally when A00 is not involved', () => {
    // Guard against "fixing" A00 by breaking ordinary slides.
    const state = createTrackEffectState(PROTRACKER_PROFILE);
    processEffectTick0(state, undefined, 60, 255);
    processEffectTick0(state, slide(0x06), undefined);
    for (let tick = 1; tick < 6; tick++) {
      processEffectTickN(state, slide(0x06), tick, 6);
    }
    expect(1 - state.currentVolume).toBeCloseTo((5 * 6) / 64, 6);
  });
});

/**
 * XM carries its frequency-table choice in the module header, not in the
 * format tag: 4 of the 9 real modules in the local corpus use the Amiga
 * table, so selecting the wrong one detunes half the corpus.
 */
describe('XM frequency table selection', () => {
  it('uses the linear model by default', () => {
    expect(profileForFormat('xm').pitch.kind).toBe('linear');
    expect(profileForFormat('xm', { linearFrequency: true }).pitch.kind).toBe(
      'linear',
    );
  });

  it('switches to the Amiga model when the header says so', () => {
    expect(profileForFormat('xm', { linearFrequency: false }).pitch.kind).toBe(
      'amiga',
    );
  });

  it('keeps every other XM behaviour identical between the two', () => {
    const linear = profileForFormat('xm', { linearFrequency: true });
    const amiga = profileForFormat('xm', { linearFrequency: false });
    expect(amiga.volumeSlideHasMemory).toBe(linear.volumeSlideHasMemory);
    expect(amiga.volumeSlideUnit).toBe(linear.volumeSlideUnit);
    expect(amiga.noteDelayOverflowCarries).toBe(linear.noteDelayOverflowCarries);
  });

  it('ignores the flag for non-XM formats', () => {
    expect(
      profileForFormat('protracker', { linearFrequency: false }),
    ).toBe(PROTRACKER_PROFILE);
  });

  it('is selected by the engine from the song', () => {
    const engine = new PlaybackEngine();
    engine.loadSong({
      title: '',
      author: '',
      bpm: 125,
      moduleFormat: 'xm',
      linearFrequency: false,
      patterns: [{ id: 'p', length: 4, tracks: [] }],
      sequence: ['p'],
    });
    expect(engine.getFormatProfile().pitch.kind).toBe('amiga');
  });
});
