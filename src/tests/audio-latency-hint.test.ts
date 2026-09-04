import { describe, it, expect, afterEach, vi } from 'vitest';
import { preferredLatencyHint } from 'src/audio/AudioSystem';

/**
 * `latencyHint` is fixed for the life of an AudioContext, so getting this
 * wrong is not something the app can correct later -- it needs a reload.
 *
 * The rule: touch-primary devices get `playback`, because `interactive` asks
 * for a buffer they cannot fill without underrunning. Everything else, and
 * anything unknown, gets `interactive`.
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

afterEach(() => {
  window.matchMedia = original;
});

describe('preferredLatencyHint', () => {
  it('asks for playback latency on a touch-primary device', () => {
    stubMatchMedia((q) => q.includes('pointer: coarse'));
    expect(preferredLatencyHint()).toBe('playback');
  });

  it('asks for interactive latency on a pointer device', () => {
    stubMatchMedia(() => false);
    expect(preferredLatencyHint()).toBe('interactive');
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
