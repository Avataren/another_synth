import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type {
  PlaybackClock,
  PlaybackScheduler,
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
    states,
    getState: () => state,
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
