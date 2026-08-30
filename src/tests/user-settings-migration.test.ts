import { describe, it, expect } from 'vitest';
import {
  defaultSettings,
  migrateSettingsVersion,
  SETTINGS_VERSION,
  type UserSettings,
} from 'src/stores/user-settings-store';

describe('migrateSettingsVersion', () => {
  it('flips the pre-versioning MOD-instrument default to on', () => {
    // A user who has ever touched any setting has the whole object persisted,
    // including an explicit `useSimplifiedModInstruments: false` that would
    // otherwise survive a change to `defaultSettings` forever.
    const stored: Partial<UserSettings> = {
      theme: 'custom',
      useSimplifiedModInstruments: false,
    };

    const migrated = migrateSettingsVersion(stored);

    expect(migrated.useSimplifiedModInstruments).toBe(true);
    expect(migrated.settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('preserves unrelated stored settings', () => {
    const stored: Partial<UserSettings> = {
      theme: 'dark',
      masterVolume: 0.25,
      enableMidi: true,
    };

    const migrated = migrateSettingsVersion(stored);

    expect(migrated.theme).toBe('dark');
    expect(migrated.masterVolume).toBe(0.25);
    expect(migrated.enableMidi).toBe(true);
  });

  it('leaves an explicit opt-out alone once the blob is versioned', () => {
    // Having run the v0 -> v1 rewrite once, a later deliberate "off" must stick.
    const stored: Partial<UserSettings> = {
      settingsVersion: SETTINGS_VERSION,
      useSimplifiedModInstruments: false,
    };

    const migrated = migrateSettingsVersion(stored);

    expect(migrated.useSimplifiedModInstruments).toBe(false);
  });
});

/**
 * The master-volume default is headroom, not taste.
 *
 * Nothing in the tracker path limits -- FT2 sums into an accumulator and
 * clamps, Paula sums in analog -- so a multi-channel module runs past full
 * scale at unity. elw-sick.xm (24 channels) needs roughly half to stay under,
 * which is what the level meters beside the instrument list are for.
 *
 * It is deliberately *not* version-gated: unlike the v1 rewrite above this is
 * a starting point rather than a correction, so a level someone has already
 * chosen is theirs to keep.
 */
describe('master volume default', () => {
  it('starts at half scale', () => {
    expect(defaultSettings.masterVolume).toBe(0.5);
  });

  it('leaves an already-stored level alone', () => {
    const migrated = migrateSettingsVersion({
      settingsVersion: 0,
      masterVolume: 0.9,
    });

    expect(migrated.masterVolume).toBe(0.9);
  });
});

/**
 * Sample-quality defaults.
 *
 * These are on by default because they make playback more faithful to the
 * source rather than changing it: Web Audio's own interpolation is the thing
 * being worked around. The loop crossfade is the exception -- it departs from
 * what FastTracker 2 does, so it is opt-in.
 *
 * New fields need no migration: `loadSettings` spreads defaults under whatever
 * was stored, so an existing blob picks them up.
 */
describe('sample quality defaults', () => {
  it('oversamples by default, at 4x', () => {
    expect(defaultSettings.sampleOversampleFactor).toBe(4);
  });

  it('anti-aliases high notes and removes DC by default', () => {
    expect(defaultSettings.sampleAntiAliasHighNotes).toBe(true);
    expect(defaultSettings.sampleRemoveDcOffset).toBe(true);
  });

  it('leaves loop seams alone by default', () => {
    // A departure from FT2, so it is the user's choice to make.
    expect(defaultSettings.sampleLoopCrossfadeFrames).toBe(0);
  });

  it('asks for 96 kHz by default', () => {
    // Deliberately above the usual 48: it costs CPU across the whole graph but
    // moves what aliasing remains further out of the way, and a browser that
    // will not run it falls back to 44.1 rather than failing.
    expect(defaultSettings.audioSampleRate).toBe(96000);
  });

  it('leaves already-stored choices alone', () => {
    const migrated = migrateSettingsVersion({
      settingsVersion: 0,
      sampleOversampleFactor: 1,
      audioSampleRate: 96000,
    });

    expect(migrated.sampleOversampleFactor).toBe(1);
    expect(migrated.audioSampleRate).toBe(96000);
  });
});
