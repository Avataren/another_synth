import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type {
  Song,
  PlaybackScheduler,
} from '../../packages/tracker-playback/src/types';

/**
 * Speed and BPM are both playback state that Fxx mutates as a song runs, so
 * neither may survive a stop: pressing play used to restore the song's speed
 * but leave the BPM wherever the last row before the stop had put it, so a
 * restarted song ran at a tempo unrelated to anything in it.
 *
 * Starting anywhere but the top is the mirror case -- the tempo and speed a
 * tracker would be at there are the last ones set before that point, not the
 * song's initial pair.
 */
function makeEngine() {
  const scheduler: PlaybackScheduler = { start: vi.fn(), stop: vi.fn() };
  const audioContext = { currentTime: 0 } as unknown as AudioContext;
  return new PlaybackEngine({
    scheduler,
    audioContext,
    scheduledNoteHandler: vi.fn(),
  });
}

function rowMs(engine: PlaybackEngine): number {
  return (engine as unknown as { getMsPerRow: () => number }).getMsPerRow();
}

/** A song whose row 8 doubles the tempo and halves the ticks per row. */
const song: Song = {
  title: '',
  author: '',
  bpm: 125,
  initialSpeed: 6,
  patterns: [
    {
      id: 'p0',
      length: 64,
      tracks: [
        {
          id: 't0',
          steps: [{ row: 8, tempoCommand: 250, speedCommand: 3 }],
        },
      ],
    },
    { id: 'p1', length: 64, tracks: [{ id: 't1', steps: [] }] },
  ],
  sequence: ['p0', 'p1'],
};

// 125 BPM at speed 6 -> (60000/125/4) * (6/6) = 120ms per row.
const INITIAL_ROW_MS = 120;
// 250 BPM at speed 3 -> (60000/250/4) * (3/6) = 30ms per row.
const CHANGED_ROW_MS = 30;

describe('timing on restart', () => {
  it('restores both BPM and speed when playing from the top again', async () => {
    const engine = makeEngine();
    engine.loadSong(song);
    // Start past row 8 so the run picks up its Fxx pair, the way playing
    // through the song would.
    engine.seek(32);
    await engine.play();
    expect(rowMs(engine)).toBeCloseTo(CHANGED_ROW_MS, 6);

    engine.stop();
    engine.seek(0);
    await engine.play();
    expect(rowMs(engine)).toBeCloseTo(INITIAL_ROW_MS, 6);
  });

  it('starts a mid-pattern row at the tempo the rows before it set', async () => {
    const engine = makeEngine();
    engine.loadSong(song);
    engine.seek(32);
    await engine.play();
    // Row 8 played (in the song, not in this run), so 32 inherits its tempo.
    expect(rowMs(engine)).toBeCloseTo(CHANGED_ROW_MS, 6);
  });

  it('does not apply an Fxx that sits on or after the starting row', async () => {
    const engine = makeEngine();
    engine.loadSong(song);
    engine.seek(8);
    await engine.play();
    // Row 8's own Fxx is applied by the scheduler when row 8 plays, so the
    // scan must stop short of it rather than double-applying it early.
    expect(rowMs(engine)).toBeCloseTo(CHANGED_ROW_MS, 6);
  });

  it('inherits an Fxx from an earlier pattern in the order list', async () => {
    const engine = makeEngine();
    engine.loadSong(song, 1);
    await engine.play();
    expect(rowMs(engine)).toBeCloseTo(CHANGED_ROW_MS, 6);
  });

  it('keeps a BPM set from the UI across a stop and play', async () => {
    const engine = makeEngine();
    engine.loadSong({
      ...song,
      patterns: [song.patterns[1]!],
      sequence: ['p1'],
    });
    engine.setBpm(100);
    await engine.play();
    engine.stop();
    await engine.play();
    // 100 BPM at speed 6 -> 150ms per row.
    expect(rowMs(engine)).toBeCloseTo(150, 6);
  });
});
