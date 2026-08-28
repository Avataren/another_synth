import { describe, expect, it } from 'vitest';

import { PlaybackEngine } from '../engine';
import type { Song, EffectCommand, ScheduledNoteEvent } from '../types';

/**
 * Regression coverage for a real timing bug found via sound.mod (a real
 * Amiga MOD file): a row that both changes speed (F05/F06, common in
 * shuffle/groove patterns that alternate speed every row) *and* carries a
 * tick-based effect (note delay, vibrato, retrigger, tremor, ...) computed
 * that effect's sub-row tick timing using the *previous* row's tick
 * duration instead of its own.
 *
 * Root cause, in scheduleRow(): msPerRow/msPerTick/secPerRow/secPerTick
 * used to be captured at the very top of the function, before the "first
 * pass" loop that applies this row's own F-command to the TimingSystem.
 * ProTracker semantics: a speed/tempo change on a row takes effect
 * immediately, governing that same row's own remaining ticks -- so any
 * per-tick effect on a speed-changing row needs the *new* tick duration,
 * not the one captured before the change.
 */
function buildSpeedChangeSong(): Song {
  const noteDelay: EffectCommand = { type: 'noteDelay', paramX: 0, paramY: 1 };

  return {
    title: 'speed change tick timing test',
    author: '',
    bpm: 125,
    sequence: ['p0'],
    patterns: [
      {
        id: 'p0',
        length: 4,
        tracks: [
          {
            id: 't0',
            steps: [
              { row: 0, instrumentId: '01', midi: 60 },
              {
                row: 1,
                instrumentId: '01',
                midi: 72,
                velocity: 200,
                effect: noteDelay,
                speedCommand: 3, // F03: 2x faster than the default speed 6
              },
            ],
          },
        ],
      },
    ],
  };
}

function driveScheduling(
  engine: PlaybackEngine,
  iterations: number,
  stepSeconds: number,
  audioContext: { currentTime: number },
) {
  let fakeNow = 0;
  const startScheduledPlayback = (
    Reflect.get(engine, 'startScheduledPlayback') as () => void
  ).bind(engine);
  const scheduleAhead = (Reflect.get(engine, 'scheduleAhead') as () => void).bind(engine);

  Reflect.set(engine, 'state', 'playing');
  startScheduledPlayback();
  (Reflect.get(engine, 'playbackClock') as { stop: () => void }).stop();

  for (let i = 0; i < iterations; i++) {
    fakeNow += stepSeconds;
    audioContext.currentTime = fakeNow;
    scheduleAhead();
  }
}

describe('PlaybackEngine tick timing on a row that changes speed', () => {
  it('schedules a same-row note-delay using the new (post-command) tick duration, not the previous row\'s', () => {
    const song = buildSpeedChangeSong();
    const audioContext = { currentTime: 0 };

    const events: ScheduledNoteEvent[] = [];
    const engine = new PlaybackEngine({
      audioContext: audioContext as unknown as AudioContext,
      scheduledNoteHandler: (event) => events.push(event),
      scheduledVolumeHandler: () => {},
      scheduledPitchHandler: () => {},
    });
    engine.loadSong(song, 0);

    driveScheduling(engine, 20, 0.05, audioContext);

    const row0On = events.find((e) => e.type === 'noteOn' && e.row === 0);
    const row1Delayed = events.find((e) => e.type === 'noteOn' && e.row === 1);
    expect(row0On).toBeDefined();
    expect(row1Delayed).toBeDefined();
    if (!row0On || !row1Delayed) return;

    // Row 0 at default speed 6, bpm 125: row duration = (60000/125)/4 = 120ms.
    const row1StartTime = row0On.time + 0.12;
    // Row 1 sets speed=3 on itself (2x faster) -> row/tick duration halves.
    // A 1-tick note delay on row 1 must therefore land 10ms after the row
    // starts (60ms row / 6 ticks), NOT 20ms (the *previous* row's 120ms/6
    // tick duration) -- that stale value is exactly what the bug produced.
    const correctDelayedTime = row1StartTime + 0.01;
    const buggyDelayedTime = row1StartTime + 0.02;

    expect(row1Delayed.time).toBeCloseTo(correctDelayedTime, 5);
    expect(row1Delayed.time).not.toBeCloseTo(buggyDelayedTime, 5);
  });
});
