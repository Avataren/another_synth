/**
 * A pattern break must not flip the *visible* position at schedule time.
 *
 * The engine schedules about half a second ahead of the audio clock, so the
 * row the scheduler is working on is four or five rows ahead of the row being
 * heard. `recordScheduledPosition` exists for exactly this: every scheduled
 * row is queued with the time it will be heard, and `updatePosition` promotes
 * one to `position` only once the audio clock reaches it.
 *
 * The natural pattern-end path preloads the next pattern "without flipping the
 * visible position yet". Bxx and Cxx did not: they loaded the pattern *and*
 * assigned `this.position` and emitted it there and then. The grid jumped to
 * row 0 of the next pattern several rows early, then snapped back as the queue
 * caught up -- one frame at the top, mid-pattern.
 *
 * Reported (Morten, 2026-09-04) on caverns_of_cthulu.s3m, whose second
 * sequence entry carries a C00 at row 0x1F, seen "around row 1A".
 */

import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import type {
  PlaybackClock,
  PlaybackScheduler,
  Song,
  Step,
} from '@another-synth/tracker-playback';

/**
 * Two 8-row patterns. The first breaks to the next pattern at row 2, which is
 * well inside the scheduler's lookahead from a standing start.
 */
function makeSong(breakStep: Step): Song {
  return {
    title: 'T',
    author: 'A',
    bpm: 125,
    moduleFormat: 'protracker',
    patterns: [
      {
        id: 'p1',
        length: 8,
        tracks: [{ id: 't0', steps: [breakStep] }],
      },
      { id: 'p2', length: 8, tracks: [{ id: 't0', steps: [] }] },
    ],
    sequence: ['p1', 'p2'],
  };
}

function makeHarness(song: Song) {
  const audioContext = { currentTime: 0 } as unknown as AudioContext;
  let tick: (() => void) | null = null;
  const clock: PlaybackClock = {
    start: (fn) => {
      tick = fn as () => void;
    },
    stop: () => {
      tick = null;
    },
  };
  const scheduler: PlaybackScheduler = { start: vi.fn(), stop: vi.fn() };
  const engine = new PlaybackEngine({
    audioContext,
    playbackClock: clock,
    scheduler,
    scheduledNoteHandler: vi.fn(),
  } as unknown as ConstructorParameters<typeof PlaybackEngine>[0]);

  const seen: Array<{ row: number; patternId?: string }> = [];
  engine.on('position', (pos) => {
    const entry: { row: number; patternId?: string } = { row: pos.row };
    if (pos.patternId !== undefined) entry.patternId = pos.patternId;
    seen.push(entry);
  });

  engine.loadSong(song);
  return {
    engine,
    seen,
    advanceTo(seconds: number) {
      (audioContext as { currentTime: number }).currentTime = seconds;
      tick?.();
    },
  };
}

describe('a pattern break does not move the display ahead of the audio', () => {
  it('Cxx keeps the display on the outgoing pattern until it is heard', async () => {
    const { engine, seen, advanceTo } = makeHarness(
      makeSong({ row: 2, effect: { type: 'patBreak', paramX: 0, paramY: 0 } }),
    );
    await engine.play();

    // Scheduling has already run past the break at row 2, but nothing has
    // been *heard* yet: the display must still be on the first pattern.
    expect(seen.filter((p) => p.patternId === 'p2')).toEqual([]);

    // Once the clock reaches it, the queue promotes it normally.
    advanceTo(5);
    expect(seen.at(-1)?.patternId).toBe('p2');
  });

  it('Bxx does the same', async () => {
    const { engine, seen, advanceTo } = makeHarness(
      makeSong({ row: 2, effect: { type: 'posJump', paramX: 0, paramY: 1 } }),
    );
    await engine.play();

    expect(seen.filter((p) => p.patternId === 'p2')).toEqual([]);

    advanceTo(5);
    expect(seen.at(-1)?.patternId).toBe('p2');
  });
});
