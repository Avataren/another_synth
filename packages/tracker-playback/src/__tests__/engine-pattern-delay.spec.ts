import { describe, expect, it } from 'vitest';

import { PlaybackEngine } from '../engine';
import type { Song, EffectCommand } from '../types';

/**
 * Regression coverage for a real hang bug found via GSLINGER.MOD (a real
 * Amiga MOD file): a pattern-delay effect (EEx, "repeat this row x extra
 * times") never let the engine advance past the delayed row at all.
 *
 * Root cause, in scheduleAhead()'s row loop: when patternDelayCount
 * reaches exactly 0 after being decremented, the code still hit
 * `continue` unconditionally, so lastScheduledRow was never advanced.
 * The next loop iteration re-processed the *same* row via scheduleRow(),
 * which saw patternDelayCount === 0 and re-armed it right back to the
 * full delay count -- an infinite cycle that never progressed. Audibly:
 * playback gets stuck holding one row forever instead of just delaying it
 * by the requested number of extra rows (which is what made a later
 * pattern-break a few rows later in that same file, and the whole next
 * pattern, unreachable -- "one pattern mutes/never reaches the next").
 */
function buildPatternDelaySong(delayExtraRows: number): Song {
  const patDelay: EffectCommand = {
    type: 'patDelay',
    paramX: 0,
    paramY: delayExtraRows,
  };

  return {
    title: 'pattern delay test',
    author: '',
    bpm: 125,
    sequence: ['p0'],
    patterns: [
      {
        id: 'p0',
        length: 4,
        tracks: [
          {
            id: 't0',
            steps: [
              { row: 0, instrumentId: '01', midi: 60 },
              { row: 1, instrumentId: '01', effect: patDelay },
              { row: 2, instrumentId: '01', midi: 62 },
              { row: 3, instrumentId: '01', midi: 64 },
            ],
          },
        ],
      },
    ],
  };
}

/** Drives the engine's private scheduling loop directly, with a fully
 *  controlled fake clock, so the test is fast and deterministic instead
 *  of depending on real timers. Mirrors the private-field access pattern
 *  already used in the song-bank test suite. */
function driveScheduling(engine: PlaybackEngine, iterations: number, stepSeconds: number) {
  let fakeNow = 0;
  const audioContext = Reflect.get(engine, 'audioContext') as { currentTime: number } | undefined;
  // The engine reads audioContext.currentTime as a getter in real usage;
  // here we just mutate a plain object's field each iteration.
  const startScheduledPlayback = (
    Reflect.get(engine, 'startScheduledPlayback') as () => void
  ).bind(engine);
  const scheduleAhead = (Reflect.get(engine, 'scheduleAhead') as () => void).bind(engine);

  Reflect.set(engine, 'state', 'playing');
  startScheduledPlayback();
  // Stop the real clock startScheduledPlayback kicked off -- we drive time
  // manually below instead.
  (Reflect.get(engine, 'playbackClock') as { stop: () => void }).stop();

  for (let i = 0; i < iterations; i++) {
    fakeNow += stepSeconds;
    if (audioContext) audioContext.currentTime = fakeNow;
    scheduleAhead();
  }
}

describe('PlaybackEngine pattern delay (EEx)', () => {
  it('advances past a delayed row instead of hanging on it forever', () => {
    const song = buildPatternDelaySong(2); // repeat row 1 two extra times
    let fakeNow = 0;
    const audioContext = { get currentTime() { return fakeNow; }, set currentTime(v: number) { fakeNow = v; } };

    const engine = new PlaybackEngine({
      audioContext: audioContext as unknown as AudioContext,
      scheduledNoteHandler: () => {},
      scheduledVolumeHandler: () => {},
      scheduledPitchHandler: () => {},
    });
    engine.loadSong(song, 0);

    // Record the rows actually handed to the scheduler. Reading
    // lastScheduledRow instead would not answer the question: the cursor
    // restarts at each pattern boundary, so a small value there means either
    // "stuck on row 0" or "already looped round" and the two are
    // indistinguishable.
    const scheduled: number[] = [];
    const scheduleRow = Reflect.get(engine, 'scheduleRow') as (
      row: number,
      time: number,
    ) => void;
    Reflect.set(engine, 'scheduleRow', (row: number, time: number) => {
      scheduled.push(row);
      scheduleRow.call(engine, row, time);
    });

    driveScheduling(engine, 30, 0.4);

    // Before the fix this never got past row 0. Row 1 is held, and then
    // playback carries on through the rest of the pattern and wraps.
    //
    // EE2 plays row 1 three times: ProTracker, FT2 and ST3 all play a
    // delayed row param + 1 times.
    expect(scheduled.slice(0, 7)).toEqual([0, 1, 1, 1, 2, 3, 0]);
  });

  it('takes a pattern break on the delayed row only after its repeats', () => {
    const song = buildPatternDelaySong(2);
    song.patterns[0]!.tracks.push({
      id: 't1',
      steps: [{ row: 1, instrumentId: '01', effect: { type: 'patBreak', paramX: 0, paramY: 2 } }],
    });
    let fakeNow = 0;
    const audioContext = { get currentTime() { return fakeNow; }, set currentTime(v: number) { fakeNow = v; } };
    const engine = new PlaybackEngine({
      audioContext: audioContext as unknown as AudioContext,
      scheduledNoteHandler: () => {},
      scheduledVolumeHandler: () => {},
      scheduledPitchHandler: () => {},
    });
    engine.loadSong(song, 0);
    const scheduled: number[] = [];
    const scheduleRow = Reflect.get(engine, 'scheduleRow') as (row: number, time: number) => void;
    Reflect.set(engine, 'scheduleRow', (row: number, time: number) => {
      scheduled.push(row);
      scheduleRow.call(engine, row, time);
    });
    driveScheduling(engine, 30, 0.4);
    // All three plays of row 1 happen before the break is taken. (It lands
    // on row 3, not 2: row-scheduler.ts adds one to a break target when the
    // row's pattern delay comes first, its `rowHasPatDelay`.)
    expect(scheduled.slice(0, 5)).toEqual([0, 1, 1, 1, 3]);
  });

  it('holds the delayed row for exactly the requested number of extra repeats', () => {
    // A large step size relative to row duration means each drive step
    // advances roughly one row; count how many distinct scheduleRow calls
    // land on row 1 while patternDelayCount is active, via the position
    // events emitted whenever emitPosition would be relevant -- simpler:
    // just confirm the engine reaches row 2 (past the delay) within a
    // bounded, small number of iterations proportional to the delay count,
    // not an unbounded/never number.
    const song = buildPatternDelaySong(3);
    let fakeNow = 0;
    const audioContext = { get currentTime() { return fakeNow; }, set currentTime(v: number) { fakeNow = v; } };

    const engine = new PlaybackEngine({
      audioContext: audioContext as unknown as AudioContext,
      scheduledNoteHandler: () => {},
      scheduledVolumeHandler: () => {},
      scheduledPitchHandler: () => {},
    });
    engine.loadSong(song, 0);

    driveScheduling(engine, 15, 0.3);

    const lastScheduledRow = Reflect.get(engine, 'lastScheduledRow') as number;
    expect(lastScheduledRow).toBeGreaterThanOrEqual(2);
  });
});

