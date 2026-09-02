import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

/**
 * User settings interface
 * Centralized storage for all user preferences
 */
export interface UserSettings {
  /**
   * Schema version of the persisted settings blob. Absent (or 0) means the
   * pre-versioning format. See `migrateSettingsVersion`.
   */
  settingsVersion: number;
  theme: string;
  trackerFont: string;
  uiFont: string;
  showSpectrumAnalyzer: boolean;
  showWaveformVisualizers: boolean;
  /**
   * 0.0 to 1.0. Defaults to half scale for headroom, not to taste: nothing in
   * the tracker path limits, so a multi-channel module sums straight past full
   * scale -- see the level meters beside the instrument list.
   */
  masterVolume: number;
  enableMidi: boolean;
  /** When true, show a second effect column per tracker track. */
  showTrackerExtraEffectColumn: boolean;
  /**
   * When true, the pattern grid renders through the canvas renderer
   * (PatternCanvas.vue) instead of the DOM grid (TrackerPattern.vue).
   * Default: false — the canvas renderer is opt-in until its remaining
   * rough edges (per-pattern-swap frame stall, upcoming-pattern pre-render)
   * are worked out; the toolbar toggle turns it on for testing.
   */
  canvasPatternRenderer: boolean;
  /** When true, MOD files use lightweight Web Audio playback instead of full WASM synth. Default: true. */
  useSimplifiedModInstruments: boolean;

  /**
   * Offline oversampling factor for tracker samples, or 1 to disable.
   *
   * Web Audio resamples buffer sources with linear interpolation and offers no
   * say in it. Oversampling with a windowed sinc at load moves the content two
   * octaves down relative to the buffer, where that interpolation costs about
   * 0.1 dB instead of 1.8. Costs this multiple in sample memory.
   */
  sampleOversampleFactor: number;

  /** Centre samples that sit off zero, so they do not thump on note-on. */
  sampleRemoveDcOffset: boolean;

  /**
   * Crossfade length, in frames, for the seam of a forward loop; 0 disables.
   *
   * Off by default: it removes the tick from a loop whose ends do not meet,
   * but FT2 does not do it, so it changes how a module sounds rather than
   * only how cleanly it is reproduced.
   */
  sampleLoopCrossfadeFrames: number;

  /**
   * Filter samples played above their own pitch, to stop content folding.
   *
   * Oversampling cannot help with this -- the fold happens at the output,
   * after the buffer is read -- so notes played an octave or more up need a
   * copy with the offending content already removed.
   */
  sampleAntiAliasHighNotes: boolean;

  /**
   * AudioContext sample rate in Hz.
   *
   * A higher rate raises the graph's Nyquist, so what does fold lands further
   * out and is less audible. The browser resamples to the device rate at the
   * output. Applied when the audio context is created, so a change takes
   * effect on reload; a rate the browser refuses falls back to 44.1 kHz.
   */
  audioSampleRate: number;
}

/**
 * Current settings schema version.
 *
 * v1: `useSimplifiedModInstruments` became the default for MOD playback.
 *
 * v2: `canvasPatternRenderer` was version-gated to false. The canvas
 * renderer is experimental: until the upcoming-pattern pre-render lands,
 * every pattern swap pays a ~30-100ms full-bitmap paint, so the shipped
 * default keeps the DOM grid and the toolbar toggle opts in for testing.
 * The version gate still rewrites the stored value once — see
 * `migrateSettingsVersion` — so a user who enabled the renderer under the
 * earlier force-on default is put back on the DOM grid exactly once, and
 * re-enabling it afterwards sticks.
 *
 * Note that the master-volume default moving from 0.75 to 0.5 deliberately did
 * *not* get a version bump: it is a starting point rather than a correction, so
 * anyone who has already set their own level keeps it.
 */
export const SETTINGS_VERSION = 2;

/**
 * Default user settings. Exported so tests can pin the ones that are
 * deliberate rather than arbitrary.
 */
