import { shallowRef, type ShallowRef } from 'vue';
import type { AhxPListRow } from 'src/audio/tracker/ahx-player';
import {
  createPListPlayheadClock,
  playheadTiming,
  type PListClockTiming,
} from 'src/audio/tracker/plist-playhead-clock';

/** The PList row the sounding preview note is on, and the instrument (1-based) it belongs to. */
export interface AhxPListPlayhead {
  instrument: number;
  row: number;
}

/**
 * Where the engine's preview note is in its instrument's PList, or `null` when
 * nothing sounds. Reactive for the instrument page's canvas; written only by
 * the playback store, from the preview's `onPListRow`.
 *
 * A `shallowRef`, not a `ref`: it is replaced on every report and never
 * mutated, so no Proxy ever wraps the value (the same choice as
 * `ahxSourceInfo`).
 */
export const ahxPListPlayhead: ShallowRef<AhxPListPlayhead | null> = shallowRef(null);

/** Takes a report the clock says is due: a row sets the playhead, `row < 0` (nothing sounds) clears it. */
export function setAhxPListPlayhead(report: AhxPListRow): void {
  if (report.row < 0 || report.instrument <= 0) {
    clearAhxPListPlayhead();
    return;
  }
  const now = ahxPListPlayhead.value;
  if (now?.instrument === report.instrument && now.row === report.row) return;
  ahxPListPlayhead.value = { instrument: report.instrument, row: report.row };
}

/** What the driver needs from the page it runs in; the default is the browser's. Tests hand in their own. */
export interface AhxPListPlayheadEnv {
  now(): number;
  /** `undefined` where there is no frame callback: the driver then shows a due report at once. */
  requestFrame?: ((callback: () => void) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
  hidden(): boolean;
  /** Called when the tab becomes visible again. Returns what stops listening. */
  onVisible(callback: () => void): () => void;
}

const browserEnv: AhxPListPlayheadEnv = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  // A page has requestAnimationFrame; a run without one (a test) gets a 60 Hz timer in its place.
  requestFrame: (callback) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(callback)
      : (setTimeout(callback, 1000 / 60) as unknown as number),
  cancelFrame: (handle) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    else clearTimeout(handle);
  },
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onVisible(callback) {
    if (typeof document === 'undefined') return () => undefined;
    const listener = (): void => {
      if (document.visibilityState !== 'hidden') callback();
    };
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

export interface AhxPListPlayheadDriver {
  /** A report from the preview's worklet: held for the audio's latency, then shown from a frame. */
  push(report: AhxPListRow): void;
  /** Where the timing comes from (read at each report); `null` means no audio latency and the 50 Hz base tick. */
  setTimingSource(source: (() => PListClockTiming) | null): void;
  /** Drops everything waiting and stops the frame loop. */
  clear(): void;
  dispose(): void;
}

const DEFAULT_TIMING: PListClockTiming = playheadTiming(48000, 1, 0);

/**
 * Feeds the playhead from the preview's reports through the pure clock, from
 * `requestAnimationFrame`, and only while a report is waiting: with nothing
 * queued there is no loop, and in a hidden tab (frames paused) there is none
 * either; the clock's own bound keeps the queue small until the tab is back.
 */
export function createAhxPListPlayheadDriver(
  apply: (report: AhxPListRow) => void,
  env: AhxPListPlayheadEnv = browserEnv,
): AhxPListPlayheadDriver {
  const clock = createPListPlayheadClock(DEFAULT_TIMING);
  let source: (() => PListClockTiming) | null = null;
  let frame: number | null = null;

  const drain = (): void => {
    const due = clock.poll(env.now());
    if (due) apply(due);
  };
  const onFrame = (): void => {
    frame = null;
    drain();
    schedule();
  };
  const schedule = (): void => {
    if (frame !== null || clock.pending === 0) return;
    if (!env.requestFrame) {
      drain();
      return;
    }
    if (env.hidden()) return;
    frame = env.requestFrame(onFrame);
  };
  const stopListening = env.onVisible(() => {
    drain();
    schedule();
  });
  const cancel = (): void => {
    if (frame !== null) env.cancelFrame?.(frame);
    frame = null;
  };

  return {
    push(report) {
      if (source) {
        try {
          clock.configure(source());
        } catch {
          // No context yet: the timing already set stands.
        }
      }
      clock.push(report, env.now());
      schedule();
    },
    setTimingSource(next) {
      source = next;
      clock.configure(next ? safeTiming(next) : DEFAULT_TIMING);
    },
    clear() {
      cancel();
      clock.clear();
    },
    dispose() {
      cancel();
      clock.clear();
      stopListening();
    },
  };
}

function safeTiming(source: () => PListClockTiming): PListClockTiming {
  try {
    return source();
  } catch {
    return DEFAULT_TIMING;
  }
}

const driver = createAhxPListPlayheadDriver(setAhxPListPlayhead);

/** A report from the preview's worklet, on its way to `ahxPListPlayhead` (held for the audio's latency, coalesced to a frame). */
export const pushAhxPListReport = (report: AhxPListRow): void => driver.push(report);

/** Says where the clock's timing comes from: the preview's context and the song's speed multiplier. */
export const setAhxPListTimingSource = (source: (() => PListClockTiming) | null): void =>
  driver.setTimingSource(source);

/** A different song, or no preview worklet any more: whatever row was shown, or is on its way, is a lie. */
export function clearAhxPListPlayhead(): void {
  driver.clear();
  if (ahxPListPlayhead.value !== null) ahxPListPlayhead.value = null;
}