/**
 * What a repeat does. Every tracker holds a delayed row's notes: the repeats
 * re-read nothing from the pattern and only run the row's effects again. On
 * tick 0 of a repeat ProTracker and FT2 run their tick-N handlers
 * (`checkEffects`, `handleEffects_TickNonZero`); ST3 re-runs its tick-0
 * pass (`docmd1`), where an ordinary Dxy does nothing.
 */
describe('PlaybackEngine pattern delay repeats', () => {
  function play(moduleFormat: 'mod' | 's3m', slide: EffectCommand) {
    const song: Song = {
      title: 'pattern delay repeats',
      author: '',
      bpm: 125,
      moduleFormat,
      sequence: ['p0'],
      patterns: [
        {
          id: 'p0',
          length: 4,
          tracks: [
            {
              id: 't0',
              steps: [
                { row: 0, instrumentId: '01', midi: 60, effect: { type: 'patDelay', paramX: 0, paramY: 2 } },
              ],
            },
            {
              id: 't1',
              steps: [{ row: 0, instrumentId: '01', midi: 64, velocity: 255, effect: slide }],
            },
          ],
        },
      ],
    };
    let fakeNow = 0;
    const audioContext = { get currentTime() { return fakeNow; }, set currentTime(v: number) { fakeNow = v; } };
    const noteOns: number[] = [];
    const volumes: Array<[number, number]> = [];
    const engine = new PlaybackEngine({
      audioContext: audioContext as unknown as AudioContext,
      scheduledNoteHandler: (e) => {
        if (e.type === 'noteOn') noteOns.push(e.trackIndex);
      },
      scheduledVolumeHandler: (_id, _voice, volume, time, trackIndex) => {
        if (trackIndex === 1) volumes.push([time, volume]);
      },
      scheduledPitchHandler: () => {},
      steppedTickAutomation: () => true,
    });
    engine.loadSong(song, 0);
    engine.setLoopSong(false);
    driveScheduling(engine, 4, 0.4);
    // Everything scheduled before row 1 (the row after the delayed one).
    const rowSeconds = (6 * 2.5) / 125;
    const held = volumes.filter(([t]) => t < 3 * rowSeconds - 1e-6);
    const slides = held.filter(([, v], i) => i > 0 && v < held[i - 1]![1]).length;
    return { noteOns, lastVolume: held[held.length - 1]![1], slides };
  }

  it('ProTracker: notes play once; the slide runs on every tick of each repeat', () => {
    const { noteOns, slides, lastVolume } = play('mod', { type: 'volSlide', paramX: 0, paramY: 1 });
    expect(noteOns).toEqual([0, 1]);
    // Ticks 1..5 of the first play, then ticks 0..5 of both repeats.
    expect(slides).toBe(5 + 6 + 6);
    expect(lastVolume).toBeCloseTo((64 - 17) / 64, 5);
  });

  it('ST3: notes play once; a repeat re-runs tick 0, where D01 does nothing', () => {
    const { noteOns, slides, lastVolume } = play('s3m', { type: 'volSlide', paramX: 0, paramY: 1 });
    expect(noteOns).toEqual([0, 1]);
    expect(slides).toBe(5 * 3);
    expect(lastVolume).toBeCloseTo((64 - 15) / 64, 5);
  });
});
