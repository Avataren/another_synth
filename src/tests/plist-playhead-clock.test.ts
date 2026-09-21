// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ahxSamplesPerTick,
  ahxTickMs,
  createPListPlayheadClock,
  playheadLatencyMs,
  playheadTiming,
  type PListClockReport,
  type PListPlayheadClock,
} from 'src/audio/tracker/plist-playhead-clock';

/**
 * T3: the playhead clock, pure, with the time handed in. The sequences are
 * hand-derived from the engine's traces in `rust-wasm/tests/ahx_live.rs`
 * (B1): a note-on's first tick runs row 0, and with PList speed S row r runs
 * on tick 1 + r*S; a Jump reports the row that ran, not its target; a
 * retrigger stamps the new instrument; the end of the release reports none.
 *
 * Timeline used throughout: the note-on tick is at t = 0, tick k (1-based) is
 * at (k - 1) * tickMs, and the main thread handles the report HOP_MS later.
 */
const HOP_MS = 3;
const SR = 48000;
const FRAME_MS = 50 / 3; // a 60 Hz display

const rep = (instrument: number, row: number): PListClockReport => ({ instrument, row });
const NONE = rep(0, -1);

type Timed = ReadonlyArray<readonly [tick: number, report: PListClockReport]>;

/**
 * Plays a timeline: each report is handled at its tick's time plus the hop, each poll happens at its
 * time, in time order (the clock never reads the past, so a test cannot push everything first).
 * Returns what each poll gave, `undefined` for nothing due.
 */
function run(
  clock: PListPlayheadClock,
  tickMs: number,
  reports: Timed,
  pollTimes: readonly number[],
): Array<PListClockReport | undefined> {
  const pushes = reports.map(([tick, report]) => ({ at: (tick - 1) * tickMs + HOP_MS, report }));
  const out: Array<PListClockReport | undefined> = [];
  let next = 0;
  for (const t of pollTimes) {
    while (next < pushes.length && pushes[next]!.at <= t) {
      clock.push(pushes[next]!.report, pushes[next]!.at);
      next += 1;
    }
    out.push(clock.poll(t));
  }
  return out;
}

/** The frame times of a 60 Hz display: 16.7, 33.3, 50 ... */
const frames = (count: number): number[] => Array.from({ length: count }, (_, j) => (j + 1) * FRAME_MS);

describe('the engine tick cadence', () => {
  it('samples per tick is the engine’s integer division: 50 Hz, divided by the speed multiplier', () => {
    expect(ahxSamplesPerTick(48000, 1)).toBe(960);
    expect(ahxSamplesPerTick(48000, 2)).toBe(480);
    expect(ahxSamplesPerTick(48000, 3)).toBe(320);
    expect(ahxSamplesPerTick(48000, 4)).toBe(240);
    // 44.1 kHz does not divide: 882 / 4 = 220.5 -> 220, as u32 arithmetic does.
    expect(ahxSamplesPerTick(44100, 1)).toBe(882);
    expect(ahxSamplesPerTick(44100, 3)).toBe(294);
    expect(ahxSamplesPerTick(44100, 4)).toBe(220);
  });

  it('a tick lasts 20, 10, 6.67 and 5 ms at multipliers 1..4 (48 kHz)', () => {
    expect(ahxTickMs(SR, 1)).toBeCloseTo(20, 9);
    expect(ahxTickMs(SR, 2)).toBeCloseTo(10, 9);
    expect(ahxTickMs(SR, 3)).toBeCloseTo(20 / 3, 9);
    expect(ahxTickMs(SR, 4)).toBeCloseTo(5, 9);
  });

  it('a multiplier that is not 1..4 reads as the nearest sane one', () => {
    expect(ahxSamplesPerTick(SR, 0)).toBe(960);
    expect(ahxSamplesPerTick(SR, Number.NaN)).toBe(960);
  });

  it('timing bundles the tick, the render quantum and the clamped latency', () => {
    const t = playheadTiming(SR, 3, 500);
    expect(t.tickMs).toBeCloseTo(20 / 3, 9);
    expect(t.quantumMs).toBeCloseTo(128 / 48, 9);
    expect(t.latencyMs).toBe(200);
    expect(playheadTiming(SR, 1, -5).latencyMs).toBe(0);
  });
});

