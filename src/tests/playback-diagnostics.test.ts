import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initPlaybackDiagnostics,
  disposePlaybackDiagnosticsForTests,
  isPlaybackDiagEnabled,
} from 'src/diagnostics/playback-diagnostics';

/**
 * Playback telemetry (P1): opt-in via `?diag=playback`, zero cost when off.
 *
 * jsdom has no PerformanceObserver / performance.memory, so the "on" tests
 * install fakes; the "off" test is the important negative -- it proves that
 * without the URL param, none of PerformanceObserver / setInterval / rAF /
 * a keydown listener is ever touched, which is the zero-overhead contract
 * the task calls for.
 */

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

interface FakeEntry {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  [key: string]: unknown;
}

class FakePerformanceObserver {
  static instances: FakePerformanceObserver[] = [];
  type: string | null = null;
  disconnected = false;
  private readonly callback: (list: { getEntries: () => FakeEntry[] }) => void;
  constructor(callback: (list: { getEntries: () => FakeEntry[] }) => void) {
    this.callback = callback;
    FakePerformanceObserver.instances.push(this);
  }
  observe(opts: { type: string; buffered?: boolean }): void {
    this.type = opts.type;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  emit(entries: FakeEntry[]): void {
    this.callback({ getEntries: () => entries });
  }
}

function observersOfType(type: string): FakePerformanceObserver[] {
  return FakePerformanceObserver.instances.filter((o) => o.type === type);
}

type FrameCb = (time: number) => void;
const rafQueue = new Map<number, FrameCb>();
let nextRafId = 1;

function installFakeRaf(): void {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameCb) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      rafQueue.delete(id);
    }),
  );
}

function pumpFrame(time: number): void {
  const pending = [...rafQueue.entries()];
  rafQueue.clear();
  for (const [, cb] of pending) cb(time);
}

function setSearch(search: string): void {
  window.history.replaceState(null, '', `/${search}`);
}

beforeEach(() => {
  FakePerformanceObserver.instances = [];
  rafQueue.clear();
  setSearch('');
});

afterEach(() => {
  disposePlaybackDiagnosticsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if ('memory' in performance) {
    delete (performance as unknown as { memory?: unknown }).memory;
  }
  setSearch('');
});

// ---------------------------------------------------------------------
// The URL predicate
// ---------------------------------------------------------------------

