import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defaultSettings, useUserSettingsStore } from 'src/stores/user-settings-store';

describe('ahxHifi', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('defaults to off: the reference render, for anyone who never touches it', () => {
    expect(defaultSettings.ahxHifi).toBe(false);
    expect(useUserSettingsStore().settings.ahxHifi).toBe(false);
  });

  it('a settings blob saved before the option existed loads with the default', () => {
    localStorage.setItem('synth-user-settings', JSON.stringify({ settingsVersion: 99, theme: 'custom' }));
    expect(useUserSettingsStore().settings.ahxHifi).toBe(false);
  });

  it('survives a reload: the choice is persisted and read back', () => {
    useUserSettingsStore().updateSetting('ahxHifi', true);
    return Promise.resolve().then(() => {
      setActivePinia(createPinia());
      expect(useUserSettingsStore().settings.ahxHifi).toBe(true);
    });
  });
});
