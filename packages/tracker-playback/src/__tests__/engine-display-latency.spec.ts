import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '../engine';
import type { PlaybackClock, Song } from '../types';

/**
 * The playing row is timed against what is *heard*, not what is rendered.
 *
 * `AudioContext.currentTime` is the render clock: frames stamped with time T
 * still have to cross the output buffer before anyone hears them. A desktop
 * context buffers a few milliseconds of that and nobody notices; a phone,
 * whose context is built for a deeper buffer, was showing the pattern up to a
 * quarter of a second ahead of the sound -- and cutting the song's last row
 * short by the same amount, because the end was taken on the render clock too.
 */
function songOf(rows: number): Song {
  return {
    title: 'T',
    author: 'A',
    bpm: 125, // with the default speed of 6, one row is 0.12s
    patterns: [{ id: 'p1', length: rows, tracks: [{ id: 't1', steps: [] }] }],
    sequence: ['p1'],
  };
}

const ROW_SECONDS = 0.12;

type FakeContext = {
  currentTime: number;
  baseLatency: number;
  outputLatency?: number;
};

function makeEngine(ctx: FakeContext, song = songOf(16)) {
  let tick: (() => void) | null = null;
  const clock: PlaybackClock = {
    start: (fn) => {
      tick = fn as () => void;
    },
    stop: () => {
      tick = null;
    },
  };
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: ctx as unknown as AudioContext,
    scheduledNoteHandler: vi.fn(),
    playbackClock: clock,
  });
  engine.loadSong(song);
  const rows: number[] = [];
  engine.on('position', (p) => rows.push(p.row));
  return { engine, rows, tick: () => tick?.() };
}

describe('the display follows the audible clock', () => {
  it('holds the playing row back by the output latency', async () => {
    const ctx: FakeContext = {
      currentTime: 0,
      baseLatency: 0.005,
      outputLatency: 0.25,
    };
    const { engine, rows, tick } = makeEngine(ctx);
    await engine.play();

    // Two rows have been rendered, but the first is still inside the output
    // buffer: nothing has been heard yet, so nothing has advanced.
    ctx.currentTime = ROW_SECONDS * 2 + 0.01;
    tick();
    expect(rows).toEqual([]);

    // A quarter-second later, row 2 is the one leaving the speaker.
    ctx.currentTime += 0.25;
    tick();
    expect(rows.at(-1)).toBe(2);
  });

  it('advances immediately when the context reports no latency', async () => {
    const ctx: FakeContext = { currentTime: 0, baseLatency: 0 };
    const { engine, rows, tick } = makeEngine(ctx);
    await engine.play();

    ctx.currentTime = ROW_SECONDS * 3 + 0.01;
    tick();
    expect(rows.at(-1)).toBe(3);
  });

  it('falls back to baseLatency where outputLatency is unimplemented', async () => {
    // Safari reports only baseLatency.
    const ctx: FakeContext = { currentTime: 0, baseLatency: ROW_SECONDS };
    const { engine, rows, tick } = makeEngine(ctx);
    await engine.play();

    ctx.currentTime = ROW_SECONDS * 3 + 0.01;
    tick();
    expect(rows.at(-1)).toBe(2);
  });

  it('ignores a latency reading too large to be a buffer', async () => {
    // Clamped at half a second: a nonsense reading must not freeze the
    // display, which is what an uncapped compensation would do.
    const ctx: FakeContext = {
      currentTime: 0,
      baseLatency: 0.005,
      outputLatency: 30,
    };
    const { engine, rows, tick } = makeEngine(ctx);
    await engine.play();

    ctx.currentTime = 10;
    tick();
    // Clamped, the display catches up to the last row the lookahead had
    // queued. Uncompensated by 30 seconds it would sit at row 0 forever.
    expect(rows.at(-1)).toBeGreaterThan(0);
  });
});