export const defaultSettings: UserSettings = {
  settingsVersion: SETTINGS_VERSION,
  theme: 'custom',
  trackerFont: 'JetBrains Mono',
  uiFont: 'Inter',
  showSpectrumAnalyzer: true,
  showWaveformVisualizers: true,
  masterVolume: 0.5,
  enableMidi: false,
  showTrackerExtraEffectColumn: false,
  canvasPatternRenderer: false,
  useSimplifiedModInstruments: true,
  sampleOversampleFactor: 4,
  sampleRemoveDcOffset: true,
  sampleLoopCrossfadeFrames: 0,
  sampleAntiAliasHighNotes: true,
  audioSampleRate: 96000,
};

const STORAGE_KEY = 'synth-user-settings';

/**
 * Migrate old settings format to new format
 */
function migrateOldSettings(): Partial<UserSettings> {
  const migrated: Partial<UserSettings> = {};

  // Migrate old theme setting (stored directly as 'tracker-theme')
  try {
    const oldTheme = localStorage.getItem('tracker-theme');
    if (oldTheme) {
      migrated.theme = oldTheme;
      // Clean up old key
      localStorage.removeItem('tracker-theme');
      console.log('Migrated theme setting from old format:', oldTheme);
    }
  } catch (error) {
    console.warn('Failed to migrate old theme setting:', error);
  }

  return migrated;
}

/**
 * Upgrade a persisted settings blob to the current schema version.
 *
 * Merging stored-over-defaults is NOT enough to roll out a changed default:
 * `saveSettings` persists the entire object on any change, so every existing
 * user already has an explicit value for every key and would never observe a
 * new default. Version-gated rewrites are how a default change actually
 * reaches them.
 *
 * Exported for tests.
 */
export function migrateSettingsVersion(
  stored: Partial<UserSettings>
): Partial<UserSettings> {
  const migrated: Partial<UserSettings> = { ...stored };
  const version = migrated.settingsVersion ?? 0;

  // v0 -> v1: MOD files now default to the ModInstrument playback path, which
  // is what MOD imports are actually tuned against. The stored `false` here is
  // almost always the old default rather than a deliberate choice, so it is
  // overwritten once. Users who prefer the full WASM synth can turn it back
  // off in Settings, and that choice sticks (this branch never runs again).
  if (version < 1) {
    migrated.useSimplifiedModInstruments = true;
  }

  // v1 -> v2: the canvas pattern renderer goes back to opt-in. Same
  // version-gated rewrite as the v1 change above: the stored value is
  // overwritten exactly once (the renderer shipped briefly on by default,
  // but every pattern swap stalls the frame until the pre-render lands),
  // and an explicit later choice sticks.
  if (version < 2) {
    migrated.canvasPatternRenderer = false;
  }

  migrated.settingsVersion = SETTINGS_VERSION;
  return migrated;
}

/**
 * Load settings from localStorage
 */
function loadSettings(): UserSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<UserSettings>;
      // Merge with defaults to handle missing keys
      return { ...defaultSettings, ...migrateSettingsVersion(parsed) };
    } else {
      // Check for old format settings to migrate
      const migrated = migrateOldSettings();
      if (Object.keys(migrated).length > 0) {
        return { ...defaultSettings, ...migrated };
      }
    }
  } catch (error) {
    console.warn('Failed to load user settings from localStorage:', error);
  }
  return { ...defaultSettings };
}

/**
 * Save settings to localStorage
 */
function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('Failed to save user settings to localStorage:', error);
  }
}

/**
 * User settings store
 * Manages all user preferences with automatic localStorage persistence
 */
export const useUserSettingsStore = defineStore('userSettings', () => {
  const settings = ref<UserSettings>(loadSettings());

  // Watch for changes and auto-save to localStorage
  watch(
    settings,
    (newSettings) => {
      saveSettings(newSettings);
    },
    { deep: true }
  );

  /**
   * Update a specific setting
   */
  function updateSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
    settings.value[key] = value;
  }

  /**
   * Reset all settings to defaults
   */
  function resetSettings(): void {
    settings.value = { ...defaultSettings };
  }

  return {
    settings,
    updateSetting,
    resetSettings
  };
});