describe('the audio latency', () => {
  it('is baseLatency + outputLatency, in milliseconds', () => {
    expect(playheadLatencyMs(0.01, 0.03)).toBeCloseTo(40, 9);
  });

  it('a property the browser does not report is 0 (Firefox may give neither)', () => {
    expect(playheadLatencyMs(undefined, undefined)).toBe(0);
    expect(playheadLatencyMs(undefined, 0.02)).toBeCloseTo(20, 9);
    expect(playheadLatencyMs(0.01, undefined)).toBeCloseTo(10, 9);
    expect(playheadLatencyMs(Number.NaN, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('is clamped to 0..200 ms: a context that says more is not to be believed', () => {
    expect(playheadLatencyMs(0.5, 0.5)).toBe(200);
    expect(playheadLatencyMs(-1, 0)).toBe(0);
  });
});

describe('the clock: when a reported row may be shown', () => {
  const clockAt = (multiplier: number, latencyMs: number) =>
    createPListPlayheadClock(playheadTiming(SR, multiplier, latencyMs));

  it('holds a report back by the latency, then gives it', () => {
    const clock = clockAt(1, 40);
    clock.push(rep(3, 0), 100);
    expect(clock.poll(139.9)).toBeUndefined();
    expect(clock.poll(140)).toEqual(rep(3, 0));
    expect(clock.poll(200)).toBeUndefined();
    expect(clock.pending).toBe(0);
  });

  it('with no latency reported (0) a row is shown as soon as it is handled', () => {
    const clock = clockAt(1, 0);
    clock.push(rep(3, 0), 100);
    expect(clock.poll(100)).toEqual(rep(3, 0));
  });

  it('PList speed 1 at multiplier 1: a row a tick (20 ms), every row is shown, in order (rows 0..4, ticks 1..5)', () => {
    // Reports at 3, 23, 43, 63, 83; latency 40 makes them due at 43, 63, 83, 103, 123.
    // Frames at 16.7 * j: the first frame at or after each due time is 50, 66.7, 83.3, 116.7, 133.3.
    const clock = clockAt(1, 40);
    const reports: Timed = [[1, rep(2, 0)], [2, rep(2, 1)], [3, rep(2, 2)], [4, rep(2, 3)], [5, rep(2, 4)]];
    // The frames: 16.7 (none due), 33.3 (none), 50 -> row 0, 66.7 -> row 1, 83.3 -> row 2,
    // 100 (row 3 is due at 103, none), 116.7 -> row 3, 133.3 -> row 4.
    expect(run(clock, 20, reports, frames(8))).toEqual([
      undefined, undefined, rep(2, 0), rep(2, 1), rep(2, 2), undefined, rep(2, 3), rep(2, 4),
    ]);
  });

  it('PList speed 1 at multiplier 3: a row every 6.67 ms is faster than a frame, so the latest is shown and the rest skipped', () => {
    // Reports at 3 + 6.667 k for row k. Latency 0. Frames at 16.7, 33.3, 50, 66.7, 83.3:
    // newest k with 3 + 6.667 k <= frame is 2, 4, 7, 9, 12.
    const clock = clockAt(3, 0);
    const reports: Timed = Array.from({ length: 14 }, (_, k) => [k + 1, rep(1, k)] as const);
    const shown = run(clock, 20 / 3, reports, frames(5)).map((r) => r?.row);
    expect(shown).toEqual([2, 4, 7, 9, 12]);
  });

  it('PList speed 3 at multiplier 3: a row every three ticks (20 ms), like speed 1 at multiplier 1', () => {
    // Row r runs on tick 1 + 3r: reports at 3 + 20 r.
    const clock = clockAt(3, 0);
    const reports: Timed = [[1, rep(1, 0)], [4, rep(1, 1)], [7, rep(1, 2)], [10, rep(1, 3)]];
    // Reports at 3, 23, 43, 63; frames 16.7 -> 0, 33.3 -> 1, 50 -> 2, 66.7 -> 3.
    expect(run(clock, 20 / 3, reports, frames(4)).map((r) => r?.row)).toEqual([0, 1, 2, 3]);
  });

  it('a Jump goes back: the row that ran, then the row it jumped to, and the pill follows the engine ([step, Jump 0]: 0, 1, 0, 1)', () => {
    const clock = clockAt(1, 0);
    const reports: Timed = [[1, rep(1, 0)], [2, rep(1, 1)], [3, rep(1, 0)], [4, rep(1, 1)]];
    // Poll just after each report is handled: 3, 23, 43, 63 (+ 0.5).
    const seen = run(clock, 20, reports, [3.5, 23.5, 43.5, 63.5]).map((r) => r?.row);
    expect(seen).toEqual([0, 1, 0, 1]);
  });

  it('a retrigger stamps the other instrument with its row 0, and the old note’s row is not shown after it', () => {
    const clock = clockAt(1, 0);
    // Instrument 3 runs rows 0, 1; a note of instrument 2 is struck on tick 3 and its first tick runs its row 0.
    const reports: Timed = [[1, rep(3, 0)], [2, rep(3, 1)], [3, rep(2, 0)]];
    expect(run(clock, 20, reports, [3.5, 23.5, 43.5])).toEqual([rep(3, 0), rep(3, 1), rep(2, 0)]);
  });

  it('the release ending reports none, after the same latency as the rows before it (the bar lingers as long as the sound)', () => {
    const clock = clockAt(1, 40);
    // Reports at 3 and 23 are due at 43 and 63; the release ends and the worklet reports none at 100, due at 140.
    const reports: Timed = [[1, rep(2, 0)], [2, rep(2, 1)]];
    expect(run(clock, 20, reports, [60, 70])).toEqual([rep(2, 0), rep(2, 1)]);
    clock.push(NONE, 100);
    expect(clock.poll(139)).toBeUndefined();
    expect(clock.poll(140)).toEqual(NONE);
  });

  it('a note-off is not none: the rows keep coming through the release and only its end clears', () => {
    const clock = clockAt(1, 0);
    // A note-off at tick 5: rows 4 and 5 still run (ticks 5 and 6) while the release sounds.
    const reports: Timed = [[5, rep(2, 4)], [6, rep(2, 5)]];
    expect(run(clock, 20, reports, [83.5, 103.5])).toEqual([rep(2, 4), rep(2, 5)]);
    clock.push(NONE, 300);
    expect(clock.poll(300)).toEqual(NONE);
  });

  it('two identical reports in a row are one', () => {
    const clock = clockAt(1, 40);
    clock.push(rep(1, 2), 0);
    clock.push(rep(1, 2), 5);
    expect(clock.pending).toBe(1);
  });

  it('coalesces to the newest due report: older ones that are due too are never shown', () => {
    const clock = clockAt(1, 10);
    clock.push(rep(1, 0), 0);
    clock.push(rep(1, 1), 20);
    clock.push(rep(1, 2), 40);
    // At 55 the reports at 0, 20 and 40 are due at 10, 30, 50: only row 2 is shown.
    expect(clock.poll(55)).toEqual(rep(1, 2));
    expect(clock.pending).toBe(0);
  });
});

describe('a stalled main thread (the tick cadence dates a burst back)', () => {
  it('a burst handled together is replayed at the engine’s pace, not shown as one late jump', () => {
    // Five rows one tick apart (x1) all handled at ~1000; the audio latency is 40.
    // Rendered no closer than a tick less a quantum apart (17.33 ms), the newest at 1000.4:
    // rows 4, 3, 2 at 1000.4, 983.07, 965.73, so due at 1040.4, 1023.07, 1005.73.
    // Rows 1 and 0 are overdue at 988.4 and 971.07: only the newest overdue (row 1) is kept.
    const clock = createPListPlayheadClock(playheadTiming(SR, 1, 40));
    for (let row = 0; row < 5; row += 1) clock.push(rep(1, row), 1000 + row * 0.1);
    expect(clock.pending).toBe(4);
    expect(clock.poll(1000.5)).toEqual(rep(1, 1));
    expect(clock.poll(1005.7)).toBeUndefined();
    expect(clock.poll(1005.8)).toEqual(rep(1, 2));
    expect(clock.poll(1023.0)).toBeUndefined();
    expect(clock.poll(1023.1)).toEqual(rep(1, 3));
    expect(clock.poll(1040.5)).toEqual(rep(1, 4));
  });

  it('reports far enough apart are not dated back', () => {
    const clock = createPListPlayheadClock(playheadTiming(SR, 1, 40));
    clock.push(rep(1, 0), 100);
    clock.push(rep(1, 1), 120);
    expect(clock.poll(139.9)).toBeUndefined();
    expect(clock.poll(140)).toEqual(rep(1, 0));
    expect(clock.poll(160)).toEqual(rep(1, 1));
  });

  it('at multiplier 3 the spacing is 6.67 - 2.67 = 4 ms: reports 5 ms apart stay, 2 ms apart are dated back to 4', () => {
    const clock = createPListPlayheadClock(playheadTiming(SR, 3, 20));
    clock.push(rep(1, 0), 100);
    clock.push(rep(1, 1), 105);
    // Row 0 keeps its stamp: due at 120.
    expect(clock.poll(119.9)).toBeUndefined();
    expect(clock.poll(120)).toEqual(rep(1, 0));
    const tight = createPListPlayheadClock(playheadTiming(SR, 3, 20));
    tight.push(rep(1, 0), 100);
    tight.push(rep(1, 1), 102);
    // Row 0 is dated to 98 (4 ms before row 1): due at 118, before its stamp said 120.
    expect(tight.poll(117.9)).toBeUndefined();
    expect(tight.poll(118)).toEqual(rep(1, 0));
  });
});

describe('a hidden tab (frames paused, nobody polls)', () => {
  it('the queue stays inside the latency window however long it runs', () => {
    // A row every 20 ms for 20 s, latency 40: at most the newest overdue, and the two inside the window.
    const clock = createPListPlayheadClock(playheadTiming(SR, 1, 40));
    let most = 0;
    for (let k = 0; k < 1000; k += 1) {
      clock.push(rep(1, k % 96), k * 20);
      most = Math.max(most, clock.pending);
    }
    expect(most).toBeLessThanOrEqual(3);
    // Back on screen: the newest due row is shown, once.
    expect(clock.poll(1000 * 20 + 40)).toEqual(rep(1, 999 % 96));
    expect(clock.pending).toBe(0);
  });

  it('bounded at multiplier 3 too, where a tick is 6.67 ms and the window holds more', () => {
    const clock = createPListPlayheadClock(playheadTiming(SR, 3, 40));
    let most = 0;
    for (let k = 0; k < 3000; k += 1) {
      clock.push(rep(1, k % 96), (k * 20) / 3);
      most = Math.max(most, clock.pending);
    }
    // 40 ms window / 6.67 ms = 6 inside, and the newest overdue one.
    expect(most).toBeLessThanOrEqual(8);
  });
});

describe('the clock’s own rules', () => {
  it('time does not run backwards: an earlier `now` is read as the latest one seen', () => {
    const clock = createPListPlayheadClock(playheadTiming(SR, 1, 0));
    clock.push(rep(1, 0), 100);
    expect(clock.poll(50)).toEqual(rep(1, 0));
  });

  it('a timing change applies to what is queued', () => {
    const clock = createPListPlayheadClock(playheadTiming(SR, 1, 40));
    clock.push(rep(1, 0), 100);
    expect(clock.poll(110)).toBeUndefined();
    clock.configure(playheadTiming(SR, 1, 0));
    expect(clock.poll(110)).toEqual(rep(1, 0));
  });

  it('clear drops everything waiting', () => {
    const clock = createPListPlayheadClock(playheadTiming(SR, 1, 40));
    clock.push(rep(1, 0), 0);
    clock.push(rep(1, 1), 20);
    clock.clear();
    expect(clock.pending).toBe(0);
    expect(clock.poll(1000)).toBeUndefined();
  });

  it('does not keep the caller’s report object', () => {
    const clock = createPListPlayheadClock(playheadTiming(SR, 1, 0));
    const r = rep(1, 3);
    clock.push(r, 0);
    r.row = 99;
    expect(clock.poll(0)).toEqual(rep(1, 3));
  });
});
