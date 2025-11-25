import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

/**
 * User settings interface
 * Centralized storage for all user preferences
 */
export interface UserSettings {
  theme: string;
  // Future settings can be added here:
  // volume: number;
  // midiDeviceId: string;
  // etc.
}

/**
 * Default user settings
 */
const defaultSettings: UserSettings = {
  theme: 'default'
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
 * Load settings from localStorage
 */
function loadSettings(): UserSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<UserSettings>;
      // Merge with defaults to handle missing keys
      return { ...defaultSettings, ...parsed };
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