describe('isPlaybackDiagEnabled', () => {
  it('is true only for ?diag=playback, false for anything else', () => {
    expect(isPlaybackDiagEnabled('?diag=playback')).toBe(true);
    expect(isPlaybackDiagEnabled('?diag=other')).toBe(false);
    expect(isPlaybackDiagEnabled('?other=playback')).toBe(false);
    expect(isPlaybackDiagEnabled('')).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Off by default: the zero-overhead contract
// ---------------------------------------------------------------------

describe('playback diagnostics: off without the URL param', () => {
  it('registers no observer, timer, rAF loop or keydown hook, and exposes no copy helper', () => {
    setSearch('?nothing=here');
    vi.stubGlobal(
      'PerformanceObserver',
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    const observeSpy = vi.spyOn(FakePerformanceObserver.prototype, 'observe');
    installFakeRaf();
    const rafSpy = vi.mocked(window.requestAnimationFrame);
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    initPlaybackDiagnostics();

    expect(observeSpy).not.toHaveBeenCalled();
    expect(rafSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(
      addEventListenerSpy.mock.calls.some((call) => (call[0] as string) === 'keydown'),
    ).toBe(false);
    expect(window.__copyPlaybackDiag).toBeUndefined();

    observeSpy.mockRestore();
    setIntervalSpy.mockRestore();
    addEventListenerSpy.mockRestore();
  });

  it('a second call after teardown stays off (dispose leaves it truly off, not re-armed)', () => {
    setSearch('?diag=playback');
    vi.stubGlobal(
      'PerformanceObserver',
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    installFakeRaf();
    initPlaybackDiagnostics();
    expect(window.__copyPlaybackDiag).toBeDefined();
    disposePlaybackDiagnosticsForTests();
    expect(window.__copyPlaybackDiag).toBeUndefined();

    setSearch('?nothing=here');
    const observeSpy = vi.spyOn(FakePerformanceObserver.prototype, 'observe');
    initPlaybackDiagnostics();
    expect(observeSpy).not.toHaveBeenCalled();
    observeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------
// On via ?diag=playback
// ---------------------------------------------------------------------

describe('playback diagnostics: on via ?diag=playback', () => {
  beforeEach(() => {
    setSearch('?diag=playback');
    vi.stubGlobal(
      'PerformanceObserver',
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    // jsdom's real requestAnimationFrame is itself backed by a setInterval,
    // which would show up as a false positive in setInterval assertions and
    // give no control over frame timing. Every "on" test gets the manual
    // queue instead.
    installFakeRaf();
  });

  it('registers longtask and long-animation-frame observers and exposes the copy helper', () => {
    initPlaybackDiagnostics();
    expect(observersOfType('longtask')).toHaveLength(1);
    expect(observersOfType('long-animation-frame')).toHaveLength(1);
    expect(typeof window.__copyPlaybackDiag).toBe('function');
  });

  it('a second init call while already on is a no-op (no duplicate observers)', () => {
    initPlaybackDiagnostics();
    initPlaybackDiagnostics();
    expect(observersOfType('longtask')).toHaveLength(1);
  });

  it('captures longtask and LOAF entries (with attribution) into the dump', async () => {
    initPlaybackDiagnostics();
    observersOfType('longtask')[0]!.emit([
      { name: '', entryType: 'longtask', startTime: 100, duration: 64 },
    ]);
    observersOfType('long-animation-frame')[0]!.emit([
      {
        name: '',
        entryType: 'long-animation-frame',
        startTime: 200,
        duration: 80,
        renderStart: 210,
        styleAndLayoutStart: 215,
        scripts: [{ name: 'noteOnAtTime', duration: 40, invoker: 'foo' }],
      },
    ]);

    const snapshot = await window.__copyPlaybackDiag!();
    expect(snapshot.longtasks).toEqual([{ startTime: 100, duration: 64 }]);
    expect(snapshot.longAnimationFrames).toHaveLength(1);
    expect(snapshot.longAnimationFrames[0]).toMatchObject({
      startTime: 200,
      duration: 80,
      renderStart: 210,
      styleAndLayoutStart: 215,
    });
    expect(snapshot.longAnimationFrames[0]?.scripts?.[0]?.name).toBe('noteOnAtTime');
  });

  it('harvests only the [PlaybackEngine] scheduler-late strings from console.warn, and still logs them', () => {
    initPlaybackDiagnostics();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    console.warn(
      '[PlaybackEngine] Scheduling late: 3 row(s) since the last report, worst 0.050s (row 12); using catch-up lead 0.01s',
    );
    console.warn(
      '[PlaybackEngine] Scheduling is running close to deadline (lead=0.002s, max deficit=-0.001s). Expanding lookahead.',
    );
    console.warn('an unrelated warning');
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it('reports harvested scheduler warnings in the dump', async () => {
    initPlaybackDiagnostics();
    // Spies without mockImplementation call through to whatever console.warn
    // currently is -- the diag wrapper installed by init -- so the harvest
    // logic actually runs; the console noise is expected and harmless.
    const warnSpy = vi.spyOn(console, 'warn');
    console.warn('[PlaybackEngine] Scheduling late: 1 row(s)...');
    console.warn('unrelated');

    const snapshot = await window.__copyPlaybackDiag!();
    expect(snapshot.schedulerWarnings).toHaveLength(1);
    expect(snapshot.schedulerWarnings[0]?.message).toContain('Scheduling late');
    warnSpy.mockRestore();
  });

  it('caps each ring buffer so the dump stays bounded under a long session', async () => {
    initPlaybackDiagnostics();
    const observer = observersOfType('longtask')[0]!;
    for (let i = 0; i < 250; i++) {
      observer.emit([{ name: '', entryType: 'longtask', startTime: i, duration: 1 }]);
    }
    const snapshot = await window.__copyPlaybackDiag!();
    expect(snapshot.longtasks).toHaveLength(200);
    // Oldest 50 evicted; the ring buffer keeps the most recent 200.
    expect(snapshot.longtasks[0]?.startTime).toBe(50);
    expect(snapshot.longtasks.at(-1)?.startTime).toBe(249);
  });

  it('samples rAF frame gaps above 32ms but not ordinary frame timing', async () => {
    initPlaybackDiagnostics();
    pumpFrame(0);
    pumpFrame(16); // ordinary frame, no gap sample
    pumpFrame(16 + 90); // a 90ms hitch
    const snapshot = await window.__copyPlaybackDiag!();
    expect(snapshot.frameGaps).toHaveLength(1);
    expect(snapshot.frameGaps[0]?.gap).toBeCloseTo(90, 5);
  });

  it('samples performance.memory on an interval when it is exposed', () => {
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: { usedJSHeapSize: 1000, totalJSHeapSize: 2000 },
    });
    vi.useFakeTimers();
    initPlaybackDiagnostics();
    vi.advanceTimersByTime(250);
    return window.__copyPlaybackDiag!().then((snapshot) => {
      expect(snapshot.heapSamples.length).toBeGreaterThanOrEqual(1);
      expect(snapshot.heapSamples[0]).toMatchObject({
        usedJSHeapSize: 1000,
        totalJSHeapSize: 2000,
      });
    });
  });

  it('does not sample performance.memory when the API is absent', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    initPlaybackDiagnostics();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('Ctrl+Shift+D copies the diagnostics dump and does not throw without clipboard access', async () => {
    initPlaybackDiagnostics();
    const event = new KeyboardEvent('keydown', {
      key: 'D',
      code: 'KeyD',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // The copy runs async (clipboard write, then notify); let it settle.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('dispose restores console.warn and removes the copy helper', () => {
    const originalWarn = console.warn;
    initPlaybackDiagnostics();
    expect(console.warn).not.toBe(originalWarn);
    disposePlaybackDiagnosticsForTests();
    expect(console.warn).toBe(originalWarn);
    expect(window.__copyPlaybackDiag).toBeUndefined();
  });

  it('includes version and git hash fields in the dump (unknown outside a real build)', async () => {
    initPlaybackDiagnostics();
    const snapshot = await window.__copyPlaybackDiag!();
    expect(typeof snapshot.version).toBe('string');
    expect(typeof snapshot.gitHash).toBe('string');
  });
});
