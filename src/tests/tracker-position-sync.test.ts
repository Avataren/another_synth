import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import type {
  PlaybackPosition,
  PlaybackScheduler,
  Song,
} from '@another-synth/tracker-playback';

/**
 * The position display must follow the audio, not a re-derivation of it.
 *
 * It used to compute the current row as elapsed audio time divided by the
 * *current* row duration. That silently assumes the duration never changed, so
 * the moment a song hit an Fxx speed or tempo command the new duration was
 * applied retroactively to all previously elapsed time: the displayed row
 * jumped and then stayed wrong for the rest of the song. Pattern delay (EEx),
 * pattern loop (E6x) and position jumps (Bxx/Dxx) break the same assumption by
 * making rows non-linear in time.
 *
 * The scheduler already computes each row's exact start time, so the display
 * now follows that timeline instead.
 */
interface EngineInternals {
  state: 'playing' | 'paused' | 'stopped';
  updatePosition: () => void;
  recordScheduledPosition: (row: number, time: number) => void;
}

function makeEngine() {
  const scheduler: PlaybackScheduler = { start: vi.fn(), stop: vi.fn() };
  const audioContext = { currentTime: 0 } as unknown as AudioContext;
  const engine = new PlaybackEngine({
    scheduler,
    audioContext,
    scheduledNoteHandler: vi.fn(),
  });

  const positions: PlaybackPosition[] = [];
  engine.on('position', (pos) => positions.push({ ...pos }));

  const clock = audioContext as unknown as { currentTime: number };
  const internals = engine as unknown as EngineInternals;

  return { engine, positions, clock, internals };
}

const song: Song = {
  title: 'test',
  author: 'tester',
  bpm: 120,
  patterns: [
    { id: 'p1', length: 8, tracks: [] },
    { id: 'p2', length: 8, tracks: [] },
  ],
  sequence: ['p1', 'p2'],
};

describe('position display follows the scheduler timeline', () => {
  it('reports a row only once its scheduled time is reached', () => {
    const { engine, positions, clock, internals } = makeEngine();
    engine.loadSong(song);
    internals.state = 'playing';

    internals.recordScheduledPosition(1, 0.5);

    // Before the row is due, the position must not advance.
    clock.currentTime = 0.4;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(0);

    clock.currentTime = 0.5;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(1);
  });

  it('does not skip ahead to rows that are merely queued', () => {
    // The scheduler runs up to a second ahead of the audio; the display must
    // not run ahead with it.
    const { engine, positions, clock, internals } = makeEngine();
    engine.loadSong(song);
    internals.state = 'playing';

    internals.recordScheduledPosition(1, 0.25);
    internals.recordScheduledPosition(2, 0.5);
    internals.recordScheduledPosition(3, 0.75);

    clock.currentTime = 0.3;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(1);
  });

  it('lands on the latest reached row when several fall due at once', () => {
    const { engine, positions, clock, internals } = makeEngine();
    engine.loadSong(song);
    internals.state = 'playing';

    internals.recordScheduledPosition(1, 0.1);
    internals.recordScheduledPosition(2, 0.2);
    internals.recordScheduledPosition(3, 0.3);

    // A stalled frame should resolve to the current row, not the oldest.
    clock.currentTime = 0.35;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(3);
  });

  it('stays correct when the row duration changes mid-song', () => {
    // The regression: rows 0-1 at one tempo, then a speed change halves the
    // row duration. Deriving position from elapsed time and the *new*
    // duration would place the display far ahead of the audio.
    const { engine, positions, clock, internals } = makeEngine();
    engine.loadSong(song);
    internals.state = 'playing';

    internals.recordScheduledPosition(1, 1.0); // slow rows
    internals.recordScheduledPosition(2, 2.0);
    internals.recordScheduledPosition(3, 2.25); // tempo change: 4x faster
    internals.recordScheduledPosition(4, 2.5);

    clock.currentTime = 2.0;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(2);

    clock.currentTime = 2.25;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(3);

    // Elapsed-time division with the fast duration would have reported
    // 2.5 / 0.25 = row 10 here, well past the end of the pattern.
    clock.currentTime = 2.5;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(4);
  });

  it('follows repeated rows from a pattern delay', () => {
    // EEx repeats a row, so time advances while the row does not. A
    // time-derived position cannot represent that at all.
    const { engine, positions, clock, internals } = makeEngine();
    engine.loadSong(song);
    internals.state = 'playing';

    internals.recordScheduledPosition(2, 0.5);
    internals.recordScheduledPosition(2, 1.0); // same row again
    internals.recordScheduledPosition(3, 1.5);

    clock.currentTime = 1.0;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(2);

    clock.currentTime = 1.5;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(3);
  });

  it('reports the pattern the scheduled row belongs to', () => {
    const { engine, positions, clock, internals } = makeEngine();
    engine.loadSong(song);
    internals.state = 'playing';

    internals.recordScheduledPosition(1, 0.5);
    clock.currentTime = 0.5;
    internals.updatePosition();

    expect(positions[positions.length - 1]!.patternId).toBe('p1');
    expect(positions[positions.length - 1]!.sequenceIndex).toBe(0);
  });

  it('discards queued rows on stop so they cannot leak into the next run', () => {
    const { engine, positions, clock, internals } = makeEngine();
    engine.loadSong(song);
    internals.state = 'playing';

    internals.recordScheduledPosition(5, 0.5);
    engine.stop();

    internals.state = 'playing';
    clock.currentTime = 0.5;
    internals.updatePosition();

    // Nothing is queued, so the position stays where stop left it.
    expect(positions[positions.length - 1]!.row).not.toBe(5);
  });

  it('discards queued rows on seek', () => {
    const { engine, positions, clock, internals } = makeEngine();
    engine.loadSong(song);
    internals.state = 'playing';

    internals.recordScheduledPosition(6, 0.5);
    engine.seek(2);

    clock.currentTime = 0.5;
    internals.updatePosition();
    expect(positions[positions.length - 1]!.row).toBe(2);
  });
});
