import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import {
  PlaybackEngine,
  buildPlaybackSong,
} from '@another-synth/tracker-playback';
import type { PlaybackClock, Song } from '@another-synth/tracker-playback';
import { importS3mToTrackerSong } from 'src/audio/tracker/s3m-import';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { useTrackerStore } from 'src/stores/tracker-store';
import type AudioSystem from 'src/audio/AudioSystem';

/**
 * turbulence.s3m order 37 (pattern 24), channel 6 -- reported by Morten
 * (2026-09-08) as "this note ends on wrong pitch after a pitch slide".
 *
 * The row sequence on that channel:
 *   r26  G-4 (plain note, instrument 10)
 *   r27  G-6 + E50  -- retrigger, then portamento down
 *   r28  G-4 + G50  -- tone portamento back down to G-4
 *   r29  H85         -- vibrato starts
 *   r30  H00         -- vibrato continues
 *   r31  H00         -- vibrato continues
 *   r32..r43         -- empty; the note rings on
 *   r44  H85         -- vibrato again
 *
 * ST3's replayer (st3play `digcmd.c` `docmd1`, the `ch->cmd == 0` arm):
 *
 *   // fix speed if tone port noncomplete
 *   if (ch->aspd != ch->aorgspd) { ch->aspd = ch->aorgspd; setspd(ch); }
 *
 * `s_vibrato` only ever writes `ch->aspd = ch->aorgspd + offset` and never
 * touches `ch->aorgspd`, so the first effectless row after the vibrato stops
 * (r32) snaps the channel period back to the note. The engine used to hold
 * the last vibrato deviation frozen for the ~1.45 s the note rings (r32-r43):
 * it froze at ~812.73 Hz where the note is G-4 = 784.93 Hz, i.e. +60 cents
 * sharp against the other channels the whole time.
 *
 * This exercises the real load path -- importer -> tracker store ->
 * TrackerSongBank -> buildPlaybackSong -> PlaybackEngine -- and pins the held
 * pitch in cents against the note it should rest on.
 */

const DEMOS = path.resolve(__dirname, '../../public/demos');

const createMockAudioSystem = () => {
  const gainNode = { gain: { value: 1 }, connect: () => {}, numberOfOutputs: 1 };
  return {
    audioContext: {
      sampleRate: 48000,
      currentTime: 0,
      state: 'running' as const,
      createGain: () => ({ ...gainNode }),
      destination: gainNode,
      onstatechange: null as unknown,
    },
    destinationNode: { connect: () => {}, numberOfOutputs: 1 },
  };
};

function loadTurbulence(): Song {
  const buf = fs.readFileSync(path.join(DEMOS, 's3m/turbulence.s3m'));
  const bytes = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
  const file = importS3mToTrackerSong(bytes);

  setActivePinia(createPinia());
  const store = useTrackerStore();
  store.loadSongFile(file);

  const bank = new TrackerSongBank(
    createMockAudioSystem() as unknown as AudioSystem,
  );
  bank.setModuleFormat(
    store.moduleFormat,
    store.linearFrequency,
    store.amigaLimits,
  );

  return buildPlaybackSong(
    {
      currentSong: { ...store.currentSong },
      moduleFormat: store.moduleFormat,
      initialSpeed: store.initialSpeed,
      linearFrequency: store.linearFrequency,
      amigaLimits: store.amigaLimits,
      initialGlobalVolume: store.initialGlobalVolume,
      vblankTiming: store.vblankTiming,
      patterns: store.patterns,
      sequence: store.sequence,
      currentPatternId: store.currentPatternId,
      currentPattern: store.currentPattern,
      defaultPatternRows: store.defaultPatternRows,
      normalizeInstrumentId: (id: string | undefined) => (id ? id : undefined),
    },
    'song',
  );
}

class ManualClock implements PlaybackClock {
  now = 0;
  private tick: ((deltaMs: number) => void) | null = null;
  start(tick: (deltaMs: number) => void) {
    this.tick = tick;
  }
  stop() {
    this.tick = null;
  }
  setVisible() {}
  get running() {
    return this.tick !== null;
  }
  advance(seconds: number) {
    const end = this.now + seconds;
    while (this.tick !== null && this.now < end) {
      this.now += 0.1;
      this.tick(100);
    }
  }
}

const TRACK = 6;

