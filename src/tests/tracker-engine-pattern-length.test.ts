import { describe, it, expect } from 'vitest';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type { Song } from '../../packages/tracker-playback/src/types';

function makeSong(): Song {
  return {
    title: 'T',
    author: 'A',
    bpm: 125,
    moduleFormat: 'xm',
    patterns: [
      { id: 'p1', length: 16, tracks: [] },
      { id: 'p2', length: 128, tracks: [] },
    ],
    sequence: ['p1', 'p2'],
  };
}

/** Reach the loaded song without exposing it on the public API. */
function loadedPatterns(engine: PlaybackEngine) {
  return (engine as unknown as { song: Song | null }).song?.patterns ?? [];
}

describe('per-pattern lengths in the engine', () => {
  it('preserves differing pattern lengths on load', () => {
    const engine = new PlaybackEngine();
    engine.loadSong(makeSong());

    const lengths = loadedPatterns(engine).map((p) => p.length);
    expect(lengths).toEqual([16, 128]);
  });

  it('setLength no longer flattens every pattern to one count', () => {
    // This is the Phase 1 blocker: setLength used to rewrite every pattern's
    // length, which would collapse exactly the variation XM depends on.
    const engine = new PlaybackEngine();
    engine.loadSong(makeSong());

    engine.setLength(64);

    const lengths = loadedPatterns(engine).map((p) => p.length);
    expect(lengths).toEqual([16, 128]);
  });

  it('setPatternLength changes only the named pattern', () => {
    const engine = new PlaybackEngine();
    engine.loadSong(makeSong());

    engine.setPatternLength('p2', 32);

    const lengths = loadedPatterns(engine).map((p) => p.length);
    expect(lengths).toEqual([16, 32]);
  });

  it('setPatternLength ignores an unknown pattern id', () => {
    const engine = new PlaybackEngine();
    engine.loadSong(makeSong());

    engine.setPatternLength('nope', 8);

    const lengths = loadedPatterns(engine).map((p) => p.length);
    expect(lengths).toEqual([16, 128]);
  });
});
