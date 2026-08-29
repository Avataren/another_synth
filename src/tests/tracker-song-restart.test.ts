import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type { Song } from '../../packages/tracker-playback/src/types';

/**
 * Wrapping back to the start of the sequence is a restart.
 *
 * Songs that end on a fade are where it shows: the fade is usually a
 * global-volume ramp (`Gxx`), which turns the mix down without stopping
 * anything, so every note still running at the last row is still running when
 * the song wraps -- and the first pattern restoring the volume brings the lot
 * back. xyce-dans_la_rue.xm ends on `G1F` counting to `G00` and opens with
 * `G80`, with eight channels holding single-cycle looping samples whose
 * envelopes have no sustain and a non-zero final point, so they never stop on
 * their own.
 *
 * The second reason is plainer: without this, a second pass through a song
 * does not sound like the first, because per-track effect state and the global
 * volume carry over.
 */
function songOf(patternIds: string[]): Song {
  return {
    title: 'T',
    author: 'A',
    bpm: 125,
    moduleFormat: 'xm',
    patterns: patternIds.map((id) => ({
      id,
      length: 1,
      tracks: [{ id: 't1', steps: [] }],
    })),
    sequence: patternIds,
  };
}

function makeEngine(song: Song) {
  const allNotesOff = vi.fn();
  const globalVolume = vi.fn();
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: vi.fn(),
    scheduledAllNotesOffHandler: allNotesOff,
    scheduledGlobalVolumeHandler: globalVolume,
  });
  engine.loadSong(song);
  return { engine, allNotesOff, globalVolume };
}

/** Drive the scheduler until it has wrapped past the end of the sequence. */
function scheduleUntilWrapped(engine: PlaybackEngine) {
  const internals = engine as unknown as {
    scheduleAhead: () => void;
    state: string;
  };
  internals.state = 'playing';
  for (let i = 0; i < 40; i++) internals.scheduleAhead();
}

describe('looping the song restarts it', () => {
  it('silences everything at the wrap', () => {
    const { engine, allNotesOff } = makeEngine(songOf(['p1', 'p2']));
    engine.setLoopSong(true);

    scheduleUntilWrapped(engine);

    expect(allNotesOff).toHaveBeenCalled();
  });

  it('restores the global volume a fade left turned down', () => {
    const { engine, globalVolume } = makeEngine(songOf(['p1', 'p2']));
    engine.setLoopSong(true);
    // Stand in for the Gxx fade the last pattern would have applied.
    Reflect.set(engine as object, 'globalVolume', 0);

    scheduleUntilWrapped(engine);

    expect(Reflect.get(engine as object, 'globalVolume')).toBe(1);
    expect(globalVolume).toHaveBeenCalledWith(1, expect.any(Number));
  });

  it('does not silence anything when the song is not looping', () => {
    const { engine, allNotesOff } = makeEngine(songOf(['p1', 'p2']));
    engine.setLoopSong(false);

    scheduleUntilWrapped(engine);

    expect(allNotesOff).not.toHaveBeenCalled();
  });
});
