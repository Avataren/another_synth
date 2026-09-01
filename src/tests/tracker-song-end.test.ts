import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type {
  PlaybackClock,
  PlaybackScheduler,
  Pattern,
  Song,
} from '../../packages/tracker-playback/src/types';

/**
 * The end of a non-looping song, which is what the jukebox advances on.
 *
 * The interesting part is *when* it happens. The engine schedules up to half a
 * second ahead of the audio clock, and stopping cancels everything scheduled,
 * so noticing the end at schedule time and stopping there would throw away the
 * song's last half second. The end has to be deferred until the clock reaches
 * it.
 */

function makeSong(): Song {
  return {
    title: 'T',
    author: 'A',
    bpm: 125,
    moduleFormat: 'protracker',
    patterns: [
      { id: 'p1', length: 4, tracks: [] },
      { id: 'p2', length: 4, tracks: [] },
    ],
    sequence: ['p1', 'p2'],
  };
}

/** An engine wired to a clock and an audio clock the test drives by hand. */
function makeHarness() {
  const audioContext = { currentTime: 0 } as unknown as AudioContext;
  let tick: ((deltaMs: number) => void) | null = null;
  const clock: PlaybackClock = {
    start: (fn) => {
      tick = fn;
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
  });

  const ends: number[] = [];
  engine.on('songEnd', () => ends.push(audioContext.currentTime));

  const positions: number[] = [];
  engine.on('position', (pos) => positions.push(pos.sequenceIndex ?? -1));

  const states: string[] = [];
  let state = 'stopped';
  engine.on('state', (next) => {
    state = next;
    states.push(next);
  });

  /** Move the audio clock forward and let the engine act on it. */
  function advanceTo(seconds: number) {
    (audioContext as { currentTime: number }).currentTime = seconds;
    tick?.(0);
  }

  return {
    engine,
    audioContext,
    advanceTo,
    ends,
    positions,
    states,
    getState: () => state,
  };
}

/**
 * Three four-row patterns, one of them carrying a Bxx position jump on its
 * last row. The engine consumes a pending jump on the row after the one that
 * carried it, so the last row still plays before the jump is taken.
 */
function jumpSong(jumpPattern: string, targetOrder: number): Song {
  const patterns: Pattern[] = [
    { id: 'p1', length: 4, tracks: [] },
    { id: 'p2', length: 4, tracks: [] },
    { id: 'p3', length: 4, tracks: [] },
  ];
  const index = patterns.findIndex((p) => p.id === jumpPattern);
  patterns[index] = {
    ...patterns[index]!,
    tracks: [
      {
        id: 't0',
        steps: [
          {
            row: 3,
            effect: {
              type: 'posJump',
              paramX: Math.floor(targetOrder / 16),
              paramY: targetOrder % 16,
            },
          },
        ],
      },
    ],
  };
  return {
    title: 'T',
    author: 'A',
    bpm: 125,
    moduleFormat: 'protracker',
    patterns,
    sequence: ['p1', 'p2', 'p3'],
  };
}

