import { describe, expect, it } from 'vitest';

import { PlaybackEngine } from '../engine';
import type { Song } from '../types';

/**
 * Regression coverage for the loop-wrap revert (2026-09-05 Group C ticket):
 *
 * setPatternLength replaced the pattern object on song.patterns but never
 * updated the engine's patternsById map, so the next loadPattern() -- which
 * runs at every pattern boundary, including the wrap back to sequence
 * position 0 -- re-read the PRE-edit pattern object and reverted the row
 * count. First pass through the edited pattern honored the edit; every pass
 * after a loop wrap played the old length again.
 */

function buildLoopSong(): Song {
  return {
    title: 'pattern-length loop-wrap test',
    author: '',
    bpm: 125,
    sequence: ['p0', 'p1'],
    patterns: [
      { id: 'p0', length: 4, tracks: [{ id: 't0', steps: [] }] },
      { id: 'p1', length: 4, tracks: [{ id: 't0', steps: [] }] },
    ],
  };
}

/** Mirrors the controlled-fake-clock driving pattern from
 *  engine-load-caches.spec: no real audio clock, deterministic rows. */
function makeEngine(clock: { now: number }) {
  const scheduledRows: number[] = [];
  const engine = new PlaybackEngine({
    audioContext: {
      get currentTime() {
        return clock.now;
      },
      set currentTime(v: number) {},
    } as unknown as AudioContext,
    scheduledNoteHandler: () => {},
    scheduledVolumeHandler: () => {},
    scheduledPitchHandler: () => {},
  });
  const scheduleRow = Reflect.get(engine, 'scheduleRow') as (
    row: number,
    time: number,
  ) => void;
  Reflect.set(engine, 'scheduleRow', (row: number, time: number) => {
    scheduledRows.push(row);
    scheduleRow.call(engine, row, time);
  });
  return { engine, scheduledRows };
}

function driveScheduling(
  engine: PlaybackEngine,
  clock: { now: number },
  iterations: number,
  stepSeconds: number,
) {
  const startScheduledPlayback = (
    Reflect.get(engine, 'startScheduledPlayback') as () => void
  ).bind(engine);
  const scheduleAhead = (
    Reflect.get(engine, 'scheduleAhead') as () => void
  ).bind(engine);

  Reflect.set(engine, 'state', 'playing');
  startScheduledPlayback();
  (Reflect.get(engine, 'playbackClock') as { stop: () => void }).stop();

  for (let i = 0; i < iterations; i++) {
    clock.now += stepSeconds;
    scheduleAhead();
  }
}

describe('setPatternLength survives loop wraps', () => {
  it('a mid-song length edit still applies after the sequence wraps back to the edited pattern', () => {
    const clock = { now: 0 };
    const { engine, scheduledRows } = makeEngine(clock);
    engine.loadSong(buildLoopSong(), 0);

    // Live-edit p0 while it is the playing pattern: shorten 4 rows to 2.
    // The edit takes effect immediately (the current pattern's scheduling
    // length is updated in place).
    engine.setPatternLength('p0', 2);

    // Drive enough rows to cover: first pass p0 (2 rows), p1 (4 rows),
    // the sequence wrap back to p0, and p0's second and third passes.
    driveScheduling(engine, clock, 8, 0.4);

    // Expected schedule with the fix: p0 honors the edit on EVERY pass --
    // [0,1] then p1's [0,1,2,3], repeated for each loop. With the bug the
    // wrap reloads p0's pre-edit 4-row length, so the second pass of p0
    // plays [0,1,2,3] instead of [0,1] and everything after drifts.
    expect(scheduledRows.slice(0, 10)).toEqual([
      0, 1, 0, 1, 2, 3, 0, 1, 0, 1,
    ]);
  });
});
