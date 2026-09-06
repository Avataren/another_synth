import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  preferredLatencyHint,
  preferredLatencyMode,
} from 'src/audio/AudioSystem';

/**
 * `latencyHint` is fixed for the life of an AudioContext, so getting this
 * wrong is not something the app can correct later -- it needs a reload.
 *
 * The rule: the device picks the default (a handheld gets a middling buffer,
 * a desktop the smallest one the device offers), and a stored user setting
 * overrides it in either direction.
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

function storeSettings(blob: unknown) {
  localStorage.setItem('synth-user-settings', JSON.stringify(blob));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  window.matchMedia = original;
  localStorage.clear();
});

describe('preferredLatencyHint', () => {
  it('asks a touch-primary device for the balanced buffer', () => {
    stubMatchMedia((q) => q.includes('pointer: coarse'));
    expect(preferredLatencyMode()).toBe('balanced');
    expect(preferredLatencyHint()).toBe(0.1);
  });

  it('asks for interactive latency on a pointer device', () => {
    stubMatchMedia(() => false);
    expect(preferredLatencyMode()).toBe('low');
    expect(preferredLatencyHint()).toBe('interactive');
  });

  it('honours a stored setting over the device default', () => {
    stubMatchMedia((q) => q.includes('pointer: coarse'));
    storeSettings({ audioLatencyMode: 'safe' });
    expect(preferredLatencyHint()).toBe('playback');

    storeSettings({ audioLatencyMode: 'low' });
    expect(preferredLatencyHint()).toBe('interactive');
  });

  it('ignores a stored value that is not a mode', () => {
    stubMatchMedia(() => false);
    storeSettings({ audioLatencyMode: 'enormous' });
    expect(preferredLatencyMode()).toBe('low');
  });

  it('queries the device, not the window size', () => {
    // A narrowed desktop window is still a desktop: it keeps the low-latency
    // context. This is why the check is not `useMobileLayout`, whose query
    // deliberately follows the viewport.
    const seen: string[] = [];
    stubMatchMedia((q) => {
      seen.push(q);
      return false;
    });
    preferredLatencyHint();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/max-width/);
    expect(seen[0]).toContain('hover: none');
  });

  it('falls back to interactive where matchMedia is missing', () => {
    // jsdom-without-matchMedia, SSR, and old WebViews all land here.
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(preferredLatencyHint()).toBe('interactive');
  });
});