describe('end of a non-looping song', () => {
  it('does not fire while the song still loops', async () => {
    const { engine, advanceTo, ends, getState } = makeHarness();
    engine.loadSong(makeSong());
    await engine.play();

    // Well past the song's own length: it has wrapped several times over.
    for (let t = 0.5; t <= 8; t += 0.5) advanceTo(t);

    expect(ends).toHaveLength(0);
    expect(getState()).toBe('playing');
  });

  it('waits for the audio clock to reach the end before stopping', async () => {
    const { engine, advanceTo, ends, getState } = makeHarness();
    engine.loadSong(makeSong());
    engine.setLoopSong(false);
    await engine.play();

    // Eight rows at 125 BPM and the default speed of 6 is 8 * 0.12s = 0.96s.
    const songSeconds = 8 * 6 * (2.5 / 125);

    // The first scheduling pass already runs past the end of the song, so the
    // engine knows the end is coming -- but it has not happened yet.
    advanceTo(0.5);
    expect(ends).toHaveLength(0);
    expect(getState()).toBe('playing');

    // Still not, one tick short of it.
    advanceTo(songSeconds - 0.01);
    expect(ends).toHaveLength(0);
    expect(getState()).toBe('playing');

    advanceTo(songSeconds);
    expect(ends).toHaveLength(1);
    expect(getState()).toBe('stopped');
  });

  it('reports the end once, not on every tick after it', async () => {
    const { engine, advanceTo, ends } = makeHarness();
    engine.loadSong(makeSong());
    engine.setLoopSong(false);
    await engine.play();

    for (let t = 0.5; t <= 4; t += 0.25) advanceTo(t);

    expect(ends).toHaveLength(1);
  });

  it('stops before it says so, so a listener can start the next song', async () => {
    const { engine, advanceTo, states, getState } = makeHarness();
    engine.loadSong(makeSong());
    engine.setLoopSong(false);
    await engine.play();

    let stateAtEnd: string | null = null;
    engine.on('songEnd', () => {
      stateAtEnd = getState();
    });

    for (let t = 0.5; t <= 4; t += 0.25) advanceTo(t);

    // The transport is already stopped by the time the end is announced, so a
    // listener is free to load and start the next song right there.
    expect(stateAtEnd).toBe('stopped');
    expect(states.slice(-2)).toEqual(['playing', 'stopped']);
  });

  it('plays once more after being restarted', async () => {
    const { engine, advanceTo, ends, getState } = makeHarness();
    engine.loadSong(makeSong());
    engine.setLoopSong(false);
    await engine.play();

    for (let t = 0.5; t <= 4; t += 0.25) advanceTo(t);
    expect(ends).toHaveLength(1);

    // A second run must end too: the pending end is per-run state, and leaving
    // it set would stop the next song the moment it started.
    await engine.play();
    expect(getState()).toBe('playing');
    for (let t = 4.5; t <= 8; t += 0.25) advanceTo(t);
    expect(ends).toHaveLength(2);
  });
});

describe('a backward order jump on the last pattern', () => {
  it('ends a non-looping song instead of looping from the jump', async () => {
    // The last pattern jumps back to the first order position. Nothing after
    // the jump would ever run the sequence past its end, so without treating
    // this as the end the song would repeat from the jump forever and a
    // jukebox waiting on songEnd would never advance.
    const { engine, advanceTo, ends, getState } = makeHarness();
    engine.loadSong(jumpSong('p3', 0));
    engine.setLoopSong(false);
    await engine.play();

    // Twelve rows at 125 BPM and speed 6, then the row after the jump
    // becomes the deferred end. The jump is consumed when the row after it
    // would be scheduled -- at 1.44s -- so at 1.2 the tail is still ahead.
    advanceTo(1.2);
    expect(ends).toHaveLength(0);
    expect(getState()).toBe('playing');

    // The end lands on the row slot after the jump, not back at the start.
    // A hair past 1.44: the pending end time is the scheduler's accumulated
    // row time, which sits just above the decimal literal.
    advanceTo(1.45);
    expect(ends).toHaveLength(1);
    expect(getState()).toBe('stopped');

    // It ended rather than looping back and carrying on.
    advanceTo(4);
    expect(ends).toHaveLength(1);
  });

  it('also ends on a jump back to the pattern itself', async () => {
    // B00 on the song's only order is the degenerate backward jump: the
    // target equals the current position, and it loops the pattern forever.
    const { engine, advanceTo, ends, getState } = makeHarness();
    engine.loadSong(jumpSong('p3', 2));
    engine.setLoopSong(false);
    await engine.play();

    for (let t = 0.25; t <= 3; t += 0.25) advanceTo(t);
    expect(ends).toHaveLength(1);
    expect(getState()).toBe('stopped');
  });

  it('keeps a backward jump mid-song looping instead of ending the song', async () => {
    // The same jump on the MIDDLE pattern is a pattern loop: it must keep
    // jumping back however long it plays, and must not end the song.
    const { engine, advanceTo, ends, positions, getState } = makeHarness();
    engine.loadSong(jumpSong('p2', 0));
    engine.setLoopSong(false);
    await engine.play();

    // Far past where a straight run through the song would have ended.
    for (let t = 0.5; t <= 4; t += 0.5) advanceTo(t);
    expect(ends).toHaveLength(0);
    expect(getState()).toBe('playing');

    // And it really went back: the first pattern plays more than once.
    expect(positions.filter((index) => index === 0).length).toBeGreaterThan(1);
  });

  it('still loops a looping song that jumps backward on its last pattern', async () => {
    const { engine, advanceTo, ends, getState } = makeHarness();
    engine.loadSong(jumpSong('p3', 0));
    // loopSong defaults to true; nothing turns it off.
    await engine.play();

    for (let t = 0.5; t <= 4; t += 0.5) advanceTo(t);
    expect(ends).toHaveLength(0);
    expect(getState()).toBe('playing');
  });
});
