import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  defaultAudioSampleRate,
  defaultLookaheadSeconds,
  defaultSampleOversampleFactor,
  isTouchAudioDevice,
} from 'src/audio/device-profile';
import { migrateSettingsVersion } from 'src/stores/user-settings-store';

/**
 * The audio defaults were chosen on a desktop and shipped to everything: a
 * 96 kHz context (double the cost of every node in the graph, then an output
 * resample, because no handheld runs its hardware there) and 4x sample
 * oversampling (four times the resident sample memory and four times the
 * read bandwidth per voice, on the render thread). Both are read once -- at
 * context construction and at sample load -- so getting them wrong is not
 * something the app can correct later.
 */
const original = window.matchMedia;

function stubMatchMedia(matches: (query: string) => boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: matches(query),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

const asTouchDevice = () => stubMatchMedia((q) => q.includes('pointer: coarse'));
const asDesktop = () => stubMatchMedia(() => false);

afterEach(() => {
  window.matchMedia = original;
});

describe('device profile', () => {
  it('reads the device, not the window size', () => {
    // A narrowed desktop window is still a desktop -- which is why this is
    // not `useMobileLayout`, whose query deliberately follows the viewport.
    const seen: string[] = [];
    stubMatchMedia((q) => {
      seen.push(q);
      return false;
    });
    isTouchAudioDevice();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/max-width/);
    expect(seen[0]).toContain('hover: none');
  });

  it('gives a handheld the rate its hardware runs at', () => {
    asTouchDevice();
    expect(defaultAudioSampleRate()).toBe(48000);
  });

  it('leaves the desktop rate alone', () => {
    asDesktop();
    expect(defaultAudioSampleRate()).toBe(96000);
  });

  it('turns sample oversampling off on a handheld', () => {
    asTouchDevice();
    expect(defaultSampleOversampleFactor()).toBe(1);
    asDesktop();
    expect(defaultSampleOversampleFactor()).toBe(4);
  });

  it('widens the scheduling window on a handheld', () => {
    asTouchDevice();
    const touch = defaultLookaheadSeconds();
    asDesktop();
    expect(touch).toBeGreaterThan(defaultLookaheadSeconds());
  });

  it('falls back to the desktop profile where matchMedia is missing', () => {
    // jsdom-without-matchMedia, SSR and old WebViews all land here; guessing
    // handheld would give the tests and the dev server an audio path the app
    // has never used.
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(isTouchAudioDevice()).toBe(false);
    expect(defaultAudioSampleRate()).toBe(96000);
  });
});

describe('settings migration v3 -> v4', () => {
  it('moves a handheld off the desktop audio defaults, once', () => {
    asTouchDevice();
    const migrated = migrateSettingsVersion({
      settingsVersion: 3,
      audioSampleRate: 96000,
      sampleOversampleFactor: 4,
    });
    expect(migrated.audioSampleRate).toBe(48000);
    expect(migrated.sampleOversampleFactor).toBe(1);
  });

  it('keeps a value the user chose by hand', () => {
    asTouchDevice();
    const migrated = migrateSettingsVersion({
      settingsVersion: 3,
      audioSampleRate: 44100,
      sampleOversampleFactor: 2,
    });
    expect(migrated.audioSampleRate).toBe(44100);
    expect(migrated.sampleOversampleFactor).toBe(2);
  });

  it('changes nothing on a desktop', () => {
    asDesktop();
    const migrated = migrateSettingsVersion({
      settingsVersion: 3,
      audioSampleRate: 96000,
      sampleOversampleFactor: 4,
    });
    expect(migrated.audioSampleRate).toBe(96000);
    expect(migrated.sampleOversampleFactor).toBe(4);
  });
});

describe('migration persistence', () => {
  /**
   * A migration that only lives in memory is not a migration.
   *
   * `AudioSystem` reads `audioSampleRate` out of localStorage directly -- it
   * builds the context before Pinia is necessarily available, and the rate is
   * fixed for the life of that context. So a migrated value that never
   * reaches storage never reaches the engine: the handheld default was
   * computed on every load, and every load still built a 96 kHz context.
   */
  it('writes the migrated blob back to storage on load', async () => {
    asTouchDevice();
    localStorage.setItem(
      'synth-user-settings',
      JSON.stringify({ settingsVersion: 3, audioSampleRate: 96000 }),
    );

    const { createPinia, setActivePinia } = await import('pinia');
    setActivePinia(createPinia());
    const { useUserSettingsStore } = await import(
      'src/stores/user-settings-store'
    );
    useUserSettingsStore();

    const stored = JSON.parse(
      localStorage.getItem('synth-user-settings') ?? '{}',
    ) as { audioSampleRate?: number; settingsVersion?: number };
    expect(stored.audioSampleRate).toBe(48000);
    expect(stored.settingsVersion).toBe(4);
  });
});