describe('turbulence.s3m -- pitch slide then held note (order 37, channel 6)', () => {
  it('the note rests on G-4 after the vibrato, not on the frozen vibrato peak', async () => {
    const song = loadTurbulence();
    const clock = new ManualClock();
    const audioContext = {
      get currentTime() {
        return clock.now;
      },
    };

    const notes: { time: number; freq: number }[] = [];
    const pitches: { time: number; freq: number }[] = [];
    const rowMarks: { seq: number; row: number; time: number }[] = [];

    const engine = new PlaybackEngine({
      audioContext: audioContext as unknown as AudioContext,
      playbackClock: clock,
      scheduledNoteHandler: (e) => {
        if (e.trackIndex === TRACK && e.type === 'noteOn' && e.frequency) {
          notes.push({ time: e.time, freq: e.frequency });
        }
      },
      scheduledPitchHandler: (_id, _v, frequency, time, trackIndex) => {
        if (trackIndex === TRACK) pitches.push({ time, freq: frequency });
      },
      scheduledVolumeHandler: () => {},
      scheduledPanHandler: () => {},
      scheduledMacroHandler: () => {},
      scheduledEnvelopePositionHandler: () => {},
      scheduledSampleOffsetHandler: () => {},
      scheduledRetriggerHandler: () => {},
      scheduledGlobalVolumeHandler: () => {},
      scheduledFilterHandler: () => {},
      scheduledAllNotesOffHandler: () => {},
    });

    // Tag every scheduled row with its sequence position so the assertions
    // anchor to order 37 exactly (pattern 24 is played only once, there)
    // instead of guessing from wall-clock time.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const anyEngine = engine as any;
    expect(typeof anyEngine.scheduleRow).toBe('function');
    const origScheduleRow = anyEngine.scheduleRow.bind(anyEngine);
    anyEngine.scheduleRow = (row: number, t: number) => {
      rowMarks.push({ seq: anyEngine.currentSequenceIndex, row, time: t });
      return origScheduleRow(row, t);
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    engine.loadSong(song);
    engine.setLoopSong(false);
    await engine.play();
    // Order 37 lands around 278 s of song time; run well past it.
    clock.advance(300);
    engine.stop();

    const rowTime = (seq: number, row: number) =>
      rowMarks.find((m) => m.seq === seq && m.row === row)?.time;
    const r26 = rowTime(37, 26);
    const r27 = rowTime(37, 27);
    const r48 = rowTime(37, 48);
    expect(r26, 'order 37 row 26 scheduled').toBeDefined();
    expect(r27, 'order 37 row 27 scheduled').toBeDefined();
    expect(r48, 'order 37 row 48 scheduled').toBeDefined();

    // The plain G-4 on channel 6 at order 37 row 26 -- the note the slide
    // returns to.
    const g4 = notes.find(
      (n) =>
        n.time >= r26! - 1e-6 &&
        n.time < r27! &&
        n.freq > 700 &&
        n.freq < 900,
    );
    expect(g4, 'G-4 reference note on channel 6 at order 37 row 26').toBeDefined();
    const target = g4!.freq;

    // Every channel-6 pitch event from the G-6 retrigger (row 27) up to the
    // next note-on on the channel (row 48).
    const window = pitches
      .filter((p) => p.time >= r27! - 1e-6 && p.time < r48! - 1e-6)
      .sort((a, b) => a.time - b.time);
    expect(window.length).toBeGreaterThan(5);

    // The held note is the long stretch with no pitch activity between the
    // first vibrato burst (r29-r31) and its return (r44). Find the widest gap.
    let gapStart = window[0]!;
    let gapWidth = 0;
    for (let i = 1; i < window.length; i++) {
      const w = window[i]!.time - window[i - 1]!.time;
      if (w > gapWidth) {
        gapWidth = w;
        gapStart = window[i - 1]!;
      }
    }
    // r32..r43 is ~1.45 s; a frozen-then-resumed vibrato leaves exactly this
    // silence, so the gap is real either way -- it is the pitch at its start
    // that the bug got wrong.
    expect(gapWidth).toBeGreaterThan(1.0);

    const heldCents = 1200 * Math.log2(gapStart.freq / target);
    // Old code froze the note at the vibrato's last peak, ~+60 cents sharp.
    // ST3 snaps it back to the note (0 cents). Allow a couple of cents for
    // the last pre-gap event being a vibrato tick a hair off centre.
    expect(
      Math.abs(heldCents),
      `held note ${gapStart.freq.toFixed(2)} Hz is ${heldCents.toFixed(
        1,
      )} cents from G-4 (${target.toFixed(2)} Hz)`,
    ).toBeLessThan(5);
  }, 120_000);
});
