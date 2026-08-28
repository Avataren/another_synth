import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type {
  PlaybackPosition,
  PlaybackScheduler,
  Song,
} from '../../packages/tracker-playback/src/types';

describe('PlaybackEngine sequence start offset', () => {
  it('keeps the selected sequence index when starting mid-sequence', () => {
    const scheduler: PlaybackScheduler = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const audioContext = {
      currentTime: 0,
    } as unknown as AudioContext;

    const song: Song = {
      title: 'test',
      author: 'tester',
      bpm: 120,
      patterns: [
        { id: 'p1', length: 4, tracks: [] },
        { id: 'p2', length: 4, tracks: [] },
        { id: 'p3', length: 4, tracks: [] },
      ],
      sequence: ['p1', 'p2', 'p3'],
    };

    const engine = new PlaybackEngine({
      scheduler,
      audioContext,
      scheduledNoteHandler: vi.fn(), // keep scheduled path available if invoked
    });

    let lastPosition: PlaybackPosition | null = null;
    engine.on('position', (pos) => {
      lastPosition = pos;
    });

    // Start from the second pattern in the sequence
    engine.loadSong(song, 1);

    type EngineInternals = {
      state: 'playing' | 'paused' | 'stopped';
      updatePosition: () => void;
      recordScheduledPosition: (row: number, time: number) => void;
    };
    const internals = engine as unknown as EngineInternals;

    // Loading mid-sequence must place the position on that pattern.
    const loaded = lastPosition as PlaybackPosition | null;
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.patternId).toBe('p2');
    expect(loaded.sequenceIndex).toBe(1);
    expect(loaded.row).toBe(0);

    // Advancing the display now follows the scheduler's own row timeline
    // rather than dividing elapsed time by the current row duration, so drive
    // it the way playback does: record a scheduled row, then reach its time.
    internals.state = 'playing';
    const mutableAudioContext = audioContext as unknown as { currentTime: number };
    internals.recordScheduledPosition(1, 0.2);
    mutableAudioContext.currentTime = 0.2;
    internals.updatePosition();

    const pos = lastPosition as PlaybackPosition | null;
    expect(pos).not.toBeNull();
    if (!pos) return;
    expect(pos.patternId).toBe('p2');
    expect(pos.sequenceIndex).toBe(1);
    expect(pos.row).toBe(1);
  });
});
