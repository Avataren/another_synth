import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  defaultSettings,
  useUserSettingsStore,
} from 'src/stores/user-settings-store';
import { useThemeStore } from 'src/stores/theme-store';
import { complementOf } from 'src/utils/theme-palette';
import { nextTick } from 'vue';

/** The CSS variable the analyzers paint their primary color from. */
function complementVar(): string {
  return document.documentElement.style.getPropertyValue('--tracker-accent-complement');
}

function accentVar(): string {
  return document.documentElement.style.getPropertyValue('--tracker-accent-primary');
}

describe('analyzerComplementColors', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('defaults to on', () => {
    expect(defaultSettings.analyzerComplementColors).toBe(true);
    expect(useUserSettingsStore().settings.analyzerComplementColors).toBe(true);
  });

  it('paints the analyzer variable with the complement while on', () => {
    useThemeStore();
    expect(complementVar()).toBe(complementOf(accentVar()));
  });

  it('falls the analyzers back onto the accents when turned off', async () => {
    const settings = useUserSettingsStore();
    useThemeStore();

    settings.updateSetting('analyzerComplementColors', false);
    await nextTick();

    expect(complementVar()).toBe(accentVar());
  });

  it('restores the complement when turned back on', async () => {
    const settings = useUserSettingsStore();
    useThemeStore();

    settings.updateSetting('analyzerComplementColors', false);
    await nextTick();
    settings.updateSetting('analyzerComplementColors', true);
    await nextTick();

    expect(complementVar()).toBe(complementOf(accentVar()));
  });
});
