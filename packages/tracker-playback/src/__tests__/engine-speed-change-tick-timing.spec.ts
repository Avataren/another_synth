import { describe, expect, it } from 'vitest';

import { PlaybackEngine } from '../engine';
import type { Song, EffectCommand, ScheduledNoteEvent } from '../types';

/**
 * Regression coverage for tracker timing on a row that changes speed
 * (F01-F1F), found via sound.mod (a real Amiga MOD file with shuffle/groove
 * patterns that alternate speed every row, e.g. F05/F06).
 *
 * Two separate, compounding bugs were found here:
 *
 * 1. TimingSystem kept "speed" (which drives row duration) and
 *    "ticksPerRow" (which drives per-tick effect update counts and tick
 *    duration) as two independent fields, with ticksPerRow frozen at its
 *    constructor default (6) forever -- Fxx speed commands only ever
 *    called setSpeed(), never touching ticksPerRow. In real ProTracker/
 *    FT2, "speed" *is* ticks-per-row -- the same parameter. The result:
 *    getTickDuration() (row duration / ticksPerRow) scaled *with* speed
 *    instead of staying constant (real tick duration depends only on BPM,
 *    2500/BPM ms, never on speed), and every per-tick effect loop ran a
 *    fixed 5 update steps per row regardless of the actual speed instead
 *    of (speed - 1) steps. Fixed by keeping ticksPerRow permanently
 *    synced to speed in TimingSystem.setSpeed().
 *
 * 2. scheduleRow() used to capture msPerRow/msPerTick/secPerRow/secPerTick
 *    *before* applying that row's own F-command to TimingSystem, so a row
 *    that both changes speed and needs its own row-duration-derived
 *    timing (e.g. how long until the next row starts) used the *previous*
 *    row's speed instead of its own. Fixed by computing those values
 *    after the first pass that applies F-commands.
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
                speedCommand: 3, // F03: fewer/shorter ticks than the default speed 6
              },
              { row: 2, instrumentId: '01', midi: 74 },
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

describe('PlaybackEngine tick/row timing on a row that changes speed', () => {
  it('schedules a same-row note-delay using the constant (BPM-only) tick duration', () => {
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
    // Tick duration is 2500/bpm = 20ms, constant regardless of speed (real
    // ProTracker semantics) -- a 1-tick note delay lands 20ms after the
    // row starts no matter what speed that row set.
    const correctDelayedTime = row1StartTime + 0.02;
    expect(row1Delayed.time).toBeCloseTo(correctDelayedTime, 5);
  });

  it('advances to the next row using that row\'s own new speed, not the previous row\'s', () => {
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
    const row2On = events.find((e) => e.type === 'noteOn' && e.row === 2);
    expect(row0On).toBeDefined();
    expect(row2On).toBeDefined();
    if (!row0On || !row2On) return;

    // Row 0 at default speed 6, bpm 125: row duration = 120ms.
    const row1StartTime = row0On.time + 0.12;
    // Row 1 sets speed=3 on itself: row duration = 3 ticks * 20ms = 60ms.
    // Using the *previous* row's speed (6) would instead produce 120ms.
    const correctRow2Time = row1StartTime + 0.06;
    const staleSpeedRow2Time = row1StartTime + 0.12;
    expect(row2On.time).toBeCloseTo(correctRow2Time, 5);
    expect(row2On.time).not.toBeCloseTo(staleSpeedRow2Time, 5);
  });
});
