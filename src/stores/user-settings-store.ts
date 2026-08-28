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
  masterVolume: number; // 0.0 to 1.0
  enableMidi: boolean;
  /** When true, show a second effect column per tracker track. */
  showTrackerExtraEffectColumn: boolean;
  /** When true, MOD files use lightweight Web Audio playback instead of full WASM synth. Default: true. */
  useSimplifiedModInstruments: boolean;
}

/**
 * Current settings schema version.
 *
 * v1: `useSimplifiedModInstruments` became the default for MOD playback.
 */
export const SETTINGS_VERSION = 1;

/**
 * Default user settings
 */
const defaultSettings: UserSettings = {
  settingsVersion: SETTINGS_VERSION,
  theme: 'custom',
  trackerFont: 'JetBrains Mono',
  uiFont: 'Inter',
  showSpectrumAnalyzer: true,
  showWaveformVisualizers: true,
  masterVolume: 0.75,
  enableMidi: false,
  showTrackerExtraEffectColumn: false,
  useSimplifiedModInstruments: true
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
