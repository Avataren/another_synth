import { describe, expect, it } from 'vitest';

import { PlaybackEngine } from '../engine';
import type { Song } from '../types';

/**
 * Coverage for the engine's load-time caches (playback-optimization P4/P8):
 *
 * - the built per-pattern step index is cached by pattern-object identity
 *   (patterns are immutable between loadSong calls; setPatternLength
 *   replaces the edited pattern object, so identity keying invalidates
 *   naturally) -- an edit must still take effect, and a fresh loadSong
 *   reusing a pattern id must never serve a stale index;
 * - the instrument-id set prepareInstruments resolves is collected once by
 *   loadSong -- a fresh loadSong with different patterns must pick up the
 *   new instruments.
 *
 * A cache keyed by anything coarser than pattern-object identity (e.g.
 * pattern id) would fail the cross-loadSong tests below by dispatching the
 * old song's steps/notes.
 */

function buildSong(
  steps: Array<{ row: number; instrumentId?: string; midi?: number }>,
  options: { patternId?: string; length?: number } = {},
): Song {
  return {
    title: 'load-cache test',
    author: '',
    bpm: 125,
    sequence: [options.patternId ?? 'p0'],
    patterns: [
      {
        id: options.patternId ?? 'p0',
        length: options.length ?? 4,
        tracks: [
          {
            id: 't0',
            steps,
          },
        ],
      },
    ],
  };
}

/** Mirrors the private-field driving pattern from engine-pattern-delay.spec:
 *  a fully controlled fake clock so the test is fast and deterministic. */
function driveScheduling(
  engine: PlaybackEngine,
  iterations: number,
  stepSeconds: number,
) {
  let fakeNow = 0;
  const audioContext = Reflect.get(engine, 'audioContext') as
    | { currentTime: number }
    | undefined;
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
    fakeNow += stepSeconds;
    if (audioContext) audioContext.currentTime = fakeNow;
    scheduleAhead();
  }
}

function makeEngine(onNote?: (midi: number | undefined, row: number) => void) {
  const scheduledRows: number[] = [];
  const engine = new PlaybackEngine({
    audioContext: {
      get currentTime() {
        return 0;
      },
      set currentTime(v: number) {},
    } as unknown as AudioContext,
    scheduledNoteHandler: (event) => {
      if (event.type === 'noteOn') {
        onNote?.(event.midi, event.row);
      }
    },
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

describe('pattern index cache invalidation (P4)', () => {
  it('an edit via setPatternLength still takes effect (identity invalidation)', () => {
    const song = buildSong(
      [
        { row: 0, instrumentId: '01', midi: 60 },
        { row: 1, instrumentId: '01', midi: 62 },
        { row: 2, instrumentId: '01', midi: 64 },
        { row: 3, instrumentId: '01', midi: 65 },
      ],
      { length: 4 },
    );
    const { engine, scheduledRows } = makeEngine();
    engine.loadSong(song, 0);

    // Replace the pattern object with a 2-row version. The engine must pick
    // up the new row count: the row cursor wraps at the edited length, so
    // the first wrap lands on row 0 right after row 1 instead of running on
    // to rows 2 and 3.
    engine.setPatternLength('p0', 2);
    driveScheduling(engine, 6, 0.4);

    expect(scheduledRows.slice(0, 3)).toEqual([0, 1, 0]);
  });

  it('a fresh loadSong reusing the pattern id serves the new steps, never the cached index', () => {
    const songA = buildSong(
      [{ row: 0, instrumentId: '01', midi: 60 }],
      { length: 4 },
    );
    const songB = buildSong(
      [
        { row: 0, instrumentId: '02', midi: 62 },
        { row: 1, instrumentId: '02', midi: 64 },
      ],
      { length: 4 },
    );

    const notes: Array<{ midi: number | undefined; row: number }> = [];
    const { engine } = makeEngine((midi, row) => notes.push({ midi, row }));

    engine.loadSong(songA, 0);
    driveScheduling(engine, 4, 0.4);
    expect(notes.map((n) => n.midi)).toContain(60);

    notes.length = 0;
    engine.loadSong(songB, 0);
    driveScheduling(engine, 4, 0.4);
    const midis = notes.map((n) => n.midi);
    expect(midis).toContain(62);
    expect(midis).toContain(64);
    expect(midis).not.toContain(60);
  });
});

describe('instrument-id collection moved to loadSong (P8)', () => {
  it('resolves the instruments of the freshly loaded song', async () => {
    const resolved: string[] = [];
    const engine = new PlaybackEngine({
      instrumentResolver: (id) => {
        if (id !== undefined) resolved.push(id);
      },
    } as ConstructorParameters<typeof PlaybackEngine>[0]);

    engine.loadSong(
      buildSong([
        { row: 0, instrumentId: '01', midi: 60 },
        { row: 1, instrumentId: '02', midi: 62 },
      ]),
      0,
    );
    await engine.prepareInstruments();
    expect([...resolved].sort()).toEqual(['01', '02']);

    // A fresh loadSong with different patterns must invalidate: the new
    // song's instruments are resolved, the old ones are not re-resolved.
    resolved.length = 0;
    engine.loadSong(
      buildSong([{ row: 0, instrumentId: '03', midi: 64 }]),
      0,
    );
    await engine.prepareInstruments();
    expect(resolved).toEqual(['03']);
  });

  it('tracks with a sticky instrument but no explicit step instrument are resolved too', async () => {
    const resolved: string[] = [];
    const engine = new PlaybackEngine({
      instrumentResolver: (id) => {
        if (id !== undefined) resolved.push(id);
      },
    } as ConstructorParameters<typeof PlaybackEngine>[0]);

    const song: Song = {
      title: 'track-level instrument',
      author: '',
      bpm: 125,
      sequence: ['p0'],
      patterns: [
        {
          id: 'p0',
          length: 2,
          tracks: [
            {
              id: 't0',
              instrumentId: '07',
              steps: [{ row: 0, midi: 60 }],
            },
          ],
        },
      ],
    };
    engine.loadSong(song, 0);
    await engine.prepareInstruments();
    expect(resolved).toEqual(['07']);
  });
});
