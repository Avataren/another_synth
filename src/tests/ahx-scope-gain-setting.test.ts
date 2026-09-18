import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defaultSettings, useUserSettingsStore } from 'src/stores/user-settings-store';

describe('ahxScopeGain', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('defaults to 1x: nothing changes for anyone who never touches it', () => {
    expect(defaultSettings.ahxScopeGain).toBe(1);
    expect(useUserSettingsStore().settings.ahxScopeGain).toBe(1);
  });

  it('a settings blob saved before the option existed loads with the default', () => {
    localStorage.setItem(
      'synth-user-settings',
      JSON.stringify({ settingsVersion: 99, theme: 'custom', showWaveformVisualizers: false }),
    );
    const store = useUserSettingsStore();
    expect(store.settings.ahxScopeGain).toBe(1);
    expect(store.settings.showWaveformVisualizers).toBe(false);
  });

  it('a chosen gain is kept', () => {
    const store = useUserSettingsStore();
    store.updateSetting('ahxScopeGain', 4);
    expect(store.settings.ahxScopeGain).toBe(4);
  });
});
