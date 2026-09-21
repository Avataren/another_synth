/**
 * The PList playhead's clock: when a row the worklet reported may be shown.
 *
 * Pure (no DOM, no store, no timers): every method is given the time. The
 * driver in `ahx-plist-playhead.ts` gives it `performance.now()` and calls
 * `poll` from a `requestAnimationFrame`.
 *
 * A report says a row was *rendered*. Two things separate that from what a
 * person sees:
 *
 *  1. The audio is heard `latencyMs` after it is rendered (the context's
 *     `baseLatency + outputLatency`), so a report is held back by that much.
 *  2. The message is stamped when the main thread *handles* it. The main thread
 *     can be busy for a while (an edit commit, a repaint, a hidden tab), and
 *     then a run of reports is handled back to back and all carry nearly the
 *     same stamp. The engine steps at most once per tick (`tickMs`, from the
 *     song's `speedMultiplier`), so a run of `k` reports was rendered at least
 *     one tick apart each, ending at the newest one's stamp: the earlier ones are
 *     dated back accordingly. Without that, a stall would replay the steps it
 *     swallowed all at once, or show a burst as one late jump.
 *
 * `poll` returns the newest report that is due and drops the older ones (the
 * canvas paints the latest row per frame; a step shorter than a frame is
 * skipped by design). `push` drops overdue reports too, so a tab whose
 * `requestAnimationFrame` is paused cannot grow the queue: it never holds
 * more than the reports inside the latency window plus one.
 */

/** What the worklet reports: the instrument (1-based) and the row; `0, -1` is "nothing sounds". */
export interface PListClockReport {
  instrument: number;
  row: number;
}

export interface PListClockTiming {
  /** How long after rendering a report is heard; 0 shows it as soon as it is handled. */
  latencyMs: number;
  /** One engine tick, `ahxTickMs(sampleRate, speedMultiplier)`. */
  tickMs: number;
  /** One render quantum. A change is reported at the end of the quantum its tick began in, so two reports can be this much closer than a tick. */
  quantumMs: number;
}

/** The worklet renders in quanta of this many frames. */
export const PLIST_RENDER_QUANTUM_FRAMES = 128;
/** Engine ticks a second before the song's `speedMultiplier` (`engine.rs`: `freq / 50 / speed_multiplier`). */
export const AHX_BASE_TICK_HZ = 50;
/** The longest delay the clock will apply: a context that reports more is not to be believed. */
export const PLIST_MAX_LATENCY_MS = 200;

/** A context that does not say its rate (or says nonsense) is read as this. */
const FALLBACK_SAMPLE_RATE = 48000;

const usableRate = (sampleRate: number): number =>
  Number.isFinite(sampleRate) && sampleRate >= AHX_BASE_TICK_HZ ? sampleRate : FALLBACK_SAMPLE_RATE;

/** Frames per engine tick, exactly as the engine computes it (`engine.rs` `tick_samples`). */
export function ahxSamplesPerTick(sampleRate: number, speedMultiplier: number): number {
  return Math.floor(usableRate(sampleRate) / AHX_BASE_TICK_HZ / Math.max(1, Math.floor(speedMultiplier) || 1));
}

/** One engine tick in milliseconds: 20 at speed multiplier 1, 10 at 2, 6.66 at 3. */
export function ahxTickMs(sampleRate: number, speedMultiplier: number): number {
  return (ahxSamplesPerTick(sampleRate, speedMultiplier) / usableRate(sampleRate)) * 1000;
}

/**
 * The delay between a row being rendered and being heard, from the context's
 * `baseLatency` and `outputLatency` (seconds; either may be missing, or 0 where
 * the browser does not report it), in milliseconds, clamped to 0..200.
 */
export function playheadLatencyMs(baseLatency: number | undefined, outputLatency: number | undefined): number {
  const seconds = (Number.isFinite(baseLatency) ? baseLatency! : 0) + (Number.isFinite(outputLatency) ? outputLatency! : 0);
  return Math.min(PLIST_MAX_LATENCY_MS, Math.max(0, seconds * 1000));
}

/** The timing for a context at `sampleRate` playing a song with `speedMultiplier`. */
export function playheadTiming(
  sampleRate: number,
  speedMultiplier: number,
  latencyMs: number,
): PListClockTiming {
  return {
    latencyMs: Number.isFinite(latencyMs) ? Math.min(PLIST_MAX_LATENCY_MS, Math.max(0, latencyMs)) : 0,
    tickMs: ahxTickMs(sampleRate, speedMultiplier),
    quantumMs: (PLIST_RENDER_QUANTUM_FRAMES / usableRate(sampleRate)) * 1000,
  };
}

interface Queued {
  report: PListClockReport;
  /** When it was rendered, as far as it can be told: its stamp, dated back for a burst. */
  at: number;
}

export interface PListPlayheadClock {
  /** Takes a report handled at `nowMs`. Consecutive identical reports are one. */
  push(report: PListClockReport, nowMs: number): void;
  /**
   * The newest report that is due at `nowMs`, or `undefined` when none is. The
   * report and every older one leave the queue.
   */
  poll(nowMs: number): PListClockReport | undefined;
  /** Timing may change (a new song, a context's latency settling); it applies to what is queued. */
  configure(timing: PListClockTiming): void;
  /** Drops everything queued (a new song makes any old row a lie). */
  clear(): void;
  /** Reports waiting. */
  readonly pending: number;
}

export function createPListPlayheadClock(initial: PListClockTiming): PListPlayheadClock {
  let timing = initial;
  let queue: Queued[] = [];
  let lastNow = -Infinity;

  const spacingMs = (): number => Math.max(0, timing.tickMs - timing.quantumMs);

  /** Drops every queued report that is due and not the newest due one. */
  const dropOverdue = (nowMs: number): void => {
    let newestDue = -1;
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i]!.at + timing.latencyMs <= nowMs) {
        newestDue = i;
        break;
      }
    }
    if (newestDue > 0) queue = queue.slice(newestDue);
  };

  return {
    push(report, nowMs) {
      // Time does not run backwards for the clock, whatever a caller passes.
      const now = Math.max(nowMs, lastNow);
      lastNow = now;
      const newest = queue[queue.length - 1];
      if (newest && newest.report.instrument === report.instrument && newest.report.row === report.row) return;
      queue.push({ report: { instrument: report.instrument, row: report.row }, at: now });
      // A report cannot have been rendered less than a tick after the one before it: date the earlier ones back.
      const spacing = spacingMs();
      for (let i = queue.length - 2; i >= 0; i -= 1) {
        const limit = queue[i + 1]!.at - spacing;
        if (queue[i]!.at <= limit) break;
        queue[i]!.at = limit;
      }
      dropOverdue(now);
    },
    poll(nowMs) {
      const now = Math.max(nowMs, lastNow);
      lastNow = now;
      let due = -1;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]!.at + timing.latencyMs <= now) {
          due = i;
          break;
        }
      }
      if (due < 0) return undefined;
      const { report } = queue[due]!;
      queue = queue.slice(due + 1);
      return report;
    },
    configure(next) {
      timing = next;
    },
    clear() {
      queue = [];
      lastNow = -Infinity;
    },
    get pending() {
      return queue.length;
    },
  };
}
