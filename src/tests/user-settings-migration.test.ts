import { describe, it, expect } from 'vitest';
import {
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
