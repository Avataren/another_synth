/**
 * Playback telemetry (opt-in, zero cost when off).
 *
 * The microstutter investigation
 * (.tmp/openclaw-spikes/microstutter-investigation/README.md) measured the
 * hitches headless; this gives Morten a one-click capture of the same
 * numbers on the machine where the stutter actually happens.
 *
 * Enabled ONLY by the URL query param `?diag=playback` — no settings UI, no
 * user-facing toggle. `initPlaybackDiagnostics()` checks that param once and,
 * when absent, returns immediately: no PerformanceObserver, no timer, no rAF
 * loop, no console.warn wrapper, no allocation. Every side effect below the
 * early return only happens once a caller has opted in via the URL.
 */

import { Notify } from 'quasar';

declare const __APP_VERSION__: string;
declare const __APP_GIT_HASH__: string;

declare global {
  interface Window {
    __copyPlaybackDiag?: () => Promise<PlaybackDiagSnapshot>;
  }
}

/** The query parameter that turns telemetry on. */
export const PLAYBACK_DIAG_QUERY_KEY = 'diag';
const PLAYBACK_DIAG_QUERY_VALUE = 'playback';

/** Fixed-capacity FIFO: bounds the diagnostics dump regardless of session length. */
class RingBuffer<T> {
  private readonly items: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }
  toArray(): T[] {
    return this.items.slice();
  }
}

const RING_CAPACITY = 200;
/**
 * Frame gaps below this are ordinary frame-to-frame variance; the
 * investigation report's own headline metric is "frame gaps > 32 ms" (one
 * dropped frame at 60 fps and worse), so that is the bar here too — it
 * keeps the ring buffer full of hitches, not 16.7 ms noise.
 */
const FRAME_GAP_THRESHOLD_MS = 32;
/** performance.memory sampling cadence the investigation report used. */
const HEAP_SAMPLE_INTERVAL_MS = 250;

export interface LongTaskSample {
  startTime: number;
  duration: number;
}

export interface LoafScriptAttribution {
  name?: string;
  duration?: number;
  invoker?: string;
  sourceURL?: string;
}

export interface LongAnimationFrameSample extends LongTaskSample {
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: LoafScriptAttribution[];
}

export interface GcMarkSample {
  time: number;
  duration: number;
  name: string;
  entryType: string;
}

export interface HeapSample {
  time: number;
  usedJSHeapSize: number;
  totalJSHeapSize?: number;
}

export interface FrameGapSample {
  time: number;
  gap: number;
}

export interface SchedulerWarningSample {
  time: number;
  message: string;
}

export interface PlaybackDiagSnapshot {
  version: string;
  gitHash: string;
  capturedAt: number;
  enabledAt: number;
  longtasks: LongTaskSample[];
  longAnimationFrames: LongAnimationFrameSample[];
  gcMarks: GcMarkSample[];
  heapSamples: HeapSample[];
  frameGaps: FrameGapSample[];
  schedulerWarnings: SchedulerWarningSample[];
}

/** Shape LOAF entries carry beyond the base PerformanceEntry (not yet in lib.dom.d.ts). */
interface RawLoafEntry {
  startTime: number;
  duration: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: {
    name?: string;
    duration?: number;
    invoker?: string;
    sourceURL?: string;
  }[];
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize?: number;
}

/** The one live instance's teardown, or null while off. Guards re-entrant init. */
let activeDispose: (() => void) | null = null;

/** Pure predicate: does this search string ask for playback diagnostics? */
export function isPlaybackDiagEnabled(search: string): boolean {
  return new URLSearchParams(search).get(PLAYBACK_DIAG_QUERY_KEY) === PLAYBACK_DIAG_QUERY_VALUE;
}

/** Best-effort PerformanceObserver registration: absent API or unsupported entry type both no-op. */
function observeEntryType(
  type: string,
  onEntries: (list: PerformanceObserverEntryList) => void,
): (() => void) | null {
  if (typeof PerformanceObserver === 'undefined') return null;
  try {
    const observer = new PerformanceObserver(onEntries);
    observer.observe({ type, buffered: true });
    return () => observer.disconnect();
  } catch {
    // Entry type unsupported in this browser -- nothing to observe.
    return null;
  }
}

