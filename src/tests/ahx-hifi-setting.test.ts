import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defaultSettings, useUserSettingsStore } from 'src/stores/user-settings-store';

describe('ahxHifi', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('defaults to on: band-limited, for anyone who never touches it', () => {
    expect(defaultSettings.ahxHifi).toBe(true);
    expect(useUserSettingsStore().settings.ahxHifi).toBe(true);
  });

  it('a settings blob saved before the option existed loads with the default', () => {
    localStorage.setItem('synth-user-settings', JSON.stringify({ settingsVersion: 99, theme: 'custom' }));
    expect(useUserSettingsStore().settings.ahxHifi).toBe(true);
  });

  it('a v0.3.49 blob (opt-in era, explicit false) loads with hi-fi on', () => {
    localStorage.setItem(
      'synth-user-settings',
      JSON.stringify({ settingsVersion: 5, theme: 'custom', ahxHifi: false }),
    );
    expect(useUserSettingsStore().settings.ahxHifi).toBe(true);
  });

  it('the escape hatch survives a reload: turning it off is persisted and sticks', () => {
    useUserSettingsStore().updateSetting('ahxHifi', false);
    return Promise.resolve().then(() => {
      setActivePinia(createPinia());
      expect(useUserSettingsStore().settings.ahxHifi).toBe(false);
    });
  });
});
