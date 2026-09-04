/**
 * Starting playback partway into a song must not silence the channels whose
 * next rows are tone portamentos.
 *
 * D55/D77/D78 settled that only a row which starts a note may stamp the
 * channel's instrument, so tone-portamento rows carry none. D79 recorded what
 * holds the instrument instead: the engine's per-track effect state, carried
 * across pattern boundaries. That works while a song plays through, and not
 * at all when playback *starts* in the middle -- which is what the tracker
 * does every time a pattern is selected and played. With an empty latch
 * `scheduleRow` resolves no instrument and drops the row whole: no note, no
 * pitch, no volume.
 *
 * Reported (Morten, 2026-09-04) as satellite_one.s3m's lead entering late and
 * quiet on its third pattern. That lead enters on three tone-portamento rows.
 */

import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type {
  PlaybackClock,
  PlaybackScheduler,
  ScheduledNoteEvent,
  Song,
} from '../../packages/tracker-playback/src/types';

/**
 * Two patterns on one channel. The first starts a note with instrument 01;
 * the second opens with a tone portamento carrying no instrument of its own,
 * exactly as an importer must leave it.
 */
function makeSong(): Song {
  return {
    title: 'T',
    author: 'A',
    bpm: 125,
    moduleFormat: 'protracker',
    patterns: [
      {
        id: 'p1',
        length: 4,
        tracks: [
          {
            id: 't0',
            steps: [
              { row: 0, note: 'C-4', midi: 60, velocity: 255, instrumentId: '01' },
            ],
          },
        ],
      },
      {
        id: 'p2',
        length: 4,
        tracks: [
          {
            id: 't0',
            steps: [
              {
                row: 0,
                note: 'E-4',
                midi: 64,
                velocity: 255,
                effect: { type: 'tonePorta', paramX: 0xf, paramY: 0x0 },
              },
            ],
          },
        ],
      },
    ],
    sequence: ['p1', 'p2'],
  };
}

function makeHarness() {
  const audioContext = { currentTime: 0 } as unknown as AudioContext;
  const clock: PlaybackClock = { start: () => {}, stop: () => {} };
  const scheduler: PlaybackScheduler = { start: vi.fn(), stop: vi.fn() };
  const notes: Array<{ trackIndex: number; row: number; midi?: number }> = [];
  const engine = new PlaybackEngine({
    audioContext,
    playbackClock: clock,
    scheduler,
    scheduledNoteHandler: (event: ScheduledNoteEvent) => {
      notes.push({
        trackIndex: event.trackIndex,
        row: event.row,
        ...(event.midi !== undefined ? { midi: event.midi } : {}),
      });
    },
  } as unknown as ConstructorParameters<typeof PlaybackEngine>[0]);
  return { engine, notes };
}

describe('starting mid-song primes the per-track instrument latch', () => {
  it('a pattern opening on a tone portamento still sounds', async () => {
    const { engine, notes } = makeHarness();
    engine.loadSong(makeSong(), 1); // start on the second pattern
    await engine.play();

    // The tone-portamento branch triggers a note-on when the channel has no
    // voice yet, so starting here must produce the lead's first note.
    expect(notes.some((n) => n.row === 0 && n.midi === 64)).toBe(true);
  });

  it('starting at the top is unaffected', async () => {
    const { engine, notes } = makeHarness();
    engine.loadSong(makeSong(), 0);
    await engine.play();

    expect(notes.some((n) => n.row === 0 && n.midi === 60)).toBe(true);
  });

  it('the latch is only a fallback: a row naming an instrument still wins', async () => {
    const song = makeSong();
    song.patterns[1]!.tracks[0]!.steps.push({
      row: 1,
      note: 'G-4',
      midi: 67,
      velocity: 255,
      instrumentId: '02',
    });
    const { engine, notes } = makeHarness();
    engine.loadSong(song, 1);
    await engine.play();

    expect(notes.some((n) => n.row === 1 && n.midi === 67)).toBe(true);
  });
});