function notify(options: { type: 'positive' | 'negative'; message: string }): void {
  try {
    Notify.create({ ...options, timeout: 2500 });
  } catch {
    // Notify plugin unavailable (e.g. not yet booted) -- the console dump
    // below is still there.
    // eslint-disable-next-line no-console
    console.info(`[playback-diag] ${options.message}`);
  }
}

/**
 * Turn on playback telemetry if (and only if) the current URL asks for it.
 * Idempotent: a second call while already on is a no-op.
 */
export function initPlaybackDiagnostics(): void {
  if (activeDispose) return;
  if (!isPlaybackDiagEnabled(window.location.search)) return;

  const enabledAt = performance.now();
  const longtasks = new RingBuffer<LongTaskSample>(RING_CAPACITY);
  const longAnimationFrames = new RingBuffer<LongAnimationFrameSample>(RING_CAPACITY);
  const gcMarks = new RingBuffer<GcMarkSample>(RING_CAPACITY);
  const heapSamples = new RingBuffer<HeapSample>(RING_CAPACITY);
  const frameGaps = new RingBuffer<FrameGapSample>(RING_CAPACITY);
  const schedulerWarnings = new RingBuffer<SchedulerWarningSample>(RING_CAPACITY);

  const disposers: (() => void)[] = [];

  const longtaskDispose = observeEntryType('longtask', (list) => {
    for (const entry of list.getEntries()) {
      longtasks.push({ startTime: entry.startTime, duration: entry.duration });
    }
  });
  if (longtaskDispose) disposers.push(longtaskDispose);

  const loafDispose = observeEntryType('long-animation-frame', (list) => {
    for (const entry of list.getEntries()) {
      const raw = entry as unknown as RawLoafEntry;
      longAnimationFrames.push({
        startTime: raw.startTime,
        duration: raw.duration,
        ...(raw.renderStart !== undefined ? { renderStart: raw.renderStart } : {}),
        ...(raw.styleAndLayoutStart !== undefined
          ? { styleAndLayoutStart: raw.styleAndLayoutStart }
          : {}),
        // Cap attribution per frame too: a pathological LOAF could carry
        // dozens of script entries.
        ...(raw.scripts
          ? {
              scripts: raw.scripts.slice(0, 5).map((s) => ({
                ...(s.name !== undefined ? { name: s.name } : {}),
                ...(s.duration !== undefined ? { duration: s.duration } : {}),
                ...(s.invoker !== undefined ? { invoker: s.invoker } : {}),
                ...(s.sourceURL !== undefined ? { sourceURL: s.sourceURL } : {}),
              })),
            }
          : {}),
      });
    }
  });
  if (loafDispose) disposers.push(loafDispose);

  // Chrome does not expose GC pauses to in-page PerformanceObservers; these
  // two are a best-effort catch for the entry types the spec calls out
  // ('measure' / 'event') in case a future browser (or an instrumented
  // build) marks them, filtered to names that look GC-related so an
  // unrelated app measure/event doesn't fill the ring buffer.
  const gcNamePattern = /\bgc\b|garbage.?collect/i;
  const onPossibleGcEntries = (list: PerformanceObserverEntryList) => {
    for (const entry of list.getEntries()) {
      if (!gcNamePattern.test(entry.name)) continue;
      gcMarks.push({
        time: entry.startTime,
        duration: entry.duration,
        name: entry.name,
        entryType: entry.entryType,
      });
    }
  };
  const measureDispose = observeEntryType('measure', onPossibleGcEntries);
  if (measureDispose) disposers.push(measureDispose);
  const eventDispose = observeEntryType('event', onPossibleGcEntries);
  if (eventDispose) disposers.push(eventDispose);

  // performance.memory (Chrome-only, non-standard) is the fallback GC signal:
  // a live heap sawtooth is the in-page evidence of major-GC compaction.
  const perfWithMemory = performance as Performance & { memory?: PerformanceMemory };
  if (perfWithMemory.memory) {
    const intervalId = window.setInterval(() => {
      const memory = perfWithMemory.memory;
      if (!memory) return;
      heapSamples.push({
        time: performance.now(),
        usedJSHeapSize: memory.usedJSHeapSize,
        ...(memory.totalJSHeapSize !== undefined
          ? { totalJSHeapSize: memory.totalJSHeapSize }
          : {}),
      });
    }, HEAP_SAMPLE_INTERVAL_MS);
    disposers.push(() => window.clearInterval(intervalId));
  }

  // rAF frame-gap sampler: only hitches above the threshold are recorded, so
  // steady 60fps playback never touches the ring buffer.
  let lastFrameTime: number | null = null;
  let rafId: number | null = null;
  const frameTick = (now: number): void => {
    if (lastFrameTime !== null) {
      const gap = now - lastFrameTime;
      if (gap > FRAME_GAP_THRESHOLD_MS) frameGaps.push({ time: now, gap });
    }
    lastFrameTime = now;
    rafId = window.requestAnimationFrame(frameTick);
  };
  rafId = window.requestAnimationFrame(frameTick);
  disposers.push(() => {
    if (rafId !== null) window.cancelAnimationFrame(rafId);
  });

  // Audio scheduler-late warnings: harvested from the existing
  // [PlaybackEngine] console.warn strings rather than a new engine hook, so
  // the tracker-playback package stays untouched by app telemetry.
  // Not bound: keeping the bare reference means dispose() restores
  // console.warn to the exact function it was before, not a wrapper around it.
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    originalWarn.apply(console, args);
    const first = args[0];
    if (
      typeof first === 'string' &&
      (first.startsWith('[PlaybackEngine] Scheduling late') ||
        first.startsWith('[PlaybackEngine] Scheduling is running close to deadline'))
    ) {
      schedulerWarnings.push({ time: performance.now(), message: first });
    }
  };
  disposers.push(() => {
    console.warn = originalWarn;
  });

  function buildSnapshot(): PlaybackDiagSnapshot {
    return {
      // typeof-guarded: the build defines these two as literal constants
      // (esbuild `define`), but nothing substitutes them outside a real
      // build (e.g. under vitest), where a bare reference would throw.
      version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown',
      gitHash: typeof __APP_GIT_HASH__ !== 'undefined' ? __APP_GIT_HASH__ : 'unknown',
      capturedAt: Date.now(),
      enabledAt,
      longtasks: longtasks.toArray(),
      longAnimationFrames: longAnimationFrames.toArray(),
      gcMarks: gcMarks.toArray(),
      heapSamples: heapSamples.toArray(),
      frameGaps: frameGaps.toArray(),
      schedulerWarnings: schedulerWarnings.toArray(),
    };
  }

  async function copyToClipboard(): Promise<PlaybackDiagSnapshot> {
    const snapshot = buildSnapshot();
    const json = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      // Clipboard permission denied or unavailable (e.g. headless, focus
      // lost): the JSON is still in the console for manual copy.
      // eslint-disable-next-line no-console
      console.info('[playback-diag] clipboard write failed; dump below', json);
    }
    return snapshot;
  }

  window.__copyPlaybackDiag = copyToClipboard;

  const onKeydown = (event: KeyboardEvent): void => {
    if (!event.ctrlKey || !event.shiftKey || event.code !== 'KeyD') return;
    event.preventDefault();
    copyToClipboard()
      .then(() => notify({ type: 'positive', message: 'Playback diagnostics copied to clipboard' }))
      .catch(() => notify({ type: 'negative', message: 'Playback diagnostics copy failed' }));
  };
  window.addEventListener('keydown', onKeydown);
  disposers.push(() => window.removeEventListener('keydown', onKeydown));

  activeDispose = () => {
    for (const dispose of disposers) dispose();
    delete window.__copyPlaybackDiag;
    activeDispose = null;
  };
}

/** Test-only teardown: real usage never turns telemetry back off mid-session. */
export function disposePlaybackDiagnosticsForTests(): void {
  activeDispose?.();
}
